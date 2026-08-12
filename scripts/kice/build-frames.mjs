// 첫 쪽 / 홀수 쪽 / 짝수 쪽 틀 세 벌을 만들어 `public/kice/frames.json` 에 넣는다.
//
// 셋 다 **문항을 걷어낸 빈 틀**에서 뽑는다. 원본 문제지의 2·3쪽에서 본문만
// 걸러 내는 방법도 해 봤는데, 수식이 중첩 좌표라 걸러지지 않고 새어 나왔다.
// 빈 틀에 빈 쪽을 붙여 조판시키면 애초에 본문이 없다.
//
// 만드는 순서(전부 한 번만 하고 결과를 커밋한다):
//   ① `node scripts/build-kice-frames.mjs <탐구 원본.hwpx> <수학 원본.hwpx>`
//      → public/kice/{tamgu,math}.hwpx (문항을 걷어낸 빈 틀)
//   ② 그 틀에 빈 쪽 둘을 덧붙여 3쪽짜리로 만든 뒤 rhwp 로 SVG 를 뽑는다.
//      `rhwp export-svg <파일> --font-path <글꼴 폴더>`
//   ③ 이 스크립트: `node scripts/kice/build-frames.mjs <탐구 SVG 폴더> <수학 SVG 폴더>`
//
// rhwp: https://github.com/edwardkim/rhwp (MIT). 한컴 글꼴을 담지 않으므로
// 뽑힌 SVG 의 **글꼴 이름만** 믿고 모양은 우리가 심은 TTF 로 그린다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { extractFrame } from "./extract-frame.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const [tamguDir = "sv-t3", mathDir = "sv-m3"] = process.argv.slice(2);
/** 쪽번호 폭을 재는 데만 쓴다(글꼴 파일은 저작권 때문에 저장소에 없다). */
const FONT =
  process.env.KICE_SINGRAPHIC ?? path.join(ROOT, "..", "kice-fonts", "singraphic.ttf");

// 쪽번호를 줄이면 오른쪽 끝이 딸려 들어오므로, 얼마나 좁아지는지 알려면
// 글꼴 폭을 실제로 재야 한다.
const require = createRequire(path.join(ROOT, "package.json"));
const { PDFDocument } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");
const measureDoc = await PDFDocument.create();
measureDoc.registerFontkit(fontkit);
const SINGRAPHIC = await measureDoc.embedFont(fs.readFileSync(FONT), { subset: false });

/** 폴더에서 쪽 번호 순으로 SVG 세 장을 찾는다(rhwp 가 `..._001.svg` 로 뽑는다). */
function pages(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".svg")).sort();
  if (files.length < 3) throw new Error(`${dir}: SVG 세 장이 필요합니다(${files.length}장 있음)`);
  const [first, even, odd] = files.map((f) => extractFrame(path.join(dir, f)));
  return { first, even, odd };
}

const out = { tamgu: pages(tamguDir), math: pages(mathDir) };

// 첫 쪽의 `5지선다형` 딱지와 그 상자를 지운다(오답 프린트에는 쓸모가 없다).
out.math.first.drop = [{ x0: 45, y0: 172, x1: 175, y1: 212 }];

/**
 * `제 N 교시` 딱지는 **실제 문제지에서 오려낸 그림**으로 덮는다.
 *
 * 글꼴로 다시 그려서는 인쇄물과 똑같이 맞추기 어려웠다 — 상자 모서리의
 * 둥근 정도, 글자 사이, 숫자 크기가 조금씩 어긋났고 고칠 때마다 다른 데가
 * 틀어졌다. 이 딱지는 과목이 달라도 숫자 하나만 바뀌는 고정 표시라, 원본을
 * 그대로 얹는 편이 정확하고 단순하다.
 */
function setPeriodImage(frame, file) {
  const box = frame.items.find((i) => i.k === "rect" && i.rx > 0);
  if (!box) throw new Error("교시 상자를 찾지 못했습니다");
  const glyphs = frame.items.filter(
    (i) =>
      i.k === "text" &&
      i.x >= box.x - 2 &&
      i.x <= box.x + box.w &&
      i.y > box.y &&
      i.y < box.y + box.h + 12,
  );
  const at = frame.items.indexOf(box);
  frame.items = frame.items.filter((i) => i !== box && !glyphs.includes(i));
  frame.items.splice(at, 0, { k: "image", file, x: box.x, y: box.y, w: box.w, h: box.h });
}
/**
 * 원본이 도형으로 그려 둔 가운뎃점(·)을 지운다.
 *
 * `(사회·문화)` 의 점인데 글자가 아니라 작은 원으로 따로 그려져 있다. 과목명을
 * 통째로 갈아끼우므로 그 점만 남아 새 과목명 한복판에 떠 있게 된다.
 */
