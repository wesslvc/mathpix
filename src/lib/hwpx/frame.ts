import JSZip from "jszip";
import { replaceLogicalText, setParagraphContent, setParagraphText } from "./text";

/**
 * 평가원 문제지 틀(hwpx)에 오답 이미지를 붙여 새 hwpx 를 만든다.
 *
 * 왜 hwpx 인가: 수능 문제지는 한컴 전용 글꼴(신명 견명조·중고딕, 한양 계열 …)로
 * 짜여 있다. 이 글꼴들은 HFT 라 웹에 심을 수도, 서버에 담아 배포할 수도 없다.
 * 그래서 **글자를 우리가 그리지 않는다** — 원본 문제지의 틀을 그대로 두고
 * 제목만 갈아끼운 뒤, 오답은 이미지로 얹는다. PDF 로 뽑는 마지막 한 걸음만
 * 한글에서 하면 글꼴이 한 자도 어긋나지 않는다.
 *
 * 틀 파일은 `scripts/build-kice-frames.mjs` 가 실제 문제지에서 문항을 걷어내고
 * 만든 것이다(public/kice/*.hwpx).
 */

/** hwpx 의 길이 단위. 1 HWPUNIT = 1/7200 인치 = 1/100 pt. */
const HWPUNIT_PER_PX = 7200 / 96; // 화면 픽셀(96dpi) → HWPUNIT

/** 한 단에 들어갈 그림의 최대 높이. 너무 크면 혼자 한 쪽을 다 먹는다. */
const MAX_FIGURE_HEIGHT_RATIO = 0.82;

export type KiceArea = "사회탐구" | "과학탐구" | "수학";

export type KiceProblem = {
  /** 문제 위에 적을 줄(예: "강대2회 22번"). 비우면 줄을 만들지 않는다. */
  label: string;
  /** 문제 카드 PNG. */
  png: Uint8Array;
  widthPx: number;
  heightPx: number;
};

export type KiceFrameSpec = {
  /** 첫 쪽 제목(예: "2026학년도 6월 모의평가 문제지"). */
  title: string;
  area: KiceArea;
  /** 괄호 안 과목명(예: "생활과 윤리"). 수학 틀에서는 쓰지 않는다. */
  subject?: string;
  problems: KiceProblem[];
  /** 정답표. 비어 있으면 정답 쪽을 만들지 않는다. */
  answers?: { label: string; answer: string }[];
  /**
   * 바탕쪽 구석에 찍힌 **전체 쪽수**. 원본 문제지의 값(예: 32)이 그대로
   * 남아 있어서, 넘겨주면 그 숫자로 바꾼다. 넘기지 않으면 손대지 않는다.
   */
  totalPages?: number;
};

type FrameTemplate = {
  zip: JSZip;
  section: string;
  blankParagraph: string;
  textParagraph: string;
  picture: string;
  layout: { pageWidth: number; pageHeight: number; columnWidth: number; colCount: number };
  /** 원본 제목/과목 표기. 이 글자를 찾아 바꾼다. */
  original: { title: string; area: string; subject: string; totalPages: string };
};

/** 틀 파일마다 원본에 적혀 있는 글자. 이걸 찾아 사용자 입력으로 바꾼다. */
const ORIGINAL: Record<"tamgu" | "math", FrameTemplate["original"]> = {
  tamgu: {
    title: "2025학년도 대학수학능력시험 문제지",
    area: "사회탐구",
    subject: "사회·문화",
    totalPages: "32",
  },
  math: {
    title: "2025학년도 대학수학능력시험 문제지",
    area: "수학",
    subject: "",
    totalPages: "20",
  },
};

export function frameFileFor(area: KiceArea): "tamgu" | "math" {
  return area === "수학" ? "math" : "tamgu";
}

async function loadTemplate(bytes: ArrayBuffer, kind: "tamgu" | "math"): Promise<FrameTemplate> {
  const zip = await JSZip.loadAsync(bytes);
  const read = async (name: string) => {
    const file = zip.file(name);
    if (!file) throw new Error(`틀 파일이 손상되었습니다 (${name} 없음).`);
    return file.async("string");
  };
  return {
    zip,
    section: await read("Contents/section0.xml"),
    blankParagraph: await read("ReprintOCR/blank-paragraph.xml"),
    textParagraph: await read("ReprintOCR/text-paragraph.xml"),
    picture: await read("ReprintOCR/picture.xml"),
    layout: JSON.parse(await read("ReprintOCR/layout.json")),
    original: ORIGINAL[kind],
  };
}

/**
 * 그림 하나를 단 폭에 맞춰 놓는 `<hp:pic>` 마크업과, 그 그림이 차지하는
 * 높이(HWPUNIT). 높이는 문단의 줄 높이를 정하는 데 쓴다 — 아래
 * `paragraphMaker` 설명 참고.
 */
