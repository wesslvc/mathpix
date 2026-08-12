// 실제 수능 문제지(hwpx)에서 **문제 내용을 전부 걷어내고 틀만** 남긴다.
//
// 왜 스크립트로 한 번만 돌리고 결과를 저장소에 넣는가:
//   ① 원본 hwpx 에는 실제 수능 문항이 들어 있다. 그대로 커밋하면 저작물을
//      통째로 배포하는 셈이다. 걷어낸 뒤에는 판형·서식·머리말만 남는다.
//   ② 걷어내기는 파일마다 손으로 확인해야 하는 작업이라 런타임에 할 일이 아니다.
//      런타임에는 **제목/과목명만 바꿔치기**한다(src/lib/hwpx/frame.ts).
//
// 사용법:
//   node scripts/build-kice-frames.mjs <탐구 원본.hwpx> <수학 원본.hwpx>
//
// 결과: public/kice/tamgu.hwpx, public/kice/math.hwpx
//
// 남기는 것: 용지/여백/단 설정(secPr, colPr), 머리말·꼬리말, 제목 표
//   (○○학년도 … 문제지 / 영역명 / 교시 / 성명·수험번호 칸), 바탕쪽(쪽번호)
// 버리는 것: 첫 문단에 딸린 문제 본문, 두 번째 문단부터 끝까지, section1,
//   BinData(문항 그림), 미리보기 텍스트

import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { topLevelElements, childElements } from "../src/lib/hwpx/xml.ts";

const [, , tamguSrc, mathSrc] = process.argv;
if (!tamguSrc || !mathSrc) {
  console.error("사용법: node scripts/build-kice-frames.mjs <탐구.hwpx> <수학.hwpx>");
  process.exit(1);
}

const OUT_DIR = path.join(process.cwd(), "public", "kice");

/**
 * 구역 어디에 있든 머리말·꼬리말 정의를 그러모은다.
 *
 * 이게 필요한 이유: 머리말이 **첫 문단에 있으리라는 보장이 없다.** 수학
 * 문제지는 머리말이 뒤쪽 문단에 붙어 있어서, 첫 문단만 남기고 나머지를
 * 버렸더니 2쪽부터 `수학 영역` 머리말이 통째로 사라졌다(탐구는 첫 문단에
 * 있어서 멀쩡했다 — 한 파일만 보고 넘어가면 놓친다).
 */
function collectHeaderCtrls(section, firstParagraphEnd) {
  const out = [];
  for (const [a, b] of topLevelElements(section, "hp:ctrl")) {
    if (a < firstParagraphEnd) continue; // 첫 문단 것은 이미 남아 있다
    const ctrl = section.slice(a, b);
    if (/<hp:(header|footer)\b/.test(ctrl)) out.push(ctrl);
  }
  return out;
}

/** 첫 문단에서 문제 본문(직계 hp:t / hp:equation)만 떼어낸다. */
function stripBodyFromFirstParagraph(para, extraCtrls = []) {
  const open = para.slice(0, para.indexOf(">") + 1);
  const inner = para.slice(para.indexOf(">") + 1, para.lastIndexOf("</hp:p>"));
  let out = "";
  for (const kid of childElements(inner)) {
    const chunk = inner.slice(kid.start, kid.end);
    if (kid.name !== "hp:run") {
      out += chunk;
      continue;
    }
    const runOpen = chunk.slice(0, chunk.indexOf(">") + 1);
    const runInner = chunk.slice(chunk.indexOf(">") + 1, chunk.lastIndexOf("</hp:run>"));
    const kept = childElements(runInner)
      // hp:t 와 hp:equation 이 곧 문제 본문이다. 제목은 표(hp:tbl) 안에 있어서
      // 직계 자식이 아니므로 여기에 걸리지 않는다.
      .filter((c) => c.name !== "hp:t" && c.name !== "hp:equation")
      .map((c) => runInner.slice(c.start, c.end))
      .join("");
    if (kept) out += runOpen + kept + "</hp:run>";
  }
  // 뒤쪽 문단에 있던 머리말·꼬리말을 첫 문단으로 옮겨 붙인다.
  if (extraCtrls.length) out += `<hp:run charPrIDRef="0">${extraCtrls.join("")}</hp:run>`;
  return open + out + "</hp:p>";
}

/** 쪽을 넘기기 위한 빈 문단. 원본에서 가져와 서식 참조가 어긋나지 않게 한다. */
function makeBlankParagraph(section) {
  const paras = topLevelElements(section, "hp:p");
  for (const [a, b] of paras.slice(1)) {
    const p = section.slice(a, b);
    // `<hp:line` 로만 걸면 `<hp:linesegarray>`(모든 문단에 있다)까지 잡힌다.
    if (!/<hp:t>/.test(p) && !/<hp:(tbl|pic|rect|line|equation)[\s/>]/.test(p)) {
      return p.replace(/\spageBreak="0"/, ' pageBreak="1"');
    }
  }
  throw new Error("빈 문단을 찾지 못했습니다");
}

