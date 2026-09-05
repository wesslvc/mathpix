import { circledCharsIn } from "../circledChars";

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
  | { kind: "para"; runs: RichRun[]; indent?: boolean; center?: boolean }
  /** 네모 상자(조건 박스·<보기>). 단을 넘어가면 잘리고 다음 단에서 이어진다. */
  | { kind: "box"; blocks: RichBlock[] }
  /** 그림 자리. 지문 안에 삽화가 있을 때 그 자리를 비워 둔다. */
  | { kind: "figure"; id: string; ratio: number };

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

/** 모델이 준 블록 목록을 확인하고 받는다. 모양이 이상한 것은 조용히 버린다. */
export function readRichBlocks(raw: unknown, depth = 0): RichBlock[] {
  if (!Array.isArray(raw) || depth > MAX_DEPTH) return [];
  const out: RichBlock[] = [];
  for (const item of raw.slice(0, MAX_BLOCKS)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kind = o.kind;
    if (kind === "box") {
      const blocks = readRichBlocks(o.blocks, depth + 1);
      // 빈 상자는 그리지 않는다 — 테두리만 남은 네모는 상자가 아니다
      // (조건 박스 감지에서 이미 겪은 규칙과 같다).
      if (blocks.length > 0) out.push({ kind: "box", blocks });
      continue;
    }
    if (kind === "figure") {
      const id = typeof o.id === "string" ? o.id : "";
      const ratio = Number(o.ratio);
      if (id) {
        out.push({ kind: "figure", id, ratio: Number.isFinite(ratio) && ratio > 0 ? ratio : 1 });
      }
      continue;
    }
    // 나머지는 전부 문단으로 본다(kind 를 빠뜨린 응답도 받아 준다).
    const runs = readRuns(o.runs ?? o.text ?? o.t);
    if (runs.length === 0) continue;
    out.push({
      kind: "para",
      runs,
      ...(o.indent === true ? { indent: true } : {}),
      ...(o.center === true ? { center: true } : {}),
    });
  }
  return out;
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
 * **어떻게 맞추나.** 원문자를 낱개로 짝짓지 않는다 — 같은 ㉠ 이 본문에 여러 번
 * 나오기 때문이다. 대신 **서로 다른 원문자의 집합**을 코드포인트 차례로 늘어
 * 놓고 i번째끼리 짝짓는다. terra 가 흔히 내는 오류가 **한 칸씩 밀리는 것**
 * (㉠㉡㉢ → ㉡㉢㉣)이라 이 방식이면 통째로 바로잡힌다.
 *
 * **개수가 다르면 손대지 않는다.** 짝지을 근거가 없는데 억지로 맞추면 멀쩡한
 * 글자까지 틀리게 만든다 — 못 고치는 쪽이 안전하다(놓친 것은 그대로 남을 뿐,
 * 잘못 바꾸면 문제가 성립하지 않는다). 그때는 `matched: false` 로 알린다.
 */
export function alignCircledToReference(
  blocks: RichBlock[],
  reference: string,
): { blocks: RichBlock[]; replaced: number; matched: boolean } {
  const want = circledCharsIn(reference);
  if (want.length === 0) return { blocks, replaced: 0, matched: true };

  const got = circledCharsIn(richToPlainText(blocks));
  if (got.length === 0) return { blocks, replaced: 0, matched: true };
  if (got.length !== want.length) return { blocks, replaced: 0, matched: false };

  const map = new Map<string, string>();
  for (let i = 0; i < got.length; i++) {
    if (got[i] !== want[i]) map.set(got[i], want[i]);
  }
  if (map.size === 0) return { blocks, replaced: 0, matched: true };

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

  return { blocks: walk(blocks), replaced, matched: true };
}