function buildPicture(
  template: string,
  binaryId: string,
  widthPx: number,
  heightPx: number,
  layout: FrameTemplate["layout"],
  serial: number,
): { markup: string; height: number } {
  if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx <= 0 || heightPx <= 0) {
    // 크기를 모르면 그림을 못 앉힌다. 조용히 NaN 을 흘려보내면 한글이 파일을
    // 열지 못하는데, 그때는 원인을 찾기가 아주 어렵다.
    throw new Error("문제 이미지의 크기를 알 수 없습니다.");
  }
  const orgW = Math.max(1, Math.round(widthPx * HWPUNIT_PER_PX));
  const orgH = Math.max(1, Math.round(heightPx * HWPUNIT_PER_PX));
  const maxH = Math.round(layout.pageHeight * MAX_FIGURE_HEIGHT_RATIO);
  const scale = Math.min(layout.columnWidth / orgW, maxH / orgH, 1);
  const curW = Math.max(1, Math.round(orgW * scale));
  const curH = Math.max(1, Math.round(orgH * scale));

  const attr = (xml: string, tag: string, values: Record<string, number | string>) =>
    xml.replace(new RegExp(`<${tag}(\\s[^>]*?)?(/?)>`), (all, rest: string, slash: string) => {
      let out = rest ?? "";
      for (const [k, v] of Object.entries(values)) {
        out = new RegExp(`\\s${k}="[^"]*"`).test(out)
          ? out.replace(new RegExp(`\\s${k}="[^"]*"`), ` ${k}="${v}"`)
          : `${out} ${k}="${v}"`;
      }
      return `<${tag}${out}${slash}>`;
    });

  let pic = template;
  // 문서 안에서 겹치지 않는 번호. 겹치면 한글이 같은 개체로 본다.
  pic = attr(pic, "hp:pic", {
    id: 2000000000 + serial,
    zOrder: serial,
    instid: 2100000000 + serial,
  });
  pic = attr(pic, "hp:offset", { x: 0, y: 0 });
  pic = attr(pic, "hp:orgSz", { width: orgW, height: orgH });
  pic = attr(pic, "hp:curSz", { width: curW, height: curH });
  pic = attr(pic, "hp:rotationInfo", {
    angle: 0,
    centerX: Math.round(curW / 2),
    centerY: Math.round(curH / 2),
  });
  pic = attr(pic, "hp:imgClip", { left: 0, right: orgW, top: 0, bottom: orgH });
  pic = attr(pic, "hp:imgDim", { dimwidth: orgW, dimheight: orgH });
  pic = attr(pic, "hc:img", { binaryItemIDRef: binaryId });
  pic = attr(pic, "hp:sz", { width: curW, height: curH });
  pic = attr(pic, "hp:inMargin", { left: 0, right: 0, top: 0, bottom: 0 });
  pic = attr(pic, "hp:outMargin", { left: 0, right: 0, top: 0, bottom: 0 });
  // 그림틀 네 꼭짓점. 원본 크기 기준이다.
  pic = pic.replace(
    /<hp:imgRect>[\s\S]*?<\/hp:imgRect>/,
    `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${orgW}" y="0"/>` +
      `<hc:pt2 x="${orgW}" y="${orgH}"/><hc:pt3 x="0" y="${orgH}"/></hp:imgRect>`,
  );
  // 변환 행렬은 항등으로 되돌린다. 본보기의 값을 그대로 두면 원본 그림에
  // 맞춰 놓은 확대·이동이 우리 그림에도 걸린다.
  pic = pic.replace(
    /<hp:renderingInfo>[\s\S]*?<\/hp:renderingInfo>/,
    "<hp:renderingInfo>" +
      '<hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>' +
      '<hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>' +
      '<hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>' +
      "</hp:renderingInfo>",
  );
  return { markup: pic, height: curH };
}

/**
 * 우리가 붙일 문단을 찍어내는 틀.
 *
 * **문제 본문 문단을 그대로 쓰면 안 된다.** 원본에서 떠 온 그 문단에는 문항
 * 번호 매기기와 배분 정렬이 걸려 있어서, 글자를 갈아끼우면 앞에 "4." 가 붙고
 * 글자가 단 폭에 맞춰 쫙 벌어진다(실제로 그렇게 찍혔다). 그래서 서식이 없는
 * 빈 문단을 뼈대로 쓰고, **글자 모양만** 본문 문단에서 가져온다 — 그래야
 * 수능 문제지와 같은 글꼴·크기로 찍히면서 번호나 정렬은 따라오지 않는다.
 */
