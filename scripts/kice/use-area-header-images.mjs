// 국어·영어 머리말("국어 영역" / "영어 영역")을 **글꼴 대신 그림으로** 그린다.
//
// 사용법: node scripts/kice/use-area-header-images.mjs
//         (public/kice/frames.json 을 그 자리에서 고친다. 한 번 돌리고 커밋한다.)
//
// **왜 그림인가**: 버킷의 글꼴은 미리 잘라 둔 것(pyftsubset)이라 모든 한글이
// 들어 있지 않다. 신그래픽체에 '국' 은 과목명 "한국지리" 때문에 들어 있었지만
// **'어' 는 이 앱 어디에도 쓰이지 않아 빠져 있었고**, 그래서 국어 머리말이
// `국⊠ 영역` 으로 나왔다. 글꼴에 없는 글자는 코드에서 아무리 정확히 적어도
// 그릴 그림이 없어 못 그린다.
//
// 다른 글꼴로 대신 그리면 그 한 글자만 서체가 달라진다. 실제 문제지에서
// 오려 온 그림을 쓰면 **서체가 100% 같다** — 제 N 교시 딱지와 같은 방식이다.
//
// **글자 넷을 따로 오려 두었다**(`area-guk/eo/yeong/yeok.png`). 한 덩어리로
// 두지 않은 이유는 **영어를 같은 재료로 만들기 위해서**다 — "영어 영역" 은
// 영·어·영·역이라 "국어 영역" 에 있는 글자만으로 조립된다.
//
// **자리는 원본이 잡아 둔 것을 그대로 쓴다.** 글자마다 x 가 이미 틀에 있으므로
// 그 자리에 앉히되, 글자가 제 칸의 어디쯤에 놓이는지(사이드베어링)는 오려 온
// 그림에서 잰다 — 칸 한가운데에 놓는 것으로 갈음하면 '어' 가 1.2pt 오른쪽으로
// 밀린다(ㅓ 의 가로획 때문에 잉크가 왼쪽으로 치우친 글자다).

import fs from "node:fs";

const PATH = "public/kice/frames.json";

/**
 * 오려 온 원본에서 잰 글자 넷의 잉크 상자(px).
 *
 * 원본: 실제 문제지의 "국어 영역" 머리말(1348×406). 브라우저 캔버스로 어두운
 * 픽셀의 경계를 잡아 글자마다 따로 PNG 로 뽑았다. 이 표는 **그 원본에서의
 * 자리**라 배율·사이드베어링을 되짚는 데 쓴다(파일 자체는 잘려 있다).
 */
const GLYPHS = {
  국: { file: "area-guk.png", x: 37, y: 50, w: 281, h: 288 },
  어: { file: "area-eo.png", x: 355, y: 42, w: 258, h: 295 },
  영: { file: "area-yeong.png", x: 762, y: 42, w: 260, h: 302 },
  역: { file: "area-yeok.png", x: 1053, y: 42, w: 257, h: 296 },
};

/** 원본에서 글자가 앉은 줄(px). '국'·'역' 의 잉크 아래 끝이 여기서 만난다. */
const BASELINE_PX = 337;

/** 원본 글자 차례 — 틀의 글자 자리 넷과 하나씩 짝이 된다. */
const SOURCE = ["국", "어", "영", "역"];

/** 어느 틀에 무엇을 그릴지. 영어는 같은 재료로 조립된다. */
const TARGET = {
  korean: ["국", "어", "영", "역"],
  english: ["영", "어", "영", "역"],
};

const frames = JSON.parse(fs.readFileSync(PATH, "utf8"));
let touched = 0;