for (const f of Object.values(out.tamgu)) {
  f.items = f.items.filter((i) => i.k !== "circle");
}

/**
 * 쪽번호를 옆 글자와 같은 글꼴로 바꾼다.
 *
 * 원본은 쪽번호만 견명조(굵은 명조)로 찍어서 옆의 영역명·과목명과 견주면
 * 혼자 볼드처럼 도드라진다.
 */
function normalizePageNumbers(frame) {
  for (const i of frame.items) {
    if (i.k === "text" && i.size > 30 && i.font === "(환)견명조") i.font = "신그래픽체";
  }
}

/**
 * 짝수 쪽 쪽번호가 종이 왼쪽 끝(x≈0)에 박혀 있는 것을 여백 안으로 들인다.
 * 수학 문제지는 머리말을 탭으로 밀어 놓아서 rhwp 가 x=0 으로 뽑아 준다.
 */
function fixPageNumberX(frame, x) {
  for (const i of frame.items) {
    if (i.k === "text" && i.size > 30 && i.x < 10) i.x = x;
  }
}

for (const subject of Object.values(out)) {
  for (const f of Object.values(subject)) normalizePageNumbers(f);
}
fixPageNumberX(out.math.even, 58.1);

/**
 * 표지의 머리말 가로줄을 위로 올린다.
 *
 * 실제 시험지를 재보니 성명 칸 아래선과 가로줄 사이가 **9pt** 인데 우리 원본
 * 파일은 53pt 로 벌어져 있었다(그만큼 첫 쪽 본문이 늦게 시작한다).
 * 가로줄만 옮기면 안 되고, 그 위를 덮는 **흰 덮개**도 같이 줄여야 한다 —
 * 안 그러면 덮개가 가로줄 아래 본문까지 가린다.
 */
function raiseCoverRule(frame, gapBelowBoxes) {
  const rule = frame.items.find(
    (i) => i.k === "line" && Math.abs(i.y1 - i.y2) < 0.5 && Math.abs(i.x2 - i.x1) > 600,
  );
  const cover = frame.items.find((i) => i.k === "rect" && i.fill === "#ffffff");
  if (!rule || !cover) return;
  // 성명·수험번호 칸의 아래선
  const boxBottom = Math.max(
    ...frame.items
      .filter((i) => i.k === "line" && Math.abs(i.y1 - i.y2) < 0.5 && i.y1 < rule.y1 - 1)
      .map((i) => i.y1),
  );
  const y = boxBottom + gapBelowBoxes;
  rule.y1 = rule.y2 = y;
  cover.h = y - cover.y;
}
raiseCoverRule(out.tamgu.first, 9);

/**
 * 머리말 쪽의 세로 구분선이 **머리말 글자를 관통하지 않게** 가로줄 아래에서
 * 시작하도록 맞춘다. 수학 문제지는 구분선이 종이 위쪽(42pt)부터 그어져 있어
 * `수학 영역` 한가운데를 세로로 갈랐다.
 */
function clipDividerBelowRule(frame) {
  const rule = frame.items.find(
    (i) => i.k === "line" && Math.abs(i.y1 - i.y2) < 0.5 && Math.abs(i.x2 - i.x1) > 400,
  );
  if (!rule) return;
  for (const i of frame.items) {
    if (i.k !== "line" || Math.abs(i.x1 - i.x2) > 0.5) continue;
    if (Math.abs(i.y2 - i.y1) < 300) continue;
    const top = Math.min(i.y1, i.y2);
    const bottom = Math.max(i.y1, i.y2);
    if (top < rule.y1) {
      i.y1 = rule.y1;
      i.y2 = bottom;
    }
  }
}

/** 홀수 쪽 쪽번호가 오른쪽 여백 밖으로 나가지 않게 들인다. */
function fitPageNumberRight(frame, x) {
  for (const i of frame.items) {
    if (i.k === "text" && i.size > 30 && i.x > 720) i.x = x;
  }
}

/**
 * 머리말 조각들의 **베이스라인을 맞춘다.**
 *
 * 원본은 영역명·쪽번호·과목명이 4~5pt 씩 어긋난 줄에 얹혀 있어 나란히 놓고 보면
 * 삐뚤어 보인다. 가장 많은 글자가 놓인 줄(=영역명)에 나머지를 맞춘다.
 * 가로줄과의 간격은 원본 그대로 둔다 — 자리만 맞추는 것이지 벌리는 게 아니다.
 */
