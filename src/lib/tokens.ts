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

/**
 * 문제 인식(Mathpix) 1회의 고정 차감액. `/api/mathpix`가
 * `consume_recognition_credit({ p_amount: OCR_TOKEN_COST })`로 차감한다.
 *
 * **5에서 1로 다시 내렸다**(사용자 결정, 2026-09-26 — "mathpix는 돈 거의
 * 안드니까 1토큰으로 해서 무료회원이 실컷쓰게 해"). Mathpix 인식은 원가가
 * 아주 싸서 무료 회원도 자주 쓸 수 있어야 한다는 판단이다. 한때 1→5로
 * 올린 적이 있는데(위 이력) 그 반대 방향 결정이다.
 */
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
 * 자동채점·답지 인식(`gradingTokenCharge`)이 실사용량을 토큰으로 바꿀 때
 * 쓰는 배수. AI 그림 생성은 더 이상 이 값을 쓰지 않는다(아래 참고) —
 * 남겨 둔 이유는 채점 쪽 정산이 여전히 이 값에 기대기 때문이다.
 */
export const FIGURE_MARGIN = (() => {
  const raw = Number(process.env.FIGURE_MARGIN);
  return Number.isFinite(raw) && raw > 0 ? raw : 1.5;
})();

/**
 * AI 그림 생성(GPT 이미지) 1회의 **고정 차감액**.
 *
 * **원가 정산 방식에서 고정 차감으로 바꿨다**(사용자 결정, 2026-09-17).
 * 예전에는 원가(96~143원)에 마진을 곱해 실사용량만큼만 받았는데, 그러려면
 * "보증금 → 정산" 두 단계가 필요해 코드도 복잡하고 사용자에게 보이는
 * 금액도 매번 달랐다. 지금은 원가가 얼마든 항상 이 값만 뗀다 — 간단하고
 * 예측 가능하지만, 원가가 이 값을 넘는 요청에서는 우리가 밑진다(사용자가
 * 감수하기로 한 절충이다).
 */
export const FIGURE_TOKEN_DEPOSIT = (() => {
  const raw = Number(process.env.FIGURE_TOKEN_DEPOSIT);
  return Number.isInteger(raw) && raw > 0 ? raw : 120;
})();

/**
 * 이번 생성에 물릴 토큰. **고정값이라 원가(`estKrw`)는 더 이상 안 본다** —
 * 매개변수는 호출부(`/api/figure`)와의 호환을 위해 남겨 뒀다. 실제 원가는
 * 로그(`[figureImageGen] usage`)에서 여전히 볼 수 있다.
 */
export function figureTokenCharge(_estKrw: number | undefined): number {
  return FIGURE_TOKEN_DEPOSIT;
}

/** 국어 지문 인식 1회의 **고정** 차감액(2026-09-17 사용자 결정 — 원가와 무관). */
export const PASSAGE_READ_TOKENS = 100;

/** 지문 서식 검수(두 번째 호출)의 보증금. 실사용량으로 정산해 남으면 돌려준다. */
export const PASSAGE_MARKS_DEPOSIT = 30;

/**
 * 게이지를 그릴 때 "가득 찬 상태"로 볼 기준. 이용권 1회 구매분이다.
 * 잔액이 이보다 많으면 게이지는 가득 찬 것으로 보여준다.
 */
export const TOKEN_GAUGE_FULL = 1000;

/**
 * luna 를 쓰는 호출(자동채점·답지 인식·제목 짓기) 1회의 **고정 차감액**.
 *
 * **실사용량 정산에서 고정 1토큰으로 바꿨다**(사용자 결정, 2026-09-26 —
 * "luna는 돈 거의 안드니까 1토큰으로 해서 무료회원이 실컷쓰게 해"). luna
 * 원가가 실제로 몇 원 수준이라(위 채점 2.9원·제목 0.8원 실측 참고) 실사용량
 * 정산이 주는 이점(정확한 원가 반영)보다 "무료 회원이 부담 없이 쓴다"는
 * 목적이 우선이다. 이제 이 값을 쓰는 라우트(`/api/grade-exam`·
 * `/api/answer-key`·`/api/korean-title`)는 전부 `gradingBilling.ts`의
 * `flat: true` 로 항상 이 값만 뗀다 — `gradingTokenCharge`(실사용량 계산)는
 * 더 이상 이 셋에서 안 불린다(다른 곳, 예: 지문 서식 검수의 sol 정산은 그대로).
 */
