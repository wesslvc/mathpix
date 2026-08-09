/**
 * 문제 본문 글자 크기.
 *
 * 인쇄물이라 단위를 pt로 잡는다(브라우저 px과 1:1이 아니다 — CSS는 96dpi
 * 기준이라 1pt = 4/3 px). 지금까지의 "보통"이 20px이었으므로 15pt가 그 값이다.
 *
 * **저장 위치가 `problems.box_range`인 이유**: 새 컬럼을 만들려면 마이그레이션이
 * 필요한데, 아직 안 돌린 사람에게는 저장 자체가 실패한다(없는 컬럼에 쓰면
 * 에러). 이미 있는 jsonb에 키 하나를 더 얹으면 그런 위험이 없다. 컬럼 이름이
 * 실제 내용보다 좁지만, 안전을 택했다.
 */
export const DEFAULT_FONT_PT = 15;

/** 자주 쓰는 크기. 직접 pt를 입력할 수도 있다. */
export const FONT_PT_PRESETS = [
  { label: "보통", pt: 15 },
  { label: "크게", pt: 18 },
  { label: "아주 크게", pt: 22 },
] as const;

export const MIN_FONT_PT = 8;
export const MAX_FONT_PT = 40;

/** CSS는 96dpi 기준이라 1pt = 4/3 px. */
export function ptToPx(pt: number): number {
  return (pt * 4) / 3;
}

/** 범위를 벗어나거나 숫자가 아니면 기본값으로. */
export function normalizeFontPt(value: unknown): number {
  const pt = Number(value);
  if (!Number.isFinite(pt)) return DEFAULT_FONT_PT;
  return Math.min(MAX_FONT_PT, Math.max(MIN_FONT_PT, Math.round(pt * 10) / 10));
}

/** 저장된 box_range 값에서 글자 크기를 읽는다. 없으면 기본값. */
export function readFontPt(stored: unknown): number {
  if (stored && typeof stored === "object" && "fontPt" in stored) {
    return normalizeFontPt((stored as { fontPt: unknown }).fontPt);
  }
  return DEFAULT_FONT_PT;
}
