/**
 * 토큰 — 이 앱의 사용 단위.
 *
 * 예전에는 "사진인식권 N장"이었는데, 기능마다 실제 비용 차이가 커서(문제 인식은
 * 싸고 AI 그림 생성은 비싸다) 한 장 단위로는 표현이 안 됐다. 단위를 토큰으로
 * 바꾸고 기능별로 다른 개수를 쓰게 한다.
 *
 * DB는 그대로 `entitlements.credits`를 쓴다 — 값의 의미만 "장"에서 "토큰"으로
 * 바뀌었을 뿐이라 마이그레이션이 필요 없다(기존 잔액은 1:1로 토큰이 된다).
 */

/** 문제 인식(Mathpix) 1회. 서버가 consume_recognition_credit(1)로 차감한다. */
export const OCR_TOKEN_COST = 1;

/**
 * 토큰 하나의 판매가(원). 1000토큰을 3000원에 판다.
 *
 * **AI 그림 생성을 얼마 받을지 계산하는 기준이다.** 판매가가 바뀌면 여기만
 * 고치면 차감량이 저절로 따라온다.
 */
export const KRW_PER_TOKEN = (() => {
  const raw = Number(process.env.KRW_PER_TOKEN);
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
})();

/**
 * AI 그림 생성을 **원가의 몇 배**로 받을지.
 *
 * 원가는 요청마다 96~143원으로 1.5배까지 널뛴다. 고정 요금으로는 어느 쪽으로도
 * 틀리므로(싼 요청은 사용자가 더 내고, 비싼 요청은 우리가 밑진다) 실제 쓴
 * 값에 이 배수를 곱해 받는다.
 */
export const FIGURE_MARGIN = (() => {
  const raw = Number(process.env.FIGURE_MARGIN);
  return Number.isFinite(raw) && raw > 0 ? raw : 1.5;
})();

/**
 * AI 그림 생성 1회의 **보증금**. 부르기 전에 이만큼 먼저 차감한다.
 *
 * 선차감이 있어야 잔액이 없는 사람이 생성을 시작하지 못한다. 끝나면 실제 값과
 * 견주어 남으면 돌려주고 모자라면 더 받는다.
 */
export const FIGURE_TOKEN_DEPOSIT = (() => {
  const raw = Number(process.env.FIGURE_TOKEN_DEPOSIT);
  return Number.isInteger(raw) && raw > 0 ? raw : 50;
})();

/**
 * 응답에 usage 가 없어 실제 값을 모를 때 물릴 토큰.
 *
 * 보증금을 다 물리면 과다 청구고, 안 물리면 공짜다. 관측 중앙값(원가 120원
 * → 60토큰)을 쓴다.
 */
export const FIGURE_TOKEN_FALLBACK = (() => {
  const raw = Number(process.env.FIGURE_TOKEN_FALLBACK);
  return Number.isInteger(raw) && raw > 0 ? raw : 60;
})();

/**
 * 이번 생성에 물릴 토큰. 원가(원)에 마진을 곱해 토큰으로 바꾼다.
 *
 * 원가를 모르면(usage 가 안 왔으면) 폴백. 아무리 싸도 0 토큰은 아니다.
 */
export function figureTokenCharge(estKrw: number | undefined): number {
  if (typeof estKrw !== "number" || !Number.isFinite(estKrw) || estKrw <= 0) {
    return FIGURE_TOKEN_FALLBACK;
  }
  return Math.max(1, Math.ceil((estKrw * FIGURE_MARGIN) / KRW_PER_TOKEN));
}

/**
 * 게이지를 그릴 때 "가득 찬 상태"로 볼 기준. 이용권 1회 구매분이다.
 * 잔액이 이보다 많으면 게이지는 가득 찬 것으로 보여준다.
 */
export const TOKEN_GAUGE_FULL = 1000;

/**
 * 자동채점(OMR·정답표 읽기) 1회의 **보증금**.
 *
 * 단가를 모를 때(둘 중 하나라도 비어 있을 때)는 실사용량 정산이 아니라
 * 이 고정 소액을 그대로 받는다 — 그림 하나(50)에 비해 텍스트 위주
 * 호출이라 훨씬 싸다는 것만 가정한 값이다.
 *
 * `GRADING_PRICE_INPUT_PER_MTOK_USD` / `GRADING_PRICE_OUTPUT_PER_MTOK_USD`
 * 를 **둘 다** 채우면 그 순간부터 그림 생성과 같은 방식(보증금 → 실사용량
 * 정산)으로 바뀐다(`gradingTokenCharge`).
 */
export const GRADING_TOKEN_DEPOSIT = (() => {
  const raw = Number(process.env.GRADING_TOKEN_DEPOSIT);
  return Number.isInteger(raw) && raw > 0 ? raw : 5;
})();

/**
 * 달러를 원으로 옮길 때 쓰는 환율. `figureImageGen.ts`와 같은 환경변수를
 * 읽는다 — 환율은 앱 전체에서 하나여야지, 기능마다 다른 값을 쓰면 어느
 * 쪽이 맞는지 알 수 없어진다.
 */
const USD_TO_KRW = (() => {
  const raw = Number(process.env.USD_TO_KRW);
  return Number.isFinite(raw) && raw > 0 ? raw : 1400;
})();

/**
 * 입력 토큰 100만 개당 단가(달러). OpenAI가 공표한 요금표 값을 그대로
 * 넣는다 — gpt-image-2 때와 같은 원칙("청구액에서 역산하지 말 것")이라,
 * 공표된 숫자가 아니면 비워 둔다. 설정 안 하면 실사용량 정산을 안 한다.
 */
const GRADING_PRICE_INPUT_PER_MTOK_USD = (() => {
  const raw = Number(process.env.GRADING_PRICE_INPUT_PER_MTOK_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
})();

/** 출력 토큰 100만 개당 단가(달러). */
const GRADING_PRICE_OUTPUT_PER_MTOK_USD = (() => {
  const raw = Number(process.env.GRADING_PRICE_OUTPUT_PER_MTOK_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
})();

/**
 * 채점 1회의 원가(원)를 추정한다. **단가를 모르면 `undefined`** — 그러면
 * `gradingTokenCharge`가 폴백(보증금 그대로)으로 처리한다.
 */
export function gradingEstKrw(usage: {
  inputTokens: number;
  outputTokens: number;
}): number | undefined {
  if (GRADING_PRICE_INPUT_PER_MTOK_USD === null || GRADING_PRICE_OUTPUT_PER_MTOK_USD === null) {
    return undefined;
  }
  const estUsd =
    (usage.inputTokens * GRADING_PRICE_INPUT_PER_MTOK_USD +
      usage.outputTokens * GRADING_PRICE_OUTPUT_PER_MTOK_USD) /
    1e6;
  return estUsd * USD_TO_KRW;
}

/** 채점 1회에 물릴 토큰. 단가를 알면 실사용량, 모르면 보증금 그대로. */
export function gradingTokenCharge(estKrw: number | undefined): number {
  if (estKrw === undefined) return GRADING_TOKEN_DEPOSIT;
  return Math.max(1, Math.ceil((estKrw * FIGURE_MARGIN) / KRW_PER_TOKEN));
}