function alignHeaderBaseline(frame) {
  const rule = frame.items.find(
    (i) => i.k === "line" && Math.abs(i.y1 - i.y2) < 0.5 && Math.abs(i.x2 - i.x1) > 400,
  );
  if (!rule) return;
  const head = frame.items.filter((i) => i.k === "text" && i.y < rule.y1);
  if (head.length < 2) return;
  const tally = new Map();
  for (const i of head) {
    const key = i.y.toFixed(1);
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  const main = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
  for (const i of head) i.y = Number(main);
}

/**
 * 쪽번호를 **영역명과 같은 크기로** 맞춘다.
 *
 * 원본은 쪽번호만 33pt 라 영역명(27~28.3pt)보다 눈에 띄게 크다. 글꼴을 이미
 * 같은 것으로 맞춰 놓았으니 크기까지 같아야 한 줄로 읽힌다.
 *
 * 줄이면 글자가 좁아지므로 **오른쪽 끝에 붙은 쪽번호는 그만큼 밀어 준다** —
 * 안 그러면 애써 맞춰 둔 오른쪽 여백선에서 3pt 쯤 안으로 들어가 버린다.
 * 왼쪽에 붙은 짝수 쪽 번호는 시작점이 기준이라 그대로 둔다.
 */
function matchPageNumberSize(frame) {
  const nums = frame.items.filter((i) => i.k === "text" && i.size > 30);
  if (!nums.length) return;
  const body = frame.items.filter((i) => i.k === "text" && i.size <= 30 && i.t.trim());
  if (!body.length) return;
  // 머리말에서 가장 많은 글자가 놓인 크기(=영역명)에 맞춘다.
  const tally = new Map();
  for (const i of body) tally.set(i.size, (tally.get(i.size) ?? 0) + 1);
  // 글자 수가 같으면 큰 쪽(영역명)을 고른다 — 과목명은 영역명보다 늘 작다.
  const size = [...tally.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  for (const i of nums) {
    const ratio = size / i.size;
    if (i.x > frame.width / 2) {
      const width = SINGRAPHIC.widthOfTextAtSize(i.t, i.size) * (i.sx ?? 1);
      i.x += width * (1 - ratio);
    }
    i.size = size;
    // **영역명과 한 덩어리로 묶이면 안 된다.** 묶는 기준이 (같은 줄·같은 크기·
    // 같은 글꼴)인데 이제 셋이 전부 같아져서, 그냥 두면 줄 글자가
    // `2사회탐구영역` 이 되어 갈아끼우기(`replace`)가 통째로 빗나간다 —
    // 실제로 머리말 영역명이 바뀌지 않고 원본 그대로 찍혔다.
    i.standalone = true;
  }
}

for (const subject of Object.values(out)) {
  for (const [kind, f] of Object.entries(subject)) {
    if (kind === "first") continue;
    clipDividerBelowRule(f);
    fitPageNumberRight(f, 699.1);
    alignHeaderBaseline(f);
    // 크기를 바꾸면 위쪽 함수들의 `size > 30` 판정이 더 이상 안 걸리므로 맨 나중에.
    matchPageNumberSize(f);
  }
}


/** 종이 아래쪽 **사선 쪽번호 상자**를 이루는 항목들의 색인. */
function bottomBoxIndices(frame) {
  const at = [];
  frame.items.forEach((i, n) => {
    const top = i.k === "text" ? i.y : i.k === "line" ? Math.min(i.y1, i.y2) : null;
    if (top !== null && top > 1000) at.push(n);
  });
  return at;
}

/**
 * 수학 문제지의 쪽번호 상자를 **탐구 것과 같은 모양으로** 바꾼다.
 *
 * 같은 판형인데도 두 원본의 상자가 조금씩 다르다 — 수학 쪽이 테두리가 굵고
 * (0.5625pt 대 0.375pt) 숫자가 상자 안쪽으로 더 들어와 있어 나란히 놓으면
 * 다른 문서처럼 보인다. 모양은 탐구 것을 그대로 쓰되 **높이는 원래 자리를
 * 지킨다** — 두 문제지는 본문이 끝나는 높이가 달라서(수학이 더 짧다) 상자만
 * 내리면 본문과의 간격이 어색해진다.
 */
function copyBottomBox(src, dst) {
  const si = bottomBoxIndices(src);
  const di = new Set(bottomBoxIndices(dst));
  const boxTop = (frame, at) =>
    Math.min(...[...at].map((n) => frame.items[n]).filter((i) => i.k === "line").map((i) => Math.min(i.y1, i.y2)));
  const dy = boxTop(dst, di) - boxTop(src, si);
  const copied = si.map((n) => {
    const i = structuredClone(src.items[n]);
    if (i.k === "line") {
      i.y1 += dy;
      i.y2 += dy;
    } else {
      i.y += dy;
    }
    return i;
  });
  const at = Math.min(...di);
  dst.items = dst.items.filter((_, n) => !di.has(n));
  dst.items.splice(at, 0, ...copied);
}
for (const kind of ["first", "even", "odd"]) copyBottomBox(out.tamgu[kind], out.math[kind]);

/**
 * 쪽번호가 들어갈 자리에 **표를 붙인다.**
 *
 * 값이 쪽마다 달라지므로 글자로 짝지어 갈아끼울 수 없다(2쪽의 `2` 와 전체
 * 쪽수 `32` 를 글자로 구분하려 들면 쪽수가 늘어나는 순간 어긋난다).
 * `role` 을 보고 그리는 쪽에서 실제 값을 넣는다.
 *
 * `alignRight` 는 **자릿수가 늘어나도 오른쪽 끝이 그대로**여야 하는 자리다 —
 * 홀수 쪽 머리말 번호(여백선에 붙는다)와 상자 안 전체 쪽수(사선 오른쪽 아래).
 */
function tagPageNumbers(frame, hasHeader) {
  if (hasHeader) {
    for (const i of frame.items) {
      if (i.k !== "text" || i.y > 200 || !/^\d+$/.test(i.t)) continue;
      i.role = "pageNo";
      if (i.x > frame.width / 2) {
        i.alignRight = i.x + SINGRAPHIC.widthOfTextAtSize(i.t, i.size) * (i.sx ?? 1);
      }
    }
  }
  const box = bottomBoxIndices(frame)
    .map((n) => frame.items[n])
    .filter((i) => i.k === "text");
  if (!box.length) return;
  const left = box.reduce((a, b) => (a.x <= b.x ? a : b));
  const total = box.filter((i) => i !== left);
  left.role = "pageNo";
  for (const i of total) i.role = "pageTotal";
  // 전체 쪽수는 여러 자리라 조각으로 흩어져 있다. 가장 오른쪽 조각의 끝이 기준.
  const last = total.reduce((a, b) => (a.x >= b.x ? a : b), total[0]);
  if (last) for (const i of total) i.alignRight = last.x + (last.len ?? last.size * (last.sx ?? 1));
}
for (const subject of Object.values(out)) {
  for (const [kind, f] of Object.entries(subject)) tagPageNumbers(f, kind !== "first");
}

setPeriodImage(out.tamgu.first, "period-tamgu.png");
setPeriodImage(out.math.first, "period-math.png");

/**
 * `제 [ ] 선택` 상자를 옆 `수험 번호` 칸에 맞춰 내린다.
 *
 * 원본이 2.8pt 위로 올라가 있어 나란한 세 칸의 윗선이 어긋나 보인다.
 */
function alignSelectBox(frame) {
  const rowTop = Math.min(
    ...frame.items
      .filter((i) => i.k === "line" && Math.abs(i.y1 - i.y2) < 0.5 && i.x1 > 100 && i.x1 < 300)
      .map((i) => i.y1),
  );
  const inSelect = (x, y) => x >= 520 && x <= 625 && y >= 150 && y <= 190;
  const target = frame.items.filter((i) => {
    if (i.k === "line") return inSelect(i.x1, i.y1) && inSelect(i.x2, i.y2);
    if (i.k === "text") return inSelect(i.x, i.y);
    return false;
  });
  if (!target.length) return;
  const top = Math.min(
    ...target.filter((i) => i.k === "line").map((i) => Math.min(i.y1, i.y2)),
  );
  const dy = rowTop - top;
  for (const i of target) {
    if (i.k === "line") {
      i.y1 += dy;
      i.y2 += dy;
    } else {
      i.y += dy;
    }
  }
}
alignSelectBox(out.tamgu.first);

fs.writeFileSync(path.join(ROOT, "public/kice/frames.json"), JSON.stringify(out));
for (const [subject, set] of Object.entries(out)) {
  for (const [kind, f] of Object.entries(set)) {
    const c = f.items.reduce((a, i) => ((a[i.k] = (a[i.k] ?? 0) + 1), a), {});
    const txt = f.items.filter((i) => i.k === "text").map((i) => i.t).join("").replace(/\s+/g, " ");
    console.log(`${subject}/${kind}: ${JSON.stringify(c)}  «${txt.slice(0, 70)}»`);
  }
}
