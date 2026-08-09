/**
 * 자료 재구성 1회에 차감할 사진인식권 수.
 *
 * 수학 도형(lite)과 같은 5장을 기본으로 둔다. 다만 이쪽은 Gemini 무료 등급이
 * 아니라 실제로 요금이 청구되는 API라, 쓰다가 비용이 안 맞으면 환경변수
 * FIGURE_CREDIT_COST 로 재배포 없이 올릴 수 있게 해뒀다.
 *
 * 서버(과금)와 화면(안내 문구)이 같은 값을 봐야 하므로 여기 한 곳에만 둔다.
 * 화면 쪽은 /api/figure/config 로 이 값을 읽어간다 — 클라이언트에 숫자를
 * 따로 적어두면 반드시 어긋난다(도형 쪽에서 이미 겪은 일이다).
 */
export const FIGURE_CREDIT_COST = (() => {
  const raw = Number(process.env.FIGURE_CREDIT_COST);
  return Number.isInteger(raw) && raw >= 0 ? raw : 5;
})();