export const GRADING_TOKEN_DEPOSIT = (() => {
  const raw = Number(process.env.GRADING_TOKEN_DEPOSIT);
  return Number.isInteger(raw) && raw > 0 ? raw : 1;
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
 * 입력 토큰 100만 개당 단가(달러). 아래 `GRADING_PRICES` 에 없는 모델에만
 * 쓰는 **폴백**이다 — 새 모델을 붙일 때 재배포 없이 값을 넣을 수 있게 둔다.
 */
const GRADING_PRICE_INPUT_PER_MTOK_USD = (() => {
  const raw = Number(process.env.GRADING_PRICE_INPUT_PER_MTOK_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
})();

/** 출력 토큰 100만 개당 단가(달러). 위와 같이 폴백이다. */
const GRADING_PRICE_OUTPUT_PER_MTOK_USD = (() => {
  const raw = Number(process.env.GRADING_PRICE_OUTPUT_PER_MTOK_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
})();

type ModelPrice = {
  /** 입력 100만 토큰당 달러. */
  input: number;
  /** 캐시된 입력 100만 토큰당 달러. 모르면 비워 둔다(정가로 친다). */
  cachedInput?: number;
  /** 출력 100만 토큰당 달러. */
  output: number;
};

/**
 * **모델마다 단가가 다르다.** 하나로 뭉뚱그리면 안 된다.
 *
 * 예전에는 환경변수 한 쌍(`GRADING_PRICE_*`)을 모든 vision 호출에 똑같이
 * 썼는데, 실제로는 **열 배까지 차이가 난다** — luna 는 입력 $0.20·출력
 * $1.20 인데 terra 는 입력 $2.00·출력 $12.00 이다. 한 쌍으로 두고 terra
 * 값을 넣으면 채점·제목 짓기·답지 읽기(전부 luna)가 열 배로 과다 청구되고,
 * luna 값을 넣으면 지문 인식(terra)에서 우리가 열 배를 밑진다.
 *
 * **공표된 요금표를 그대로 적는다** — gpt-image-2 때 정한 원칙과 같다
 * ("청구액에서 역산하지 말 것"). 모르는 모델은 여기 넣지 않고, 그때는
 * 위 환경변수 폴백이 없으면 `undefined` 를 돌려줘 보증금 고정으로 간다.
 */
const GRADING_PRICES: Record<string, ModelPrice> = {
  // 사용자가 알려 준 값. cachedInput 은 안 알려 줘서 비워 둔다 — 정가로
  // 치므로 적게 잡는 쪽으로는 틀리지 않는다.
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
  // 지문 인식(`/api/korean-text`). 캐시 입력 단가까지 알려 준 값이다.
  "gpt-5.6-terra": { input: 2.0, cachedInput: 0.2, output: 12.0 },
  // 2026-09-25 사용자가 알려 준 값. luna 는 채점·답지·제목 짓기·영역 찾기의
  // 기본 모델이라, 이 줄이 생기면서 그쪽이 보증금 고정 → 실사용량 정산으로 바뀐다.
  "gpt-6-luna": { input: 0.1, output: 0.5 },
  "gpt-6-sol": { input: 2.0, output: 10.0 },
};

function priceFor(model?: string): ModelPrice | null {
  const known = model ? GRADING_PRICES[model] : undefined;
  if (known) return known;
  if (
    GRADING_PRICE_INPUT_PER_MTOK_USD !== null &&
    GRADING_PRICE_OUTPUT_PER_MTOK_USD !== null
  ) {
    return {
      input: GRADING_PRICE_INPUT_PER_MTOK_USD,
      output: GRADING_PRICE_OUTPUT_PER_MTOK_USD,
    };
  }
  return null;
}

/**
 * vision 호출 1회의 원가(원)를 추정한다. **단가를 모르면 `undefined`** —
 * 그러면 `gradingTokenCharge`가 폴백(보증금 그대로)으로 처리한다.
 *
 * `model` 을 꼭 넘겨라. 안 넘기면 환경변수 폴백뿐이라 모델별 차이가 사라진다.
 */
export function gradingEstKrw(
  usage: {
    inputTokens: number;
    outputTokens: number;
    /** 그중 캐시로 처리된 입력 토큰(있으면 훨씬 싸다). */
    cachedInputTokens?: number;
  },
  model?: string,
): number | undefined {
  const price = priceFor(model);
  if (!price) return undefined;
  // OpenAI 의 `input_tokens` 는 캐시된 것을 **포함한** 값이라 빼서 나눈다.
  const cached = Math.min(Math.max(usage.cachedInputTokens ?? 0, 0), usage.inputTokens);
  const fresh = usage.inputTokens - cached;
  // 캐시 단가를 모르면 정가로 친다 — 적게 잡아 밑지는 쪽으로는 안 틀린다.
  const cachedRate = price.cachedInput ?? price.input;
  const estUsd =
    (fresh * price.input + cached * cachedRate + usage.outputTokens * price.output) / 1e6;
  return estUsd * USD_TO_KRW;
}

/** 채점 1회에 물릴 토큰. 단가를 알면 실사용량, 모르면 보증금 그대로. */
export function gradingTokenCharge(estKrw: number | undefined): number {
  if (estKrw === undefined) return GRADING_TOKEN_DEPOSIT;
  return Math.max(1, Math.ceil((estKrw * FIGURE_MARGIN) / KRW_PER_TOKEN));
}

