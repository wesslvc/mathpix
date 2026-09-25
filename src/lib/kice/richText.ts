import { circledCharsIn, circledFamily } from "../circledChars";

/**
 * 지문을 **그림이 아니라 글자로** 담는 형식.
 *
 * 지금까지 지문은 오려낸 사진 한 장이었다. 그러면 확대하면 흐려지고, 단을
 * 따라 흘릴 수도 없고, 평가원 판형의 글꼴·자간과 어긋난다. 모델이 읽어 준
 * 구조를 이 형식으로 받아 **우리가 평가원 글꼴로 조판**한다.
 *
 * **이 파일에는 네트워크 호출도 환경변수도 없다** — 화면(미리보기)과
 * 조판기(pdf)가 같은 값을 읽어야 한다(`problemBoxes.ts` 와 같은 이유).
 *
 * 모델이 주는 값은 믿지 않는다. `readRichBlocks` 가 모양을 확인하고 받는다 —
 * 이 값은 PDF 에 그대로 그려지므로 이상한 값이 섞이면 조판이 통째로 깨진다.
 */

/** 한 줄 안에서 서식이 같은 토막. */
export type RichRun = {
  t: string;
  /** 굵게(인쇄된 강조). */
  b?: boolean;
  /** 밑줄 — `밑줄 친 ㉠` 처럼 문제가 가리키는 자리라 빠뜨리면 안 된다. */
  u?: boolean;
  /**
   * 인쇄된 작은 네모 — 밑줄 대신 낱말·구절을 네모로 둘러 표시한 자리
   * (`ⓐ에 대한 설명으로` 처럼 밑줄과 같은 용도로 쓰인다). 밑줄과 똑같이
   * 문제가 가리키는 대상이라 빠뜨리면 안 된다. 예전에는 이걸 담을 자리가
   * 없어서(RichRun 에 `b`/`u` 뿐) 모델이 이걸 표현하려고 문단 하나를 통째로
   * `box` 블록(원래 조건 박스·<보기> 전용)으로 잘못 감싸는 일이 있었다.
   */
  sq?: boolean;
};

export type RichBlock =
  /** 문단. `indent` 면 첫 줄을 한 칸 들여 쓴다(국어 지문의 기본 모양). */
  | {
      kind: "para";
      runs: RichRun[];
      indent?: boolean;
      center?: boolean;
      /** 오른쪽 맞춤(작품 끝의 `- 작자 미상, 「적벽가」 -` 같은 출처 줄). */
      right?: boolean;
    }
  /** 네모 상자(조건 박스·<보기>). 단을 넘어가면 잘리고 다음 단에서 이어진다. */
  | { kind: "box"; blocks: RichBlock[] }
  /**
   * 그림. 지문 안에 그림이 있으면 sol 이 그 자리를 짚고(`id`), 우리가 잘라 낸
   * 그림(sunburst 로 다시 그린 것, 안 되면 원본)을 `src` 로 붙인다.
   * `ratio` = 높이/폭, `scale` = 단 폭 대비 그림 폭(원본 지면에서 잰 값, 0~1).
   * `src` 가 없으면 자리만 비워 둔다(옛 데이터).
   */
  | { kind: "figure"; id: string; ratio: number; src?: string; scale?: number };

/** 그림 `src` 로 받는 값 — 우리 저장소 주소나 data URL 만. */
export function isFigureSrc(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length < 6_000_000 &&
    (/^\/api\/card\/[\w./-]+$/.test(v) || /^data:image\/(png|jpeg|jpg|webp);base64,/.test(v))
  );
}

const MAX_RUNS = 400;
const MAX_BLOCKS = 300;
const MAX_DEPTH = 3;

