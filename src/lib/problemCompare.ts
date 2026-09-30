// **문제 글자 정확도 비교**(`/admin/compare-problem`)의 프롬프트와 해석.
//
// 2026-09-30 사용자 요청 — "이미지 생성 방식이라 텍스트 정확도가 많이 떨어진다,
// sol 6.1 로 개선하는 방안" → 두 방식을 한 화면에서 돌려 **비용·시간·남은 글자
// 차이**를 재 보기로 했다.
//
//  ② 검수 후 다시 그리기 — sunburst 가 문제를 통째로 그린 뒤 sol 이 원본과
//     대조해 글자가 다른 곳을 찾고, 있으면 그 목록을 지시로 붙여 한 번 더 그린다.
//  ③ 글자는 sol 이 읽고 우리가 조판 — sol 이 본문을 글자·LaTeX 로 옮기고 그림
//     자리만 짚는다. 그림은 잘라 내(원하면 sunburst 로 다시 그려) 카드에 붙인다.
//
// 두 방식의 결과를 **같은 대조 프롬프트**(`VERIFY_PROMPT`)로 원본과 견준다 —
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

/** ③ sol 이 짚은 그림 자리. 좌표는 sol 이 본 사진 대비 0~1. */
export type TranscribedFigure = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type Transcription = {
  /** Mathpix mmd 와 같은 꼴의 본문(`renderMathText` 가 그대로 그린다). */
  text: string;
  figures: TranscribedFigure[];
};

/**
 * ③ 옮겨 적기 프롬프트. 출력 글은 **이 앱의 인식 경로가 이미 그리는 꼴**
 * (Mathpix mmd)에 맞춘다 — 그래야 `renderMathText`·카드 조립을 그대로 쓴다:
 * `$…$`/`$$…$$` 수식, 빈 줄로 문단, `> ` 로 조건 박스, `<보기>` 머리글과
 * ㄱ. ㄴ. ㄷ. 항목, 마크다운 표.
 *
 * 그림은 글자로 못 옮기는 것(그래프·도형·지도·사진·도식)만이다. 글자만 든 표는
 * 표로 옮긴다 — 그림으로 넘기면 표 안 글자가 다시 이미지 모델 손에 들어간다.
 */
export const TRANSCRIBE_PROMPT = `task: transcribe ONE Korean exam question from the photo so it can be re-typeset. text accuracy is the whole point — every printed character exactly as printed.

ignore handwriting (student's pencil/pen marks, circles, check marks, scribbles, written answers). keep only what is PRINTED.

output format for "text" (markdown-like, rendered by our typesetter):
- question number at the start as printed, e.g. "17. " .
- paragraphs separated by one blank line. do not add line breaks inside a sentence.
- ALL math in LaTeX: inline $...$, display $$...$$ on its own line. numbers inside sentences that are part of math (e.g. $f(x)$, $x=3$, $\\frac{1}{2}$) go in $...$. plain Korean numbers like "3개" may stay plain.
- a condition box printed with a border: each line prefixed with "> ". (가)/(나) conditions keep their markers "(가)", "(나)".
- <보기> box: a line "<보기>" then one item per line: "ㄱ. ...", "ㄴ. ...", "ㄷ. ...".
- a table made only of text/numbers: markdown table ("| a | b |" rows, second row "| --- | --- |"). keep every cell.
- choices: each on its own line as printed, e.g. "① 1  ② 2  ③ 3  ④ 4  ⑤ 5" on one line if printed on one line.
- circled markers (㉠㉡㉢ ①② ⓐⓑ ㉮㉯) as those exact unicode characters. read the character INSIDE each circle carefully; never guess from neighbours.
- printed underline: \\underline{...} inside $...$ only for math; for Korean words write them plainly.
- a fraction whose numerator/denominator are Korean words: $\\frac{\\text{분자}}{\\text{분모}}$.

figures: anything that cannot be written as text or a simple table — graph, geometric figure, diagram, map, photo, chart, apparatus, a table containing pictures. for each figure:
- put a line "[[FIG fN]]" (N = 1,2,…) as its own paragraph where it sits in the reading order.
- give its box in "figures" with box_2d [ymin, xmin, ymax, xmax] normalised 0-1000 to THIS image, tight around the figure including its labels/caption.
- do NOT also transcribe the text drawn inside the figure (axis labels, numbers on the graph) — it stays in the picture.

return JSON only:
{"text":"...","figures":[{"id":"f1","box_2d":[ymin,xmin,ymax,xmax]}]}`;

/** 옮겨 적기 결과를 읽는다. 자리 표시가 없는 그림·본문에만 있는 표시는 서로 맞춘다. */
export function parseTranscription(text: string): Transcription {
  const obj = parseJsonObject(text) as { text?: unknown; figures?: unknown };
  const body = typeof obj?.text === "string" ? obj.text : "";
  if (!body.trim()) throw new Error("옮겨 적은 글이 비어 있습니다.");
  const figures: TranscribedFigure[] = [];
  if (Array.isArray(obj.figures)) {
    for (const f of obj.figures.slice(0, 12)) {
      if (!f || typeof f !== "object") continue;
      const r = f as { id?: unknown; box_2d?: unknown };
      const id = typeof r.id === "string" && /^f\d{1,2}$/.test(r.id) ? r.id : null;
      const b = Array.isArray(r.box_2d) ? r.box_2d.map(Number) : null;
      if (!id || !b || b.length !== 4 || b.some((n) => !Number.isFinite(n))) continue;
      const [y0, x0, y1, x1] = b.map((n) => Math.min(1000, Math.max(0, n)) / 1000);
      if (x1 - x0 < 0.01 || y1 - y0 < 0.01) continue;
      figures.push({ id, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
  }
  return { text: body, figures };
}

/** 본문에서 그림 자리 표시 줄. */
export const FIG_MARKER = /^\s*\[\[FIG (f\d{1,2})\]\]\s*$/;

/**
 * 본문을 그림 자리 표시 기준으로 나눈다. `before` 는 그 그림 앞까지의 본문
 * (자리 계산용), `text` 는 표시를 뺀 본문 전체다.
 */
export function splitFigureMarkers(text: string): {
  text: string;
  markers: { id: string; before: string }[];
} {
  const paras = text.replace(/\r\n/g, "\n").split(/\n\s*\n/);
  const kept: string[] = [];
  const markers: { id: string; before: string }[] = [];
  for (const p of paras) {
    const m = p.match(FIG_MARKER);
    if (m) {
      markers.push({ id: m[1], before: kept.join("\n\n") });
      continue;
    }
    kept.push(p);
  }
  return { text: kept.join("\n\n"), markers };
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
