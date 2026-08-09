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
 * AI 그림 생성(GPT 이미지) 1회.
 *
 * 실제로 요금이 나가는 유료 API라 인식보다 훨씬 비싸다. 환경변수
 * FIGURE_TOKEN_COST로 재배포 없이 조정할 수 있다.
 */
export const FIGURE_TOKEN_COST = (() => {
  const raw = Number(process.env.FIGURE_TOKEN_COST);
  return Number.isInteger(raw) && raw >= 0 ? raw : 50;
})();

/**
 * 게이지를 그릴 때 "가득 찬 상태"로 볼 기준. 이용권 1회 구매분이다.
 * 잔액이 이보다 많으면 게이지는 가득 찬 것으로 보여준다.
 */
export const TOKEN_GAUGE_FULL = 1000;