function readRuns(raw: unknown): RichRun[] {
  if (typeof raw === "string") return raw ? [{ t: raw }] : [];
  if (!Array.isArray(raw)) return [];
  const out: RichRun[] = [];
  for (const item of raw.slice(0, MAX_RUNS)) {
    if (typeof item === "string") {
      if (item) out.push({ t: item });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const o = item as { t?: unknown; b?: unknown; u?: unknown; sq?: unknown };
    const t = typeof o.t === "string" ? o.t : "";
    if (!t) continue;
    out.push({
      t,
      ...(o.b === true ? { b: true } : {}),
      ...(o.u === true ? { u: true } : {}),
      ...(o.sq === true ? { sq: true } : {}),
    });
  }
  return out;
}

/** 서식 표시(`marks`)를 얼마나 제자리에 붙였는지. 화면에 그대로 보여 준다. */
export type MarkStats = { total: number; missed: number; missedTexts: string[] };

/**
 * `before`/`after` = 표시 **바로 바깥**의 몇 글자(표시되지 않은 것). 밑줄 길이를
 * 정확히 맞추려고 받는다(2026-09-25, 사용자 — "밑줄 길이도 정확하게"). 모델에게
 * 끝점 양옆을 한 번 더 보게 하는 효과가 있고, 우리는 그 글자로 **경계를 고정**한다 —
 * `text` 가 한두 글자 길거나 짧아도 앞뒤 글자가 맞는 자리가 있으면 그 사이만 긋는다.
 */
type Mark = { type: "b" | "u" | "sq"; text: string; nth: number; before: string; after: string };

const CONTEXT_MAX = 12;

function readMarks(raw: unknown): Mark[] {
  if (!Array.isArray(raw)) return [];
  const out: Mark[] = [];
  for (const item of raw.slice(0, MAX_RUNS)) {
    if (!item || typeof item !== "object") continue;
    const o = item as { type?: unknown; text?: unknown; nth?: unknown; before?: unknown; after?: unknown };
    const type = o.type === "b" || o.type === "u" || o.type === "sq" ? o.type : null;
    const text = typeof o.text === "string" ? o.text : "";
    if (!type || !text.trim()) continue;
    const nth = Math.floor(Number(o.nth));
    const ctx = (v: unknown) => (typeof v === "string" ? v.slice(-CONTEXT_MAX) : "");
    out.push({
      type,
      text,
      nth: Number.isFinite(nth) && nth >= 1 ? nth : 1,
      before: ctx(o.before),
      after: typeof o.after === "string" ? o.after.slice(0, CONTEXT_MAX) : "",
    });
  }
  return out;
}

/** 띄어쓰기·줄바꿈 차이를 봐 주는 정규식 조각. 비면 빈 글자. */
function loosePart(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const esc = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return esc.join("\\s*");
}

/**
 * 표시가 덮는 자리를 찾는다(UTF-16 [시작, 끝)). 앞뒤 글자가 있으면 **먼저 그것으로**
 * 경계를 고정하고(둘 다 → 앞만 → 뒤만), 안 맞으면 표시 글만으로 찾는다.
 */
function findMark(text: string, m: Mark): [number, number] | null {
  const body = loosePart(m.text);
  if (!body) return null;
  const pre = loosePart(m.before);
  const post = loosePart(m.after);
  const all = (src: string) => [...text.matchAll(new RegExp(src, "g"))];
  const pick = <T,>(list: T[]) => list[m.nth - 1] ?? list[0];

  // ① 앞 글자 + 표시 + 뒤 글자가 그대로 이어진 자리.
  if (pre && post) {
    const re = `(${pre}\\s*)(${body})(\\s*${post})`;
    const hit = pick(all(re));
    if (hit && hit.index != null) {
      const start = hit.index + hit[1].length;
      return [start, start + hit[2].length];
    }
  }

  const bodyHits = all(body);
  // ② 표시 글이 끝에서 몇 글자 어긋났는데 앞뒤 글자는 맞는 경우 — 모델이 밑줄
  // 끝점을 한두 글자 길게/짧게 적는 게 가장 흔한 실수다. 표시 글 자리 근처
  // (±SLACK)에서 앞 글자가 끝나고 뒤 글자가 시작하면 **그 사이**를 긋는다.
  if (pre && post && bodyHits.length > 0) {
    const SLACK = 4;
    const preEnds = all(pre).map((h) => (h.index ?? 0) + h[0].length);
    const postStarts = all(post).map((h) => h.index ?? 0);
    const snapped: [number, number][] = [];
    for (const h of bodyHits) {
      const s0 = h.index ?? 0;
      const e0 = s0 + h[0].length;
      const a = preEnds
        .filter((x) => Math.abs(x - s0) <= SLACK)
        .sort((x, y) => Math.abs(x - s0) - Math.abs(y - s0))[0];
      const b = postStarts
        .filter((x) => Math.abs(x - e0) <= SLACK)
        .sort((x, y) => Math.abs(x - e0) - Math.abs(y - e0))[0];
      if (a == null || b == null) continue;
      let from = a;
      let to = b;
      while (from < to && /\s/.test(text[from])) from++;
      while (to > from && /\s/.test(text[to - 1])) to--;
      if (to > from) snapped.push([from, to]);
    }
    const got = pick(snapped);
    if (got) return got;
  }

  // ③ 한쪽 글자만 맞는 자리, ④ 표시 글만.
  for (const [a, b] of [
    [pre, ""],
    ["", post],
  ] as const) {
    if (!a && !b) continue;
    const re = `(${a ? `${a}\\s*` : ""})(${body})(${b ? `\\s*${b}` : ""})`;
    const hit = pick(all(re));
    if (hit && hit.index != null) {
      const start = hit.index + hit[1].length;
      return [start, start + hit[2].length];
    }
  }
  const hit = pick(bodyHits);
  return hit && hit.index != null ? [hit.index, hit.index + hit[0].length] : null;
}

/**
 * **문단 글 + 서식 구간 → 토막**(2026-09-25, 사용자 요청 — "어느 줄 말고 어디서부터
 * 어디까지 볼드, 어디서부터 어디까지 밑줄").
 *
 * 예전에는 모델이 글을 토막(`runs`)으로 잘라 서식을 달았는데, 그러면 글자와
 * 서식이 한꺼번에 흔들렸다 — 토막을 나누다 글자를 빠뜨리거나 밑줄을 줄 통째로
 * 긋는 일이 잦았다. 이제 모델은 **글을 한 번 통째로** 적고, 서식은 "이 문단에서
 * 정확히 이 글자들(`text`), 같은 글이 여러 번이면 몇 번째(`nth`)" 로 따로 짚는다.
 * 글자 수를 세라고 하지 않는 이유: 모델은 글자 위치를 세는 데 약하고, 부분
 * 문자열은 틀려도 어디가 틀렸는지 눈에 보인다.
 *
 * 못 찾은 표시는 버리고 센다(`stats.missed`) — 엉뚱한 자리에 긋는 것보다 낫다.
 * `nth` 번째가 없으면 첫 번째에 붙인다(같은 글이 한 번뿐인데 번호만 틀린 경우).
 */
export function applyMarks(text: string, rawMarks: unknown, stats?: MarkStats): RichRun[] {
  if (!text) return [];
  const marks = readMarks(rawMarks);
  const chars = [...text];
  // 코드포인트 자리 ↔ UTF-16 자리(정규식은 UTF-16 으로 준다).
  const cpAt: number[] = [];
  let cp = 0;
  for (const ch of chars) {
    for (let k = 0; k < ch.length; k++) cpAt.push(cp);
    cp++;
  }
  cpAt.push(cp);
  const flags = chars.map(() => ({ b: false, u: false, sq: false }));

  for (const m of marks) {
    if (stats) stats.total++;
    const found = findMark(text, m);
    if (!found) {
      if (stats) {
        stats.missed++;
        if (stats.missedTexts.length < 20) stats.missedTexts.push(m.text);
      }
      continue;
    }
    const from = cpAt[found[0]];
    const to = cpAt[found[1]];
    for (let i = from; i < to; i++) flags[i][m.type] = true;
  }

  const runs: RichRun[] = [];
  let cur: RichRun | null = null;
  chars.forEach((ch, i) => {
    const f = flags[i];
    if (cur && !!cur.b === f.b && !!cur.u === f.u && !!cur.sq === f.sq) {
      cur.t += ch;
      return;
    }
    cur = {
      t: ch,
      ...(f.b ? { b: true } : {}),
      ...(f.u ? { u: true } : {}),
      ...(f.sq ? { sq: true } : {}),
    };
    runs.push(cur);
  });
  return runs;
}

/** 서식 표시 결과를 한 줄로. 표시가 하나도 없으면 빈 글자다. */
export function describeMarks(stats: MarkStats): string {
  if (stats.total === 0) return "";
  const placed = stats.total - stats.missed;
  if (stats.missed === 0) return `굵게·밑줄·네모 ${placed}곳 표시`;
  const shown = stats.missedTexts.slice(0, 3).map((t) => `"${t.slice(0, 12)}"`).join(", ");
  return `굵게·밑줄·네모 ${placed}곳 표시 · ${stats.missed}곳은 본문에서 못 찾아 뺐어요(${shown}) — 확인해 주세요`;
}

export function emptyMarkStats(): MarkStats {
  return { total: 0, missed: 0, missedTexts: [] };
}

/**
 * 모델이 준 블록 목록을 확인하고 받는다. 모양이 이상한 것은 조용히 버린다.
 *
 * 문단은 두 모양을 받는다 — 저장된 옛 모양(`runs`)과 지금 모델이 주는 모양
 * (`text` + `marks`, `applyMarks`). `stats` 를 주면 서식 표시를 몇 개 못 붙였는지 센다.
 */
export function readRichBlocks(raw: unknown, depth = 0, stats?: MarkStats): RichBlock[] {
  if (!Array.isArray(raw) || depth > MAX_DEPTH) return [];
  const out: RichBlock[] = [];
  for (const item of raw.slice(0, MAX_BLOCKS)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kind = o.kind;
    if (kind === "box") {
      const blocks = readRichBlocks(o.blocks, depth + 1, stats);
      // 빈 상자는 그리지 않는다 — 테두리만 남은 네모는 상자가 아니다
      // (조건 박스 감지에서 이미 겪은 규칙과 같다).
      if (blocks.length > 0) out.push({ kind: "box", blocks });
      continue;
    }
    if (kind === "figure") {
      const id = typeof o.id === "string" ? o.id : "";
      const ratio = Number(o.ratio);
      const scale = Number(o.scale);
      if (id) {
        out.push({
          kind: "figure",
          id,
          ratio: Number.isFinite(ratio) && ratio > 0 ? Math.min(ratio, 5) : 1,
          ...(isFigureSrc(o.src) ? { src: o.src } : {}),
          ...(Number.isFinite(scale) && scale > 0.05 && scale <= 1 ? { scale } : {}),
        });
      }
      continue;
    }
    // 나머지는 전부 문단으로 본다(kind 를 빠뜨린 응답도 받아 준다).
    const runs =
      o.runs === undefined && typeof o.text === "string" && Array.isArray(o.marks)
        ? applyMarks(o.text, o.marks, stats)
        : readRuns(o.runs ?? o.text ?? o.t);
    if (runs.length === 0) continue;
    out.push({
      kind: "para",
      runs,
      ...(o.indent === true ? { indent: true } : {}),
      ...(o.center === true ? { center: true } : {}),
      ...(o.right === true && o.center !== true ? { right: true } : {}),
    });
  }
  return out;
}

/** "[22~26] 다음 글을 읽고 물음에 답하시오." 같은 안내 줄의 머리. */
const LEAD_IN = /^\s*\[\s*\d{1,2}\s*[~∼～〜\-–—]\s*\d{1,2}\s*\]/;

/**
 * **지문 본문을 상자 하나로 감싼다**(2026-09-25, 사용자 요청 — "지문 영역 전체를
 * 하나의 박스가 감아 줘야 하고, [4~9] 물음에 답하시오 여기 말고").
 *
 * 모델에게 시키지 않고 **조판 직전에** 우리가 한다. 모델에게 "지문 전체를
 * box 로" 라고 하면 조건 박스·<보기> 와 섞여 어디까지가 테두리인지 흐려지고,
 * 예전에 "지문 전체가 box 하나"로 오는 바람에 조판이 무너진 적도 있다
 * (CLAUDE.md "아홉 번째"). 지문의 겉테두리는 늘 같은 규칙이므로 코드로 두면
 * 모델이 무엇을 주든 같은 모양이 나온다.
 *
 * - 맨 앞 문단이 안내 줄(`[N~M] …`)이면 그것만 상자 밖에 둔다.
 * - 나머지가 이미 상자 **하나**면 그대로 둔다(두 겹이 되지 않게).
 * - 안의 조건 박스·<보기> 는 그대로 안에 남는다(상자 속 상자).
 */
export function framePassage(blocks: RichBlock[]): RichBlock[] {
  if (blocks.length === 0) return blocks;
  const first = blocks[0];
  const hasLeadIn =
    first.kind === "para" && LEAD_IN.test(first.runs.map((r) => r.t).join(""));
  const head = hasLeadIn ? [first] : [];
  const body = hasLeadIn ? blocks.slice(1) : blocks;
  if (body.length === 0) return blocks;
  if (body.length === 1 && body[0].kind === "box") return blocks;
  return [...head, { kind: "box", blocks: body }];
}

/** 조판된 글자를 다시 평범한 글로. 제목 짓기·검색에 쓴다. */
export function richToPlainText(blocks: RichBlock[]): string {
  const out: string[] = [];
  const walk = (list: RichBlock[]) => {
    for (const b of list) {
      if (b.kind === "para") out.push(b.runs.map((r) => r.t).join(""));
      else if (b.kind === "box") walk(b.blocks);
    }
  };
  walk(blocks);
  return out.join("\n");
}

/**
 * terra 가 적어 놓은 원문자를 **Mathpix 참고 글 기준으로 갈아 끼운다.**
 *
 * **왜 프롬프트로 안 되나.** "원문자는 참고 글을 따르라"고 적어 두는 것은
 * 부탁일 뿐이다. ㉠ 은 작은 동그라미 안의 획 하나라 사진을 눈으로 읽는 쪽이
 * 가장 불리한 글자인데, 프롬프트를 아무리 강하게 적어도 모델이 사진 쪽 읽기로
 * 덮어쓰는 일이 남는다. 사용자가 "원문자는 무조건 매쓰픽스 우선으로" 라고
 * 한 것을 **코드로 강제**하는 자리다.
 *
 * **계열 안에서만 맞춘다.** 한 지문에 계열이 섞여 나온다 — 지문 표시는 ㉠㉡㉢,
 * 선지는 ①②③, 표 항목은 ⓐⓑⓒ 하는 식이다. 한 줄로 늘어놓고 맞추면 계열을
 * 넘나들며 짝지어져 **멀쩡한 글자를 망친다**: 참고 글이 `㉠㉡㉢①`, terra 가
 * `㉠㉡①②` 이면 총 개수가 4로 같아 아래 개수 검사를 통과해 버리고,
 * `㉡㉢①㉠` 이 되어 **선지 표시 ② 가 ㉠ 으로 바뀐다**(사용자 지적으로
 * 발견해 실제로 재현했다). 계열별로 갈라 맞추면 이 사고가 없다.
 *
 * **어떻게 맞추나.** 원문자를 낱개로 짝짓지 않는다 — 같은 ㉠ 이 본문에 여러 번
 * 나오기 때문이다. 대신 계열마다 **서로 다른 원문자의 집합**을 코드포인트
 * 차례로 늘어놓고 i번째끼리 짝짓는다. terra 가 흔히 내는 오류가 **한 칸씩
 * 밀리는 것**(㉠㉡㉢ → ㉡㉢㉣)이라 이 방식이면 통째로 바로잡힌다.
 *
 * **개수가 다른 계열은 손대지 않는다.** 짝지을 근거가 없는데 억지로 맞추면
 * 멀쩡한 글자까지 틀리게 만든다 — 못 고치는 쪽이 안전하다(놓친 것은 그대로
 * 남을 뿐, 잘못 바꾸면 문제가 성립하지 않는다). 그 계열만 건너뛰고 나머지는
 * 그대로 고치며, 건너뛴 게 있으면 `matched: false` 로 알린다.
 */
export function alignCircledToReference(
  blocks: RichBlock[],
  reference: string,
): { blocks: RichBlock[]; replaced: number; matched: boolean } {
  const byFamily = (chars: string[]) => {
    const out = new Map<string, string[]>();
    for (const ch of chars) {
      const fam = circledFamily(ch);
      if (!fam) continue;
      const list = out.get(fam);
      if (list) list.push(ch);
      else out.set(fam, [ch]);
    }
    return out;
  };

  const want = byFamily(circledCharsIn(reference));
  if (want.size === 0) return { blocks, replaced: 0, matched: true };
  const got = byFamily(circledCharsIn(richToPlainText(blocks)));

  const map = new Map<string, string>();
  let skipped = false;
  for (const [fam, mine] of got) {
    const theirs = want.get(fam);
    // 참고 글에 아예 없는 계열은 고칠 근거가 없다 — 그대로 둔다.
    if (!theirs) continue;
    if (theirs.length !== mine.length) {
      skipped = true;
      continue;
    }
    for (let i = 0; i < mine.length; i++) {
      if (mine[i] !== theirs[i]) map.set(mine[i], theirs[i]);
    }
  }
  if (map.size === 0) return { blocks, replaced: 0, matched: !skipped };

  let replaced = 0;
  const fixRun = (r: RichRun): RichRun => ({
    ...r,
    t: [...r.t]
      .map((ch) => {
        const to = map.get(ch);
        if (to === undefined) return ch;
        replaced += 1;
        return to;
      })
      .join(""),
  });
  const walk = (list: RichBlock[]): RichBlock[] =>
    list.map((b) => {
      if (b.kind === "para") return { ...b, runs: b.runs.map(fixRun) };
      if (b.kind === "box") return { ...b, blocks: walk(b.blocks) };
      return b;
    });

  return { blocks: walk(blocks), replaced, matched: !skipped };
}
