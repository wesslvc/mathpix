// 영어 문제지 틀을 **수학 틀에서 만든다.**
//
// 사용법: node scripts/kice/make-english-frame.mjs
//         (public/kice/frames.json 을 그 자리에서 고친다)
//
// 국어 틀과 **똑같은 방법**이다(`make-korean-frame.mjs` 주석 참고) — 원본
// hwpx 가 없어 rhwp 로 뽑을 수 없고, 판형·단 구성이 수학과 같으므로 영역명만
// 갈아끼운다. 신그래픽체로 그려진 '수'→'영', '학'→'어' 로 바꾸면 머리말이
// "수 학 영 역" → "영 어 영 역" 이 된다(뒤의 '영'·'역' 은 표에 없으므로
// 그대로 지나간다).
//
// **교시 딱지는 그대로 둔다(period-math.png = 제2교시).** 영어는 제3교시라
// 표지가 틀리지만, 실제 문제지에서 오려낸 제3교시 그림이 없다. 글꼴로 다시
// 그리면 모서리 둥근 정도·글자 사이가 어긋난다(CLAUDE.md 참고). 그래서
// **영어는 문제지 내보내기에 넣지 않고**(`KICE_AREAS` 에 없다) 정답표
// 생성기에서만 쓴다 — 정답표는 본문 쪽 틀(even/odd)에 그려지고 그 쪽에는
// 교시 딱지가 아예 없다.
//
// 제3교시 딱지를 구하면 이 스크립트에 period-english.png 로 갈아끼우는 줄을
// 더하고 `KICE_AREAS` 에 "영어" 를 넣으면 문제지 내보내기도 열린다.

import fs from "node:fs";

const PATH = "public/kice/frames.json";

/** 영역명은 `신그래픽체` 로 그려진 글자만 바꾼다(표지 큰 제목의 '수학'은 (환)디나루다). */
const AREA_FONT = "신그래픽체";
const SWAP = { 수: "영", 학: "어" };

const frames = JSON.parse(fs.readFileSync(PATH, "utf8"));
if (!frames.math) throw new Error("frames.json 에 math 틀이 없습니다.");

const english = structuredClone(frames.math);
const changed = [];

for (const [key, frame] of Object.entries(english)) {
  for (const it of frame.items) {
    if (it.k === "text" && it.font === AREA_FONT && SWAP[it.t]) {
      changed.push(`${key}: "${it.t}" → "${SWAP[it.t]}" (${it.size}pt, x=${it.x.toFixed(2)})`);
      it.t = SWAP[it.t];
    }
  }
}

frames.english = english;
fs.writeFileSync(PATH, JSON.stringify(frames, null, 0));

for (const c of changed) console.log(" ", c);
console.log("\n최상위 키:", Object.keys(frames).join(", "));
for (const k of ["first", "even", "odd"]) {
  const text = frames.english[k].items.filter((i) => i.k === "text").map((i) => i.t).join("");
  console.log(`  english.${k}: ${JSON.stringify(text)}`);
}