/**
 * 글자만 든 문단 하나를 본보기로 남긴다.
 *
 * 런타임에 문단을 **새로 지어내지 않는 이유**: 문단에는 서식 참조
 * (paraPrIDRef/styleIDRef/charPrIDRef)와 줄 배치 캐시(linesegarray)가 붙어
 * 있는데, 여기 적힌 번호는 header.xml 의 목록을 가리킨다. 지어낸 번호를 쓰면
 * 한글이 열지 못하거나 엉뚱한 서식으로 그린다. 원본에서 통째로 떠 와서
 * 글자만 갈아끼우는 편이 안전하다. 게다가 이건 실제 문제 본문에 쓰이던
 * 문단이라 **수능 문제지와 같은 글꼴·크기**로 찍힌다.
 */
function findTextParagraph(section) {
  for (const [a, b] of topLevelElements(section, "hp:p")) {
    const p = section.slice(a, b);
    const inner = p.slice(p.indexOf(">") + 1, p.lastIndexOf("</hp:p>"));
    const runs = childElements(inner).filter((k) => k.name === "hp:run");
    if (runs.length !== 1) continue;
    const run = inner.slice(runs[0].start, runs[0].end);
    const runInner = run.slice(run.indexOf(">") + 1, run.lastIndexOf("</hp:run>"));
    const kids = childElements(runInner);
    // 글자 하나짜리 run 이어야 한다. 수식·표가 섞이면 갈아끼울 수 없다.
    if (kids.length !== 1 || kids[0].name !== "hp:t") continue;
    if (/<hp:/.test(runInner.slice(kids[0].start, kids[0].end).replace(/^<hp:t>|<\/hp:t>$/g, "")))
      continue;
    return p;
  }
  throw new Error("본보기로 쓸 글자 문단을 찾지 못했습니다");
}

/** 글자처럼 흐르는(treatAsChar) 그림 하나를 본보기로 남긴다. */
function findInlinePicture(section) {
  for (const [a, b] of topLevelElements(section, "hp:pic")) {
    const pic = section.slice(a, b);
    if (!/<hp:pos[^>]*treatAsChar="1"/.test(pic)) continue;
    // 도형 설명에는 원본을 만든 사람 이름이 들어 있다. 지워서 내보낸다.
    return pic.replace(/<hp:shapeComment>[\s\S]*?<\/hp:shapeComment>/g, "");
  }
  return null;
}

/** 단 하나의 폭(HWPUNIT). 여기에 맞춰 그림 크기를 정한다. */
function readLayout(section) {
  const pagePr = section.match(/<hp:pagePr\s[^>]*>/)?.[0] ?? "";
  const margin = section.match(/<hp:margin\s[^>]*\/>/)?.[0] ?? "";
  const colPr = section.match(/<hp:colPr\s[^>]*\/>/)?.[0] ?? "";
  const secPr = section.match(/<hp:secPr\s[^>]*>/)?.[0] ?? "";
  const num = (s, k) => Number(s.match(new RegExp(`${k}="(-?\\d+)"`))?.[1] ?? 0);
  const pageWidth = num(pagePr, "width");
  const left = num(margin, "left");
  const right = num(margin, "right");
  const colCount = num(colPr, "colCount") || 1;
  const gap = num(secPr, "spaceColumns");
  const textWidth = pageWidth - left - right;
  return {
    pageWidth,
    pageHeight: num(pagePr, "height"),
    textWidth,
    colCount,
    columnWidth: Math.floor((textWidth - gap * (colCount - 1)) / colCount),
  };
}

function gutSection(section) {
  const paras = topLevelElements(section, "hp:p");
  if (paras.length === 0) throw new Error("문단이 없습니다");
  const head = section.slice(0, paras[0][0]);
  const tail = section.slice(paras[paras.length - 1][1]);
  const moved = collectHeaderCtrls(section, paras[0][1]);
  let first = stripBodyFromFirstParagraph(section.slice(paras[0][0], paras[0][1]), moved);
  if (moved.length) {
    // 머리말을 첫 문단으로 끌어올리면 **첫 쪽에도 찍히기 시작한다.** 원본에서는
    // 뒤쪽 문단에 있었던 덕분에 첫 쪽에 안 나왔던 것이니, 첫 쪽 머리말을 끈다.
    first = first.replace(/hideFirstHeader="0"/, 'hideFirstHeader="1"');
  }
  return {
    // 빈 쪽은 런타임에 필요한 만큼 붙인다. 여기서는 틀 한 쪽만 남긴다.
    xml: head + first + tail,
    blankParagraph: makeBlankParagraph(section),
    textParagraph: findTextParagraph(section),
    layout: readLayout(section),
  };
}

