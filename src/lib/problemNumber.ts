/**
 * 번호 앞에 붙는 껍데기. Mathpix 는 같은 "22." 를 여러 모양으로 돌려준다 —
 * `$22$.`(수식으로 감쌈), `\section*{22.}`(섹션 헤더), `**22.**`(굵게),
 * `#### 22.`(헤딩) 등. 예전 규칙은 **맨 앞이 순수 숫자일 때만** 받아서
 * 실제 출력 12가지 중 8가지를 놓쳤다(지면을 통째로 넣을 때 번호가 하나도
 * 안 붙던 원인이다).
 *
 * 숫자는 절대 지우지 않는다 — 지우면 번호 자체가 사라진다.
 */
const LEADING_NOISE =
  /^(?:\s|[$*#>~`|]|\\section\*?|\\subsection\*?|\\textbf|\\mathbf|\\text|\\begin\{[a-zA-Z*]+\}|\\end\{[a-zA-Z*]+\}|[{}[\]]|문제|문(?=\s*\d))+/;

/**
 * 번호 뒤에 오는 구분자. 전각 마침표(．)·전각 마침표(。)까지 받는다 —
 * 한글 시험지를 OCR 하면 반각 대신 전각으로 나오는 일이 흔하다.
 * 번호만 있고 줄이 바뀌는 형태(`22\n다음…`)도 받는다.
 */
const NUMBER_HEAD = /^(\d{1,3})\s*(?:[.)．。:\]}]|\$|\n|$)/;

/**
 * 인식된 텍스트 맨 앞의 문제 번호(예: "22." → 22)를 뽑는다.
 * 없으면 null을 반환한다.
 *
 * **네 자리 이상은 번호로 보지 않는다**(`\d{1,3}`) — "2024학년도…"로 시작하는
 * 지문에서 연도를 번호로 잡으면 안 된다. 구분자를 요구하는 것도 같은 이유다
 * ("3x+2=0" 의 3 은 뒤에 x 가 와서 걸리지 않는다).
 */
export function parseProblemNumber(text: string): number | null {
  const head = text.replace(LEADING_NOISE, "");
  const m = head.match(NUMBER_HEAD);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 사용자가 손으로 정해 둔 문제 번호를 읽는다.
 *
 * **저장 위치가 `problems.box_range`인 이유**는 글자 크기(`fontPt`)·그림
 * (`figures`)과 같다 — 새 컬럼을 만들면 마이그레이션을 안 돌린 사람에게는
 * 저장 자체가 실패한다. 이미 있는 jsonb 에 키를 얹으면 그 위험이 없다.
 *
 * 이 값이 있으면 **본문에서 뽑은 번호보다 우선한다.** 손으로 적은 것이
 * 자동 인식보다 확실하기 때문이다(통째로 그린 문제는 본문이 아예 없다).
 */
export function readProblemNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") return null;
  const n = (value as { number?: unknown }).number;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
