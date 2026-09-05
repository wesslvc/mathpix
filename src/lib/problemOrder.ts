import type { KoreanMeta } from "./koreanSet";

/**
 * 문제를 늘어놓는 차례. **번호가 곧 차례다.**
 *
 * 예전에는 저장한 차례(`sort_order`)가 곧 인쇄 차례였고, 화면에는 그 **자리
 * 번호**(1, 2, 3…)가 보였다. 그런데 실제 시험지 번호는 5·8·17 처럼 띄엄띄엄
 * 이라, 화면의 "1번"이 무엇을 가리키는지 알 수 없었다(사용자 지적 —
 * "번호대로 자동으로 정렬하고, 밑에 저거 번호 있는 건 실제 번호로 바꿔").
 * 이제 **실제 문제 번호로 정렬하고 그 번호를 그대로 보여 준다.**
 *
 * **화면과 PDF 가 같은 함수를 쓴다.** 목록에서 본 차례와 인쇄된 차례가 다르면
 * 무엇이 맞는지 알 수 없다 — 이 저장소가 여러 번 데인 자리라(`computeSummary`,
 * `readUsage`) 규칙은 한 곳에만 둔다. 그래서 이 파일에는 **네트워크 호출도
 * 환경변수도 없다**(`problemBoxes.ts`·`gradeSummary.ts` 와 같은 이유).
 *
 * **국어 세트는 흩어지면 안 된다.** 지문에는 번호가 없어서 번호로만 줄을
 * 세우면 맨 뒤로 밀려 제 문제들과 갈라진다. 그래서 세트를 한 덩어리로 보고
 * **그 세트의 가장 작은 문제 번호** 자리에 통째로 놓되, 세트 안에서는 지문이
 * 맨 앞에 온다.
 */
export type OrderableProblem = {
  /** 실제 시험지 번호. 없으면 null(맨 뒤로 간다). */
  number: number | null;
  /** 저장된 자리. 번호가 없는 것들끼리의 차례를 정할 때만 쓴다. */
  sortOrder: number | null;
  createdAt?: string | null;
  korean?: KoreanMeta | null;
};

/** 번호가 없는 것은 맨 뒤로. */
const LAST = Number.MAX_SAFE_INTEGER;

/**
 * 세트마다 "그 세트가 놓일 번호"를 미리 구해 둔다.
 * 세트 안의 **문제들 중 가장 작은 번호**다(지문에는 번호가 없다).
 */
function setAnchors<T extends OrderableProblem>(list: T[]): Map<string, number> {
  const anchors = new Map<string, number>();
  for (const p of list) {
    const setId = p.korean?.setId;
    if (!setId || p.number == null) continue;
    const cur = anchors.get(setId);
    if (cur === undefined || p.number < cur) anchors.set(setId, p.number);
  }
  return anchors;
}

/**
 * 번호 차례로 늘어놓는다(원본은 건드리지 않는다).
 *
 * 같은 자리에 놓일 것들은 저장된 차례 → 만든 차례로 가른다. 어느 쪽도 없으면
 * 넣은 차례가 그대로 남는다(`sort` 는 안정 정렬이다).
 */
export function sortByProblemNumber<T extends OrderableProblem>(list: T[]): T[] {
  const anchors = setAnchors(list);

  const keyOf = (p: T): [number, number, number] => {
    const setId = p.korean?.setId;
    // 세트에 속하면 세트 자리로, 아니면 제 번호로 줄을 선다.
    const group = setId ? (anchors.get(setId) ?? LAST) : (p.number ?? LAST);
    // 세트 안에서는 지문이 맨 앞.
    const withinSet = p.korean?.role === "passage" ? 0 : 1;
    return [group, withinSet, p.number ?? LAST];
  };

  return [...list].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return ka[i] - kb[i];
    }
    // 번호로 가릴 수 없으면 저장된 차례 → 만든 차례.
    const sa = a.sortOrder ?? LAST;
    const sb = b.sortOrder ?? LAST;
    if (sa !== sb) return sa - sb;
    return (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
  });
}