for (const [key, letters] of Object.entries(TARGET)) {
  const set = frames[key];
  if (!set) throw new Error(`frames.json 에 ${key} 틀이 없습니다.`);

  for (const [name, frame] of Object.entries(set)) {
    // 머리말 글자 넷을 찾는다. 같은 줄·같은 크기·신그래픽체인 글자 묶음 중
    // 넷짜리가 그것이다(표지의 큰 쪽번호도 신그래픽체지만 혼자 있는 줄이다).
    const cand = frame.items
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => it.k === "text" && it.font === "신그래픽체" && !it.role);
    const groups = [];
    for (const c of cand) {
      const g = groups.find(
        (g) => Math.abs(g.y - c.it.y) < 1.2 && Math.abs(g.size - c.it.size) < 0.01,
      );
      if (g) g.list.push(c);
      else groups.push({ y: c.it.y, size: c.it.size, list: [c] });
    }
    const group = groups.find((g) => g.list.length === 4);
    if (!group) {
      console.log(`  - ${key}.${name}: 글자 넷을 못 찾았습니다(이미 그림으로 바뀐 듯).`);
      continue;
    }

    const slots = group.list.sort((a, b) => a.it.x - b.it.x);
    const pen = slots.map((s) => s.it.x);
    const baseline = slots[0].it.y;

    // ── 배율: 첫 글자와 마지막 글자의 잉크 왼쪽 끝 사이 거리로 잰다.
    // 둘 다 받침이 있는 넓은 글자라 사이드베어링이 거의 같아 상쇄된다.
    const src = SOURCE.map((L) => GLYPHS[L]);
    const a = (src[3].x - src[0].x) / (pen[3] - pen[0]);

    // ── 가로 자리: 글자 넷의 잉크 전체를 **글자 칸 전체의 한가운데**에 놓는다.
    // 칸 하나의 너비는 글자 사이 간격(원본이 잡아 둔 것)으로 본다.
    const advance = pen[1] - pen[0];
    const inkSpan = (src[3].x + src[3].w - src[0].x) / a;
    const boxWidth = pen[3] + advance - pen[0];
    const inkLeft0 = pen[0] + (boxWidth - inkSpan) / 2;

    // 글자마다 제 칸에서 얼마나 안쪽에 놓이는지(사이드베어링)를 되짚는다.
    // 이걸 알면 **다른 글자를 그 자리에 놓을 때도** 같은 규칙으로 앉힐 수 있다.
    const bearing = {};
    src.forEach((g, i) => {
      bearing[SOURCE[i]] = inkLeft0 + (g.x - src[0].x) / a - pen[i];
    });

    const drawn = letters.map((L, i) => {
      const g = GLYPHS[L];
      const w = g.w / a;
      const h = g.h / a;
      // 세로: 원본에서 잰 줄(baseline)에 맞춘다. '영' 의 ㅇ 처럼 둥근 글자가
      // 줄 아래로 조금 삐져나오는 것(오버슛)까지 그대로 살린다.
      const bottom = baseline + (g.y + g.h - BASELINE_PX) / a;
      return {
        k: "image",
        file: g.file,
        x: +(pen[i] + bearing[L]).toFixed(2),
        y: +(bottom - h).toFixed(2),
        w: +w.toFixed(2),
        h: +h.toFixed(2),
      };
    });

    // 글자가 있던 자리에 그대로 끼운다 — **그리는 차례가 곧 겹치는 차례**라
    // 맨 뒤로 보내면 흰 덮개 위에 얹히는 것들과 순서가 뒤바뀐다.
    const at = slots[0].i;
    const remove = new Set(slots.map((s) => s.i));
    frame.items = [
      ...frame.items.filter((_, i) => !remove.has(i) && i < at),
      ...drawn,
      ...frame.items.filter((_, i) => !remove.has(i) && i > at),
    ];
    touched += 1;
    console.log(
      `  ✓ ${key}.${name}: ${letters.join("")} — ${drawn[0].x}~` +
        `${(drawn[3].x + drawn[3].w).toFixed(2)}pt, 높이 ${drawn[0].h}pt (배율 ${a.toFixed(3)}px/pt)`,
    );
  }
}

fs.writeFileSync(PATH, JSON.stringify(frames, null, 0));
console.log(`\n${touched}개 틀을 고쳤습니다.`);
