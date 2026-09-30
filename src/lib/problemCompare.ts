// **문제 글자 정확도 비교**(`/admin/compare-problem`)의 프롬프트와 해석.
//
// 2026-09-30 사용자 요청 — "이미지 생성 방식이라 텍스트 정확도가 많이 떨어진다,
// sol 6.1 로 개선하는 방안". 운영(sunburst 한 번) · ① 같은 그리기에 quality 만 올림 ·
// ② sol 이 원본과 대조해 틀린 곳을 지시로 붙여 다시 그리기 를 견준다.
// (③ "sol 이 본문을 글자로 옮기고 우리가 조판" 은 폐기했다 — git 이력에 있다.)
//
// 세 방식의 결과를 **같은 대조 프롬프트**(`VERIFY_PROMPT`)로 원본과 견준다 —
// 그래야 "남은 차이"가 같은 잣대로 센 숫자가 된다.
//
// 이 파일에는 네트워크 호출도 환경변수도 없다(화면과 서버가 같이 쓴다).

/** 원본과 다시 만든 것 사이의 글자 차이 하나. */
export type TextDiff = {
  /** 원본(사진 1)에 인쇄된 글자. */
  original: string;
  /** 다시 만든 것(사진 2)에 보이는 글자. 빠졌으면 빈 글자. */
  recreated: string;
  /** 어디쯤인지(짧게). */
  where: string;
};

/**
 * 대조 프롬프트. 사진 1 = 원본(손글씨가 있을 수 있다), 사진 2 = 다시 만든 것.
 *
 * **글자만 본다** — 글꼴·줄바꿈·간격·배치·그림 화풍은 다 달라도 된다. 그걸
 * 세기 시작하면 ③(우리가 조판)은 언제나 "다르다"가 되어 비교가 안 된다.
 * 손글씨는 원본에만 있고 지우는 게 맞으므로 차이로 치지 않는다.
 */
export const VERIFY_PROMPT = `task: proofread a re-created Korean exam question against the original photo.
image 1 = ORIGINAL photo of the printed question (may contain a student's handwriting — pencil/pen marks, circles, scribbles; IGNORE handwriting entirely, it is supposed to be removed).
image 2 = RE-CREATED version of the same question.

find every place where the PRINTED TEXT of image 2 differs from image 1:
- wrong, missing or extra characters (한글, 한자, 영문), words, numbers, units, signs
- math: wrong symbols, exponents, subscripts, fractions (numerator/denominator), inequality direction, variables
- circled markers (㉠㉡ ①② ⓐⓑ ㉮㉯) and choice numbers — a wrong or swapped marker IS a difference
- negations and key words (옳은 ↔ 옳지 않은, 않는, 아닌, 최대/최소 ...) — highest priority
- lines/sentences/choices that are missing or duplicated
- text inside tables and figure labels (axis labels, numbers on graphs, legend) also counts

do NOT report: font, size, spacing, line breaks, alignment, box/table border style, drawing style of figures, handwriting, image quality, the same math written in different but equivalent notation.
be precise — quote the exact characters. if you are not sure a difference exists, do not report it.

return JSON only:
{"diffs":[{"original":"exact printed text in image 1","recreated":"what image 2 shows instead (\\"\\" if missing)","where":"short location, e.g. 발문 2줄 / 선택지 ③ / 표 2행"}]}
return {"diffs":[]} if the printed text matches.`;

/** 대조 결과를 읽는다. 모양이 이상한 항목은 버린다. */
export function parseVerify(text: string): TextDiff[] {
  const obj = parseJsonObject(text);
  const list = (obj as { diffs?: unknown })?.diffs;
  if (!Array.isArray(list)) throw new Error("대조 결과를 읽지 못했습니다.");
  const out: TextDiff[] = [];
  for (const d of list.slice(0, 80)) {
    if (!d || typeof d !== "object") continue;
    const r = d as Record<string, unknown>;
    const original = typeof r.original === "string" ? r.original : "";
    const recreated = typeof r.recreated === "string" ? r.recreated : "";
    const where = typeof r.where === "string" ? r.where : "";
    if (!original && !recreated) continue;
    if (original === recreated) continue;
    out.push({ original, recreated, where });
  }
  return out;
}

/**
 * ② 두 번째 그리기에 붙일 지시. `withInstruction` 이 "그리는 방식만 받는다,
 * 원본 베끼기가 이긴다"로 감싸므로, 여기서는 **원본대로 고치라는** 말만 한다
 * (내용을 바꾸라는 요청이 아니다 — 원본과 같게 되돌리라는 요청이다).
 */
export function correctionInstruction(diffs: TextDiff[]): string {
  const lines = diffs.slice(0, 20).map((d, i) => {
    const got = d.recreated ? `"${d.recreated}"` : "(빠짐)";
    return `${i + 1}. ${d.where ? `[${d.where}] ` : ""}원본 "${d.original}" 인데 지난번에 ${got} 로 그렸다.`;
  });
  return `지난번 결과에서 아래 글자가 원본 사진과 달랐다. 이번에는 사진과 똑같이 그려라(나머지도 그대로 베낀다):
${lines.join("\n")}`;
}

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a === -1 || b <= a) throw new Error("모델 응답이 JSON 이 아닙니다.");
    return JSON.parse(text.slice(a, b + 1));
  }
}
