/**
 * OpenAI 청구 내역(CSV)의 토큰 수로 원가를 다시 계산하는 단가표(100만 토큰당 달러).
 * 장부(`ai_cost_log`)는 오차가 있어, 과거 OpenAI 비용은 `openai_usage_daily` 의 토큰 수 × 이 표로 낸다.
 *
 * 확인된 값: tokens.ts `GRADING_PRICES` · figureImageGen.ts `PRICE_PER_MTOK`.
 * **가정한 값**(공표 단가를 모름): 캐시 읽기 = 입력의 10%, 캐시 쓰기 = 입력의 1.25배, 옛 gpt-4/5 계열은 공개 정가 기억치.
 * 바꾸면 재배포만으로 과거 합계가 다시 계산된다.
 */
export type TokenPrice = { input: number; cached: number; write: number; output: number };

const p = (input: number, output: number, cached = input * 0.1, write = input * 1.25): TokenPrice => ({ input, cached, write, output });

export const OPENAI_TOKEN_PRICES: Record<string, TokenPrice> = {
  "gpt-6-luna": p(0.1, 0.5),
  "gpt-5.6-luna": p(0.2, 1.2),
  "gpt-6-sol": p(2, 10),
  "gpt-6.1-sol": p(2, 10),
  "gpt-5.6-sol": p(2, 10),
  "gpt-5.6-terra": p(2, 12, 0.2),
  "gpt-4.1-2025-04-14": p(2, 8),
  "gpt-4.1-mini-2025-04-14": p(0.4, 1.6),
  "gpt-4o-2024-08-06": p(2.5, 10),
  "gpt-4o-mini-2024-07-18": p(0.15, 0.6),
  "gpt-5-2025-08-07": p(1.25, 10),
  "gpt-5-mini-2025-08-07": p(0.25, 2),
};

/** 이미지 모델: 글자 입력 5 · 그림 입력 8 · 그림 출력 30. */
export const IMAGE_PRICE = { textIn: 5, imageIn: 8, imageOut: 30 };

export function isImageModel(model: string): boolean {
  return model.startsWith("gpt-image");
}

/** CSV 한 줄(모델·part·kind·토큰)의 달러. 단가를 모르는 텍스트 모델이면 null. */
export function usageUsd(model: string, part: string, kind: string, tokens: number): number | null {
  if (isImageModel(model)) {
    const per = part === "image" ? (kind === "output" ? IMAGE_PRICE.imageOut : IMAGE_PRICE.imageIn) : kind === "output" ? IMAGE_PRICE.imageOut : IMAGE_PRICE.textIn;
    return (tokens * per) / 1e6;
  }
  const price = OPENAI_TOKEN_PRICES[model];
  if (!price) return null;
  const per = kind === "output" ? price.output : kind === "cached input" ? price.cached : kind === "cache writes" ? price.write : price.input;
  return (tokens * per) / 1e6;
}

/** CSV 가 덮는 마지막 날(UTC). 이 날 이후의 OpenAI 비용은 장부에서 온다. */
export const OPENAI_CSV_END = "2026-10-10T00:00:00Z";

/** 이 금액(달러) 미만인 모델은 "기타"로 합친다. */
export const MIN_MODEL_USD = 0.5;