function paragraphMaker(t: FrameTemplate) {
  const charPrIDRef = t.textParagraph.match(/<hp:run\s[^>]*charPrIDRef="(\d+)"/)?.[1] ?? "0";
  const blank = t.blankParagraph.replace(/\spageBreak="1"/, ' pageBreak="0"');

  /**
   * `<hp:linesegarray>` 는 원본을 열었을 때 계산해 둔 **줄 배치 캐시**다. 빈
   * 문단에서 떠 왔으니 "이 줄은 11.5pt 높이"라고 적혀 있고, 그대로 두면 우리가
   * 넣은 큰 그림이 줄 높이를 밀어내지 못해 위쪽 라벨을 덮는다. 그래서 지운다 —
   * 한글은 문서를 열 때 배치를 새로 계산한다.
   *
   * **직접 계산해 넣으려고 하지 말 것.** 한 번 시도했다가 더 나빠졌다.
   * `vertpos` 는 문단이 놓일 세로 위치까지 담고 있어서, 값을 채우려면 앞 문단들의
   * 높이와 단 넘김을 전부 알아야 한다 — 조판기를 다시 만드는 일이다.
   */
  const withRun = (markup: string) =>
    blank
      .replace(
        /<hp:run\b[^>]*\/>|<hp:run\b[^>]*>[\s\S]*?<\/hp:run>/,
        `<hp:run charPrIDRef="${charPrIDRef}">${markup}</hp:run>`,
      )
      .replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, "");

  return {
    blank: () => blank,
    text: (value: string) => setParagraphText(withRun("<hp:t></hp:t>"), value),
    picture: (markup: string) => setParagraphContent(withRun("<hp:t></hp:t>"), markup),
  };
}

/** `<opf:spine>` 앞에 그림 항목을 끼워 넣는다. */
function addBinaryItems(hpf: string, items: { id: string; href: string }[]): string {
  const markup = items
    .map(
      (it) =>
        `<opf:item id="${it.id}" href="${it.href}" media-type="image/png" isEmbeded="1"/>`,
    )
    .join("");
  if (hpf.includes("</opf:manifest>")) return hpf.replace("</opf:manifest>", markup + "</opf:manifest>");
  return hpf.replace("<opf:spine>", markup + "<opf:spine>");
}

export async function buildKiceHwpx(
  templateBytes: ArrayBuffer,
  spec: KiceFrameSpec,
): Promise<Blob> {
  const kind = frameFileFor(spec.area);
  const t = await loadTemplate(templateBytes, kind);

  // ── 제목·과목 갈아끼우기 ──────────────────────────────────────────────
  let section = t.section;
  if (spec.title.trim()) section = replaceLogicalText(section, t.original.title, spec.title.trim());
  if (kind === "tamgu") {
    if (spec.area !== "수학") section = replaceLogicalText(section, t.original.area, spec.area);
    const subject = spec.subject?.trim();
    if (subject) section = replaceLogicalText(section, t.original.subject, subject);
  }

  // ── 오답 이미지 ───────────────────────────────────────────────────────
  const zip = t.zip;
  const binaries: { id: string; href: string }[] = [];
  const paragraph = paragraphMaker(t);
  let body = "";
  spec.problems.forEach((problem, i) => {
    const id = `reprint${i + 1}`;
    const href = `BinData/${id}.png`;
    zip.file(href, problem.png);
    binaries.push({ id, href });

    const pic = buildPicture(t.picture, id, problem.widthPx, problem.heightPx, t.layout, i + 1);
    if (problem.label.trim()) body += paragraph.text(problem.label.trim());
    body += paragraph.picture(pic.markup);
    // 문제 사이 한 줄 띄우기. 쪽 나눔은 걸지 않는다(단을 따라 흐르게 둔다).
    body += paragraph.blank();
  });

  // ── 정답표 ────────────────────────────────────────────────────────────
  const answers = (spec.answers ?? []).filter((a) => a.answer.trim() !== "");
  if (answers.length > 0) {
    body += t.blankParagraph; // pageBreak="1" — 새 쪽에서 시작한다
    body += paragraph.text("정답");
    for (const row of answers) {
      body += paragraph.text(`${row.label}  ${row.answer}`);
    }
  }

  section = section.replace(/<\/hs:sec>\s*$/, body + "</hs:sec>");

  if (spec.totalPages && t.original.totalPages) {
    for (const name of ["Contents/masterpage0.xml", "Contents/masterpage1.xml", "Contents/masterpage2.xml", "Contents/masterpage3.xml"]) {
      const file = zip.file(name);
      if (!file) continue;
      const xml = await file.async("string");
      zip.file(name, replaceLogicalText(xml, t.original.totalPages, String(spec.totalPages)));
    }
  }

  zip.file("Contents/section0.xml", section);
  const hpf = await zip.file("Contents/content.hpf")!.async("string");
  zip.file("Contents/content.hpf", addBinaryItems(hpf, binaries));

  // 우리 본보기 조각은 결과물에서 빼 둔다(한글은 무시하지만 군더더기다).
  for (const name of Object.keys(zip.files)) {
    if (name.startsWith("ReprintOCR/")) zip.remove(name);
  }

  // mimetype 은 반드시 첫 항목이고 무압축이어야 한다(OPC 규칙). JSZip 은
  // 넣은 순서대로 쓰므로, 원본에서 꺼내 새 zip 에 가장 먼저 담는다.
  const mimetype = await zip.file("mimetype")!.async("string");
  const out = new JSZip();
  out.file("mimetype", mimetype, { compression: "STORE" });
  for (const name of Object.keys(zip.files)) {
    if (name === "mimetype" || zip.files[name].dir) continue;
    out.file(name, await zip.file(name)!.async("uint8array"));
  }
  return out.generateAsync({
    type: "blob",
    mimeType: "application/hwp+zip",
    compression: "DEFLATE",
  });
}
