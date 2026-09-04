/**
 * 국어 지문·문제 묶음(세트).
 *
 * 국어는 지문 하나에 문항 여러 개가 딸린다. 다른 과목처럼 문제를 낱개로
 * 늘어놓으면 지문이 어느 문제 것인지 알 수 없고, 인쇄할 때 지문과 문제가
 * 다른 쪽으로 갈라진다. 그래서 **같은 세트 id** 로 묶어 둔다.
 *
 * **저장 위치는 `problems.box_range.korean`** 이다. 새 컬럼을 만들지 않는
 * 것이 이 저장소의 관행이다 — 마이그레이션을 안 돌린 사람에게는 없는 컬럼에
 * 쓰는 순간 저장 자체가 실패한다(`fontSize.ts`·`storedFigures.ts` 와 같은 이유).
 *
 * **이 파일에는 네트워크 호출도 환경변수도 없다.** 화면(국어 모드·내보내기
 * 미리보기)과 서버(내보내기 조회)가 같은 판정을 써야 하기 때문이다
 * (`problemBoxes.ts`·`gradeSummary.ts` 와 같은 이유).
 */

import { readRichBlocks, type RichBlock } from "./kice/richText";

export type KoreanRole = "passage" | "question";

export type KoreanMeta = {
  /** 같은 지문에 딸린 것들을 묶는 값. */
  setId: string;
  role: KoreanRole;
  /**
   * 지문 제목. **지문 행에만 적는다** — 문제 행에도 적어 두면 지문 제목을
   * 고쳤을 때 문제 행이 낡은 제목을 들고 있게 된다.
   */
  title?: string;
  /** 세트 안에서의 차례(문제끼리). 없으면 저장된 차례를 따른다. */
  index?: number;
  /**
   * **지문 행에만 있다.** terra 가 구조화해 읽은 지문 글자(문단·상자·굵게·
   * 밑줄). 있으면 내보내기가 사진 대신 이걸로 평가원 글꼴 조판을 한다
   * (`pdf.ts` 의 `passageText`). 없으면(옛 데이터, 인식 실패, "원본 그대로
   * 넣기") 예전처럼 오려낸 사진을 쓴다 — 그래서 이 필드는 있어도 그만
   * 없어도 그만이어야 한다.
   */
  blocks?: RichBlock[];
};

/** `box_range` 에서 국어 메타를 읽는다. 모양이 안 맞으면 없는 것으로 본다. */
export function readKoreanMeta(value: unknown): KoreanMeta | null {
  if (!value || typeof value !== "object") return null;
  // box_range 를 통째로 받았을 수도, `korean` 값만 받았을 수도 있다.
  const raw =
    "korean" in (value as Record<string, unknown>)
      ? (value as { korean?: unknown }).korean
      : value;
  if (!raw || typeof raw !== "object") return null;
  const o = raw as {
    setId?: unknown;
    role?: unknown;
    title?: unknown;
    index?: unknown;
    blocks?: unknown;
  };
  if (typeof o.setId !== "string" || !o.setId) return null;
  if (o.role !== "passage" && o.role !== "question") return null;
  const blocks = o.role === "passage" ? readRichBlocks(o.blocks) : [];
  return {
    setId: o.setId,
    role: o.role,
    title: typeof o.title === "string" && o.title.trim() ? o.title : undefined,
    index: typeof o.index === "number" && Number.isFinite(o.index) ? o.index : undefined,
    ...(blocks.length > 0 ? { blocks } : {}),
  };
}

export type KoreanSet<T> = {
  setId: string;
  /** 첫 장 목차에 적을 이름. 지문 행이 들고 있다. */
  title: string;
  /** 지문. 아직 안 넣었거나 지운 세트면 없을 수 있다. */
  passage: T | null;
  questions: T[];
};

/**
 * 문제 목록을 세트로 묶는다. **저장된 차례를 그대로 지킨다** — 세트끼리의
 * 순서는 그 세트가 처음 나온 자리이고, 세트 안 문제의 순서도 나온 차례다
 * (`index` 가 적혀 있으면 그것을 먼저 본다).
 *
 * 국어 메타가 없는 문제(= 지문 없는 국어 문항, 또는 다른 과목)는
 * `loose` 로 따로 돌려준다 — 이런 문항은 지문 쪽을 차지할 이유가 없다.
 */
export function groupKoreanSets<T>(
  items: T[],
  metaOf: (item: T) => KoreanMeta | null,
): { sets: KoreanSet<T>[]; loose: T[] } {
  const sets: KoreanSet<T>[] = [];
  const byId = new Map<string, KoreanSet<T>>();
  const loose: T[] = [];

  for (const item of items) {
    const meta = metaOf(item);
    if (!meta) {
      loose.push(item);
      continue;
    }
    let set = byId.get(meta.setId);
    if (!set) {
      set = { setId: meta.setId, title: "", passage: null, questions: [] };
      byId.set(meta.setId, set);
      sets.push(set);
    }
    if (meta.title && !set.title) set.title = meta.title;
    if (meta.role === "passage") {
      // 지문이 둘일 수는 없다. 둘째부터는 문제로 본다(잘못 표시된 것을
      // 버리는 것보다 남기는 편이 낫다 — 지우는 것은 사람이 판단할 일이다).
      if (set.passage === null) set.passage = item;
      else set.questions.push(item);
    } else {
      set.questions.push(item);
    }
  }

  // 세트 안 차례: `index` 가 적혀 있는 것끼리는 그 값으로, 없는 것은 나온 차례.
  for (const set of sets) {
    const order = new Map(set.questions.map((q, i) => [q, i] as const));
    set.questions.sort((a, b) => {
      const ai = metaOf(a)?.index ?? order.get(a) ?? 0;
      const bi = metaOf(b)?.index ?? order.get(b) ?? 0;
      return ai - bi;
    });
  }

  return { sets, loose };
}

/**
 * 첫 장 목차 한 줄. 예: `2~3p, 이감 5-6, 이중차분법`
 *
 * 세트 하나가 두 쪽(짝수 쪽 지문 · 홀수 쪽 문제)을 쓰므로 쪽 범위가 두
 * 쪽짜리로 나온다. 한 쪽만 쓰면(문제만 있는 세트) 한 쪽으로 적는다.
 */
export function tocLine(from: number, to: number, source: string, title: string): string {
  const pages = from === to ? `${from}p` : `${from}~${to}p`;
  return [pages, source, title].filter((s) => s && s.trim()).join(", ");
}
