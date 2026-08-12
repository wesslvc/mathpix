// rhwp 가 그린 **빈 틀** SVG 에서 도형·글자를 그대로 뽑아 JSON 으로 만든다.
//
// 왜 이렇게 하나: 평가원 문제지의 제목 표·성명칸·둥근 교시 상자·쪽번호 사선
// 상자는 눈대중으로 다시 그릴 수 있는 물건이 아니다. 원본이 조판해 둔 좌표를
// 그대로 옮겨 적으면 한 픽셀도 어긋나지 않는다. 이 추출은 **한 번만** 돌리고
// 결과 JSON 을 저장소에 넣는다(런타임에는 rhwp 가 필요 없다).
//
// 단위: SVG 는 96dpi px, PDF 는 pt. pt = px * 0.75.

import fs from "node:fs";

const PX_TO_PT = 0.75;

/** `transform="translate(x,y) scale(sx,sy)"` 를 읽는다. */
function readTransform(attrs) {
  const t = attrs.match(/translate\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/);
  const s = attrs.match(/scale\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/);
  return {
    x: t ? +t[1] : 0,
    y: t ? +t[2] : 0,
    sx: s ? +s[1] : 1,
    sy: s ? +s[2] : 1,
  };
}

const attr = (a, name, dflt = 0) => {
  const m = a.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return m ? (isNaN(+m[1]) ? m[1] : +m[1]) : dflt;
};

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, "&");
}

export function extractFrame(svgPath) {
  const svg = fs.readFileSync(svgPath, "utf8");
  const head = svg.slice(0, svg.indexOf(">") + 1);
  const width = attr(head, "width") * PX_TO_PT;
  const height = attr(head, "height") * PX_TO_PT;

  // **문서 순서대로 훑어야 한다.** 원본은 세로 구분선을 먼저 긋고 그 위에
  // 제목 영역을 흰색으로 덮어 윗부분을 가린다. 종류별로 몰아서 뽑으면 그
  // 순서가 뒤집혀 선이 덮개 위로 올라온다(표지 센터라인이 위까지 길어졌다).
  const items = [];
  const TAGS = /<(rect|line|circle|text)\s([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
  let m;
  while ((m = TAGS.exec(svg))) {
    const kind = m[1];
    const a = m[2];

    if (kind === "rect") {
      const w = attr(a, "width");
      const h = attr(a, "height");
      const fill = String(attr(a, "fill", "none"));
      const stroke = String(attr(a, "stroke", "none"));
      // 종이 전체를 덮는 흰 바탕은 우리가 따로 칠하므로 버린다.
      if (fill === "#ffffff" && w > 1000) continue;
      if (fill === "none" && stroke === "none") continue;
      items.push({
        k: "rect",
        x: attr(a, "x") * PX_TO_PT,
        y: attr(a, "y") * PX_TO_PT,
        w: w * PX_TO_PT,
        h: h * PX_TO_PT,
        fill: fill === "none" ? null : fill,
        stroke: stroke === "none" ? null : stroke,
        sw: (attr(a, "stroke-width", 0) || 0) * PX_TO_PT,
        rx: (attr(a, "rx", 0) || 0) * PX_TO_PT,
      });
      continue;
    }

    if (kind === "line") {
      items.push({
        k: "line",
        x1: attr(a, "x1") * PX_TO_PT,
        y1: attr(a, "y1") * PX_TO_PT,
        x2: attr(a, "x2") * PX_TO_PT,
        y2: attr(a, "y2") * PX_TO_PT,
        stroke: String(attr(a, "stroke", "#000000")),
        sw: (attr(a, "stroke-width", 1) || 1) * PX_TO_PT,
        dash: String(attr(a, "stroke-dasharray", "")) || null,
      });
      continue;
    }

    if (kind === "circle") {
      // 가운뎃점(·) 같은 작은 점이 여기로 온다. 빠뜨리면 `(사회·문화)` 의 점이 사라진다.
      items.push({
        k: "circle",
        cx: attr(a, "cx") * PX_TO_PT,
        cy: attr(a, "cy") * PX_TO_PT,
        r: attr(a, "r") * PX_TO_PT,
        fill: String(attr(a, "fill", "#000000")),
      });
      continue;
    }

    const text = unescapeXml((m[3] ?? "").replace(/<[^>]*>/g, ""));
    if (!text) continue;
    // 원본이 안 보이게 그려 둔 글자(투명)는 그대로 버린다.
    if (+attr(a, "fill-opacity", 1) === 0) continue;
    // 자리는 transform 으로 오기도 하고 x/y 속성으로 오기도 한다.
    const t = /translate\(/.test(a)
      ? readTransform(a)
      : { x: attr(a, "x"), y: attr(a, "y"), sx: 1, sy: 1 };
    items.push({
      k: "text",
      x: t.x * PX_TO_PT,
      y: t.y * PX_TO_PT,
      // 장평(가로 눌림). 평가원 제목은 85~90% 로 눌려 있다.
      sx: t.sx,
      size: attr(a, "font-size") * PX_TO_PT,
      // 폴백 목록 중 첫 번째가 문서가 지정한 글꼴이다.
      font: a.match(/font-family="&apos;([^&]*)&apos;/)?.[1] ?? "",
      fill: String(attr(a, "fill", "#000000")),
      // 원본이 정해 둔 글자 폭. 이 값에 맞춰 늘리고 줄이면 원본과 같아진다.
      len: attr(a, "textLength", 0) * PX_TO_PT || null,
      t: text,
    });
  }

  return { width, height, items };
}

if (process.argv[2]) {
  const frame = extractFrame(process.argv[2]);
  const counts = frame.items.reduce((acc, i) => ((acc[i.k] = (acc[i.k] ?? 0) + 1), acc), {});
  console.error(
    `${process.argv[2]}: ${frame.width.toFixed(1)}×${frame.height.toFixed(1)}pt  ${JSON.stringify(counts)}`,
  );
  fs.writeFileSync(process.argv[3], JSON.stringify(frame));
}
