// 국어 문제지 틀을 **수학 틀에서 만든다.**
//
// 사용법: node scripts/kice/make-korean-frame.mjs
//         (public/kice/frames.json 을 그 자리에서 고친다)
//
// **왜 원본에서 안 뽑았나**: 다른 틀은 실제 hwpx 원본을 rhwp 로 SVG 로 뽑아
// 만들었다(`scripts/kice/build-frames.mjs`). 국어 문제지 hwpx 원본이 없어서
// 그 길을 쓸 수 없었다. 다행히 수학과 국어는 **판형·단 구성이 같고**, 다른
// 것은 두 가지뿐이다:
//   ① 영역명 "수학 영역" → "국어 영역"
//   ② 교시 딱지 "제 2 교시" → "제 1 교시"
// 그래서 수학 틀을 그대로 복사해 이 둘만 갈아끼운다.
//
// **한계**: 수학 표지에는 성명·수험번호 칸이 없는데(원본을 확인해 그게 맞다고
// 결론 냈다), 국어 표지도 그대로 없게 된다. 국어 원본을 구하면 build-frames
// 로 다시 뽑을 것.
//
// **교시 딱지(public/kice/period-korean.png)는 이 스크립트가 만들지 않는다.**
// 실제 문제지에서 오려낸 그림이라 사람이 준비해야 한다(글꼴로 다시 그리면
// 모서리 둥근 정도·글자 사이가 어긋난다 — CLAUDE.md 참고). 준비할 때는
// **period-math.png 와 같은 캔버스 크기로, 내용(타원)이 같은 자리·같은
// 크기에 오도록** 맞춰야 한다. 그래야 frames.json 의 같은 배치 상자
// (90.7 × 31.18)에 넣었을 때 제2교시가 있던 자리에 정확히 겹친다.
//   1) period-math.png 에서 흰 배경이 아닌 부분의 경계 상자를 구한다.
//   2) 새 딱지 그림도 같은 방법으로 잘라낸다.
//   3) period-math.png 와 같은 크기의 흰 캔버스를 만들고, ①의 자리에
//      ②를 ①의 크기로 줄여 붙인다.
// (embedPng 만 쓰므로 **PNG 여야 한다** — jpg 를 넣으면 그림이 안 뜬다.)

import fs from "node:fs";

const PATH = "public/kice/frames.json";

/**
 * 영역명은 `신그래픽체` 로 그려진 글자만 갈아끼운다.
 *
 * **글자만 보고 바꾸면 안 된다** — 표지의 "2025학년도 대학수학능력시험
 * 문제지"에도 '수'와 '학'이 들어 있다(그쪽은 `(환)디나루`다). 글꼴로 걸러야
 * 표지 큰 제목(41pt)과 머리말(28.3pt)만 정확히 바뀐다.
 */
const AREA_FONT = "신그래픽체";
const SWAP = { 수: "국", 학: "어" };

const frames = JSON.parse(fs.readFileSync(PATH, "utf8"));
if (!frames.math) throw new Error("frames.json 에 math 틀이 없습니다.");

const korean = structuredClone(frames.math);
const changed = [];

for (const [key, frame] of Object.entries(korean)) {
  for (const it of frame.items) {
    if (it.k === "text" && it.font === AREA_FONT && SWAP[it.t]) {
      changed.push(`${key}: "${it.t}" → "${SWAP[it.t]}" (${it.size}pt, x=${it.x.toFixed(2)})`);
      it.t = SWAP[it.t];
    }
    if (it.k === "image" && it.file === "period-math.png") {
      it.file = "period-korean.png";
      changed.push(`${key}: 교시 딱지 → period-korean.png`);
    }
  }
}

frames.korean = korean;
fs.writeFileSync(PATH, JSON.stringify(frames, null, 0));

for (const c of changed) console.log(" ", c);
console.log("\n최상위 키:", Object.keys(frames).join(", "));
for (const k of ["first", "even", "odd"]) {
  const text = frames.korean[k].items.filter((i) => i.k === "text").map((i) => i.t).join("");
  console.log(`  korean.${k}: ${JSON.stringify(text)}`);
}