/**
 * 문서 정보를 지운다.
 *
 * 원본에는 만든 사람 이름과 마지막으로 저장한 기기 이름이 들어 있다. 이 틀은
 * 저장소에 커밋되어 공개되므로 남겨 둘 이유가 없다.
 */
function scrubMetadata(hpf) {
  return hpf
    .replace(/<opf:title>[\s\S]*?<\/opf:title>/, "<opf:title>ReprintOCR 평가원 양식</opf:title>")
    .replace(
      /<opf:meta name="(creator|lastsaveby|subject|description)" content="text">[\s\S]*?<\/opf:meta>/g,
      (_all, name) => `<opf:meta name="${name}" content="text"/>`,
    );
}

function dropItems(hpf, ids) {
  let out = hpf;
  for (const id of ids) {
    out = out.replace(new RegExp(`<opf:item\\s[^>]*id="${id}"[^>]*/>`, "g"), "");
    out = out.replace(new RegExp(`<opf:itemref\\s[^>]*idref="${id}"[^>]*/>`, "g"), "");
  }
  return out;
}

async function build(srcPath, outName) {
  const zip = await JSZip.loadAsync(fs.readFileSync(srcPath));
  const section0 = await zip.file("Contents/section0.xml").async("string");
  const { xml, blankParagraph, textParagraph, layout } = gutSection(section0);
  // 인라인 그림 본보기는 어느 구역에 있어도 된다(서식 참조가 없다).
  let picture = findInlinePicture(section0);
  for (const name of Object.keys(zip.files)) {
    if (picture) break;
    if (/^Contents\/section\d+\.xml$/.test(name)) {
      picture = findInlinePicture(await zip.file(name).async("string"));
    }
  }
  if (!picture) throw new Error("본보기로 쓸 인라인 그림을 찾지 못했습니다");

  const out = new JSZip();
  // mimetype 은 반드시 **첫 항목**이고 **무압축**이어야 한다(OPC 규칙).
  out.file("mimetype", await zip.file("mimetype").async("string"), { compression: "STORE" });

  const dropped = [];
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir) continue;
    if (name === "mimetype") continue;
    if (name.startsWith("BinData/")) {
      dropped.push(path.basename(name).replace(/\.[^.]+$/, ""));
      continue;
    }
    if (name === "Contents/section1.xml") {
      dropped.push("section1");
      continue;
    }
    if (name === "Contents/section0.xml") {
      out.file(name, xml);
      continue;
    }
    if (name === "Contents/content.hpf") continue; // 아래에서 따로 쓴다
    if (name.startsWith("Preview/")) {
      // 미리보기에는 문제 본문이 그대로 들어 있다. 비워 둔다.
      out.file(name, "");
      continue;
    }
    out.file(name, await zip.file(name).async("uint8array"));
  }

  let hpf = await zip.file("Contents/content.hpf").async("string");
  out.file("Contents/content.hpf", scrubMetadata(dropItems(hpf, dropped)));

  let manifest = await zip.file("META-INF/manifest.xml").async("string");
  for (const id of dropped) {
    manifest = manifest.replace(
      new RegExp(`<odf:file-entry[^>]*full-path="[^"]*${id}\\.[^"]*"[^>]*/>`, "g"),
      "",
    );
  }
  manifest = manifest.replace(
    /<odf:file-entry[^>]*full-path="Contents\/section1\.xml"[^>]*\/>/g,
    "",
  );
  out.file("META-INF/manifest.xml", manifest);

  // 본보기 조각들. hwpx 규격 밖의 경로라 한글은 무시하고(manifest 에도 넣지
  // 않는다), 우리는 zip 에서 꺼내 쓴다.
  out.file("ReprintOCR/blank-paragraph.xml", blankParagraph);
  out.file("ReprintOCR/text-paragraph.xml", textParagraph);
  out.file("ReprintOCR/picture.xml", picture);
  out.file("ReprintOCR/layout.json", JSON.stringify(layout));

  const buf = await out.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dest = path.join(OUT_DIR, outName);
  fs.writeFileSync(dest, buf);
  console.log(
    `${outName}: ${(fs.statSync(srcPath).size / 1024) | 0}KB → ${(buf.length / 1024) | 0}KB` +
      `  (버린 항목 ${dropped.length}개)`,
  );
}

await build(tamguSrc, "tamgu.hwpx");
await build(mathSrc, "math.hwpx");
