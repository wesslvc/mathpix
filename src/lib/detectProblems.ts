/**
 * 한 장에 여러 문제가 있는 지면에서 **문제마다의 영역**을 찾아낸다.
 *
 * 좌표 규격은 Gemini 가 정해 둔 `box_2d`(0~1000 으로 정규화된
 * `[ymin, xmin, ymax, xmax]`)를 쓴다. 문제 하나를 "물체"로 보는 셈이다.
 *
 * **모델은 두 갈래를 고를 수 있다**(`DETECT_PROVIDER`):
 *   openai — 기본(2026-09-25부터). GPT 비전 모델(luna)에 보낸다.
 *   gemini — 예전 기본. 자리를 재는 일에 맞춰 훈련된 규격이 있다.
 * 어느 쪽이든 **응답 형식과 뒤처리(묶기·합치기)는 완전히 같다** — 갈리는 것은
 * 호출 방법뿐이라, 바꿔 가며 결과만 비교하면 된다.
 *
 * 이건 그림을 만드는 일이 아니라 자리를 재는 일이라 값이 싼 등급이면 충분하고,
 * 결과가 좌표뿐이라 틀려도 사용자가 눈으로 보고 지우면 그만이다.
 */

import { columnOf, mergeWithinColumn as unionByColumn } from "./problemBoxes";
export type { ProblemBox } from "./problemBoxes";
import { callOpenRouterVision } from "./openrouterVision";
import type { ProblemBox } from "./problemBoxes";

/**
 * 문제 하나. `boxes` 가 둘 이상이면 **단을 넘어 이어진 문제**다.
 *
 * 모의고사 지면에서는 문제 하나가 왼쪽 단 아래에서 시작해 오른쪽 단 위로
 * 이어지는 경우가 흔하다. 그런 문제는 조각을 따로 잘라 세로로 이어 붙여야
 * 한 문제가 된다.
 */
/** `no`: luna 가 읽은 문제 번호(숫자만, 못 읽었으면 없음) — 지면 통째로 넣기가 번호를 Mathpix 로 다시 읽지 않고 이걸 쓴다. */
export type DetectedProblem = { boxes: ProblemBox[]; no?: string };

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * 쓸 모델. **사용자가 고른 것을 그대로 쓴다.**
 *
 * 한때 계정의 모델 목록에서 자동으로 골랐는데, 고른 모델이 이 일에 안 맞으면
 * 왜 실패하는지 알 수 없게 된다. 이름 하나로 못박아 두고 바꿔야 할 때는
 * `GEMINI_DETECT_MODEL` 로 바꾼다. 404 가 나면 그 이름을 그대로 알린다 —
 * 조용히 다른 모델로 갈아타지 않는다(고른 적 없는 모델에 요금이 나간 적이 있다).
 *
 * 한때 `-lite` 를 썼는데 되돌렸다 — 자리를 재는 일이라 값싼 등급으로도 될 줄
 * 알았지만, 좌표를 잡는 정확도가 아쉬웠다.
 */
export const DETECT_MODEL = process.env.GEMINI_DETECT_MODEL ?? "gemini-flash-latest";

const PROMPT = `task: page from Korean HS workbook/mock exam (수능·모의고사 style, often 2 columns). find the region of EACH individual question as precisely as you can.

procedure — think before answering:
1. look at the layout: how many columns, where is the gutter between them, where are the running head / page number / footer.
2. in reading order (left column top-to-bottom, then right column), find every printed question number (e.g. "12.", "13.") — each starts a new question.
3. for each question find: (a) its top = the line holding its number, (b) its bottom = the last line of its LAST choice (⑤) or its last figure/table/box line, (c) its left/right = the outermost text or figure of that question within its column.
4. verify before writing the box (see CHECK below).

question region must contain everything belonging to it:
- the question number (e.g. 12.) itself
- the whole stem, condition boxes, <보기> (ㄱㄴㄷ items), (가)(나) data, tables, graphs, maps, figures and their captions
- ALL choices: multiple choice has FIVE (①②③④⑤). They may be on one line, in two or three rows, in two columns of a grid, or far right/bottom on their own line — find all five. short-answer questions have no choices: then the last line of the stem/figure is the bottom.

edges — TIGHT but never clipping:
- fit each edge CLOSE to the content: top edge just above the number's line, bottom edge just below the last choice line (or last figure line), left/right just outside the outermost text of this question. leave about ONE text line of margin on every side (≈1.5% of the image) — measured errors show boxes are usually 1-3% too TIGHT, cutting the top/left/right of the question, so err outward; but do not pad all the way to the neighbouring question, the gutter or the page margin
- the edge must sit in blank space, never cut through a line of text; a cut-off last choice, a cut-off number or a sliced formula/figure is the worst mistake, but a box that swallows the blank gap or a neighbour's line is also wrong
- the neighbouring question's first line (starting with its own number) is NOT part of this one; the previous question's last choice line is NOT part of this one
- the left edge must include anything hanging into the left margin (question number, ㉠ markers, figures, tables, boxes): look at the leftmost ink of THIS question, not at the column's usual margin. same for the right: wide figures, tables and long choice lines can extend past the usual right edge
- tall figures/tables belonging to the question stay inside even if there is a lot of blank around them
- in a 2-column page keep each region inside its own column (do not extend across the gutter)
- COLUMN CONSISTENCY: questions in the same column usually share the same left and right edge (but a question whose content sticks out further wins — see above). left edge = just left of the printed question numbers of that column (numbers sit at the column's left margin); right edge = just right of the column's longest line. use the SAME xmin and xmax for every question of a column unless one question has a figure/table that sticks out further. do not let a box start in the middle of the column or stop before the right end of the longest text line
- vertical edges: ymin = just above the top of the number's line (do NOT include blank space above it); ymax = just below the last line. consecutive questions in a column should nearly touch (gap between box bottom and next box top = only the blank gap between them, split roughly in half)
- 1 region per question, non-overlapping
- CHECK each region before answering: (1) its printed number is inside; (2) count the choices inside — ALL five ①~⑤ for multiple choice; if you see fewer than five, look again below and to the right; (3) the last line of the stem and any figure/table are inside; (4) no line of the next question is inside; (5) top < bottom and left < right, and the region does not overlap another
- NEVER split 1 question into pieces: stem+condition box+data+choices = parts of 1 question. within single column = ONE region. only cross-column case (below) splits
- 2-column page -> order: left column top-to-bottom first, then right column
- exclude: running heads, page numbers, ads, solutions, answer keys, section titles that belong to no question (but a shared instruction line like "[1~3] 다음 글을 읽고 물음에 답하시오" that applies to the group is NOT part of any single question)

don't miss questions continuing across columns (matters most):
- new question ALWAYS starts with question number (e.g. "12.")
- block starting WITHOUT number (plain text or choice marker ①②③④⑤) = NOT new question, = rest of previous one
- right-column top starting without number -> left column's last question continues there
- in that case: each piece = own region, but SAME question number in \`no\` for both (use leading piece's number even if trailing piece shows none) -> lets us stitch into one question
- AND mark the trailing piece with "cont": true (it continues the question just before it in reading order). every other region has "cont": false
- check every column top: if it does not start with a printed number, it IS a continuation -> "cont": true
- continuation piece edges follow the same rule (tight, in blank space, never clip) -> pieces must join as if never separated

answer: JSON array only. write the fields of each item IN THIS ORDER (the first fields make you look before you measure):
{"no": "12", "first": "first ~6 chars after the number", "last": "last ~6 chars of the question's final line", "choices": 5, "box_2d": [ymin, xmin, ymax, xmax], "cont": false}
- first/last = the actual printed text at the top and bottom of THIS question; copy them from the image. the box must start at the line holding "first" and end at the line holding "last" — not above or below.
- choices = how many of ①~⑤ you counted inside the box (0 if short-answer). if it is 1-4, look again for the missing ones before answering.
coords are integers normalised 0-1000 of the whole image (0,0 = top-left; y first, then x). \`no\` = question number (digits only), empty if unknown. no explanation, no markdown fences.`;

type GeminiBox = { box_2d?: unknown; no?: unknown; label?: unknown; cont?: unknown };

/** 응답에서 배열을 뽑아 0~1 좌표로 바꾼다. 모양이 이상한 항목은 버린다. */
/** `box_2d`(0~1000 정규화) 하나를 0~1 상자로 바꾼다. 모양이 아니면 null. */
function toBox(raw: unknown): ProblemBox | null {
  const got = toBoxes([{ box_2d: raw }]);
  if (got.length === 0) return null;
  const { no: _no, ...box } = got[0];
  void _no;
  return box;
}

function toBoxes(raw: unknown): (ProblemBox & { no: string; cont?: boolean })[] {
  if (!Array.isArray(raw)) return [];
  // 일부 모델(Llama 비전 등)은 0~1000 이 아니라 0~1 로 좌표를 준다 — 모든 좌표가 1 이하면 그 배율로 읽는다.
  const nums = (raw as GeminiBox[]).flatMap((it) => (Array.isArray(it?.box_2d) ? (it.box_2d as unknown[]).map(Number) : []));
  const unit = nums.length > 0 && nums.every((n) => Number.isFinite(n) && n >= 0 && n <= 1.0001) && nums.some((n) => n > 0) ? 1000 : 1;
  if (unit === 1000) {
    raw = (raw as GeminiBox[]).map((it) =>
      Array.isArray(it?.box_2d) ? { ...it, box_2d: (it.box_2d as unknown[]).map((n) => Number(n) * 1000) } : it,
    );
  }
  const out: (ProblemBox & { no: string; cont?: boolean })[] = [];
  for (const item of raw as GeminiBox[]) {
    const b = item?.box_2d;
    if (!Array.isArray(b) || b.length !== 4) continue;
    const [ymin, xmin, ymax, xmax] = b.map((n) => Number(n));
    if (![ymin, xmin, ymax, xmax].every(Number.isFinite)) continue;
    const x = Math.min(xmin, xmax) / 1000;
    const y = Math.min(ymin, ymax) / 1000;
    const w = Math.abs(xmax - xmin) / 1000;
    const h = Math.abs(ymax - ymin) / 1000;
    // 너무 작은 것은 문제가 아니라 부스러기다(쪽번호·머리말 조각 등).
    if (w < 0.05 || h < 0.03) continue;
    // 번호는 숫자만 남긴다("12번", "12." 처럼 붙여 오는 경우가 있다).
    const no = String(item?.no ?? item?.label ?? "").replace(/[^0-9]/g, "");
    out.push({
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
      w: Math.min(w, 1 - Math.max(0, Math.min(1, x))),
      h: Math.min(h, 1 - Math.max(0, Math.min(1, y))),
      no,
      ...(item?.cont === true || item?.cont === "true" ? { cont: true } : {}),
    });
  }
  // 왼쪽 단 → 오른쪽 단, 각 단에서는 위에서 아래로. 모델이 순서를 지키지
  // 않는 경우가 있어 우리가 한 번 더 정렬한다(자른 결과가 문제 순서다).
  const mid = 0.5;
  return out.sort((a, b) => {
    const ca = a.x + a.w / 2 < mid ? 0 : 1;
    const cb = b.x + b.w / 2 < mid ? 0 : 1;
    return ca !== cb ? ca - cb : a.y - b.y;
  });
}

export class DetectError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DetectError";
  }
}

/**
 * 묶을 때 쓰는 기준들.
 *
 * **잘못 묶으면 문제가 사라진다**(같은 단이면 하나로 합쳐지므로). 못 묶으면
 * 조각 두 개로 남을 뿐이고 사용자가 눈으로 보고 지우면 된다. 그래서 기준은
 * 전부 **안 묶는 쪽으로 기울여** 잡는다.
 */
/** 같은 단에서 이어진 조각으로 볼 세로 간격(지면 높이 대비). */
const ADJACENT = 0.06;
/** 앞 조각이 단 아래까지 내려왔다고 볼 자리. */
const NEAR_BOTTOM = 0.85;
/** 이 조각이 단 맨 위에서 시작한다고 볼 자리. */
const NEAR_TOP = 0.15;

/** 같은 번호가 붙은 조각을 정말 이어 붙여도 되는가. */
function canJoin(target: DetectedProblem, box: ProblemBox): boolean {
  const last = target.boxes[target.boxes.length - 1];
  // 단이 다르면 단을 넘어간 것이다.
  if (columnOf(last) !== columnOf(box)) return true;
  // 같은 단이면 **붙어 있어야** 한 문제다. 멀리 떨어져 있으면 모델이 서로 다른
  // 문제에 같은 번호를 붙인 것이고, 그대로 합치면 사이에 있던 문제가 사라진다.
  return box.y - (last.y + last.h) < ADJACENT;
}

/**
 * 번호가 없는 조각이 **앞 문제가 단을 넘어온 것**인가.
 *
 * 새 문제는 반드시 번호로 시작하므로 번호가 없으면 앞 문제의 나머지다 —
 * 다만 그건 모델이 번호를 **읽었는데 안 적은** 경우에만 맞는 말이다. 번호를
 * 아예 안 적어 주는 모델도 있어서, 그때 이 규칙을 그대로 믿으면 오른쪽 단
 * 첫 문제가 통째로 앞 문제에 흡수돼 **사라진다**(실제로 그랬다).
 * 그래서 두 가지를 함께 본다:
 * ① **모델이 번호를 실제로 적어 주고 있어야 한다**(적어도 절반은). 아무 조각에도
 *    번호가 없다면 "번호가 없다"는 사실이 아무 뜻도 없기 때문이다 — 자리만으로는
 *    "단을 넘어온 뒷부분"과 "오른쪽 단의 첫 문제"를 구분할 방법이 없다(둘 다
 *    왼쪽은 바닥까지, 오른쪽은 꼭대기부터다).
 * ② 앞 조각이 단 아래까지 내려왔고 이 조각이 단 맨 위에서 시작해야 한다.
 */
function continuesAcrossColumn(prev: DetectedProblem, box: ProblemBox): boolean {
  const last = prev.boxes[prev.boxes.length - 1];
  if (columnOf(last) === columnOf(box)) return false;
  return last.y + last.h > NEAR_BOTTOM && box.y < NEAR_TOP;
}

/**
 * 조각들을 문제 단위로 묶는다.
 *
 * 묶는 근거는 두 가지다 — ① 같은 문제 번호, ② 번호가 없는데 단을 넘어온 자리.
 * 어느 쪽이든 위의 기준을 통과해야 한다. 묶음의 순서는 **첫 조각이 나온
 * 차례**다(자른 차례가 곧 문제 차례다).
 */
function group(boxes: (ProblemBox & { no: string; cont?: boolean })[]): DetectedProblem[] {
  const out: DetectedProblem[] = [];
  const byNo = new Map<string, DetectedProblem>();
  // 모델이 번호를 실제로 적어 주고 있는가. 아니면 "번호 없음"은 아무 뜻도 없다.
  const numbersUsable = boxes.filter((b) => b.no).length * 2 >= boxes.length;
  let prevColumn = -1;
  for (const { no, cont, ...box } of boxes) {
    const column = columnOf(box);
    const firstInColumn = column !== prevColumn;
    prevColumn = column;

    // **모델이 "앞 문제의 나머지"라고 표시한 조각**(`cont`, 2026-10-09 사용자 — "양단에 걸린 문제를 끌어와서 합치는 거까지")은
    // 단을 넘어온 자리면 앞 문제에 붙인다. 번호가 다르게 적혀 있으면(다른 문제다) 안 붙인다. 같은 단 안에서 cont 라고 하면 모델이
    // 헷갈린 것이라 아래의 보통 규칙에 맡긴다(같은 단이면 붙어 있을 때만 합친다).
    const prevP = out[out.length - 1];
    if (cont && prevP && firstInColumn && (!no || !prevP.no || no === prevP.no)) {
      const last = prevP.boxes[prevP.boxes.length - 1];
      if (columnOf(last) !== column) {
        prevP.boxes.push(box);
        continue;
      }
    }

    const sameNo = no ? byNo.get(no) : undefined;
    if (sameNo && canJoin(sameNo, box)) {
      sameNo.boxes.push(box);
      continue;
    }
    const prev = out[out.length - 1];
    if (!no && numbersUsable && firstInColumn && prev && continuesAcrossColumn(prev, box)) {
      prev.boxes.push(box);
      continue;
    }
    const made: DetectedProblem = no ? { boxes: [box], no } : { boxes: [box] };
    if (no) byNo.set(no, made);
    out.push(made);
  }
  return out.map(mergeWithinColumn);
}

/**
 * 한 문제 안에서 **같은 단에 있는 조각들은 하나로 합친다.**
 *
 * 이어 붙이기(`stitchVertically`)는 **단을 넘어간 경우에만** 쓸 물건이다.
 * 같은 단에서 위아래로 놓인 조각을 이어 붙이면, 조각마다 폭을 다시 맞추고
 * 사이에 띠를 넣는 바람에 원래 한 덩어리였던 것이 **잘렸다 붙인 티가 난다.**
 * 같은 단이면 그냥 **둘을 아우르는 네모 하나로 잘라내면** 원본 그대로다.
 *
 * (모델이 한 문제를 발문/자료/선지처럼 여러 조각으로 나눠 주는 일이 잦다.)
 */
function mergeWithinColumn(problem: DetectedProblem): DetectedProblem {
  return { ...problem, boxes: unionByColumn(problem.boxes) };
}

/** 모델이 돌려준 글에서 배열을 꺼내 묶는다. 두 갈래가 똑같이 쓴다. */
function parse(text: string): DetectedProblem[] {
  // 모델이 ```json 울타리로 감싸 주는 일이 흔하다.
  text = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const take = (raw: unknown) => {
    // `json_object` 를 강제하면 배열을 객체로 감싸 준다. 둘 다 받는다.
    if (Array.isArray(raw)) return raw;
    const o = raw as Record<string, unknown> | null;
    for (const k of ["problems", "boxes", "items", "regions"]) {
      if (o && Array.isArray(o[k])) return o[k];
    }
    return [];
  };
  try {
    return group(toBoxes(take(JSON.parse(text))));
  } catch {
    // 가끔 앞뒤에 설명을 붙여 준다. 배열만 도려내 다시 해 본다.
    const a = text.indexOf("[");
    const b = text.lastIndexOf("]");
    if (a === -1 || b <= a) throw new DetectError("영역을 읽지 못했습니다.", 502);
    try {
      return group(toBoxes(JSON.parse(text.slice(a, b + 1))));
    } catch {
      throw new DetectError("영역을 읽지 못했습니다.", 502);
    }
  }
}

/** 일꾼 프로브(`nvidia-scan`)가 실제 지면 지시문·해석으로 모델을 시험하려고 내보낸다. */
export const PAGE_PROMPT_FOR_PROBE = PROMPT;
export function parsePageForProbe(text: string): DetectedProblem[] {
  return parse(text);
}

/** Gemini 한 번 부르기. 프롬프트만 갈아 끼우면 다른 일에도 쓸 수 있다. */
async function callGemini(dataUrl: string, prompt: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new DetectError("GEMINI_API_KEY가 설정되지 않았습니다.", 500);
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new DetectError("이미지를 읽을 수 없습니다.", 400);

  const res = await fetch(`${ENDPOINT}/${DETECT_MODEL}:generateContent?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        { parts: [{ inline_data: { mime_type: m[1], data: m[2] } }, { text: prompt }] },
      ],
      // 자리를 재는 일이라 매번 같은 답이 나와야 한다.
      generationConfig: { responseMimeType: "application/json", temperature: 0 },
    }),
  });

  const body = await res.text();
  if (!res.ok) {
    // 조용히 다른 모델로 갈아타지 않는다 — 고른 적 없는 모델에 요금이 나간다.
    throw new DetectError(
      res.status === 404
        ? `모델 "${DETECT_MODEL}"을 찾을 수 없습니다. GEMINI_DETECT_MODEL 환경변수로 바꿔 주세요.`
        : `문제 영역 인식에 실패했습니다 (${DETECT_MODEL}, HTTP ${res.status}).`,
      res.status,
    );
  }
  try {
    return JSON.parse(body)?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  } catch {
    throw new DetectError("모델이 정상적인 응답을 주지 않았습니다.", 502);
  }
}

/**
 * Gemini 로 사진 한 장 + 지시를 보내고 JSON 글을 받는다(모델 이름을 받는다 — 자동 자르기가 쓴다, 2026-10-09). 토큰 수를 `onUsage` 로
 * 넘긴다(생각 토큰은 출력 단가라 출력에 더한다). **자리가 없다는 503·429 는 1초·3초 뒤 두 번 더 해 본다**(지문 인식 때 운영에서 503
 * "high demand" 가 실제로 났다). 404 면 그 이름을 그대로 알린다.
 */
export async function callGeminiVision(
  dataUrl: string,
  prompt: string,
  model: string,
  onUsage?: (u: DetectUsage) => void,
): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new DetectError("GEMINI_API_KEY가 설정되지 않았습니다.", 500);
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new DetectError("이미지를 읽을 수 없습니다.", 400);
  const body = JSON.stringify({
    contents: [{ parts: [{ inline_data: { mime_type: m[1], data: m[2] } }, { text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0 },
  });
  let last = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt === 1 ? 1000 : 3000));
    const res = await fetch(`${ENDPOINT}/${model}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const text = await res.text();
    if (!res.ok) {
      last = res.status;
      if (res.status === 503 || res.status === 429 || res.status >= 500) continue;
      throw new DetectError(
        res.status === 404
          ? `모델 "${model}"을 찾을 수 없습니다.`
          : `Gemini 호출 실패 (${model}, HTTP ${res.status}): ${text.slice(0, 200)}`,
        res.status,
      );
    }
    let json: {
      candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
        cachedContentTokenCount?: number;
      };
    };
    try {
      json = JSON.parse(text);
    } catch {
      throw new DetectError("모델이 정상적인 응답을 주지 않았습니다.", 502);
    }
    const u = json.usageMetadata;
    if (u && onUsage) {
      onUsage({
        input: u.promptTokenCount ?? 0,
        cached: u.cachedContentTokenCount ?? 0,
        output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
      });
    }
    return (json.candidates?.[0]?.content?.parts ?? [])
      .filter((p) => !p.thought)
      .map((p) => p.text ?? "")
      .join("");
  }
  throw new DetectError(`Gemini 가 지금 자리가 없어요 (${model}, HTTP ${last}).`, last || 503);
}

async function withGemini(dataUrl: string): Promise<{ problems: DetectedProblem[]; model: string }> {
  return { problems: parse(await callGemini(dataUrl, PROMPT)), model: DETECT_MODEL };
}

/**
 * 국어 지면에서 **지문 먼저, 문제는 따로** 찾는다(2026-09-25, 사용자 지시 —
 * "luna 가 네모 그릴 때 지문 먼저 인식하고 문제 인식해, 지문이랑 문제 같이 보지
 * 말고").
 *
 * 예전에는 한 번의 호출로 둘을 함께 잡았다(값이 반이다). 그런데 한꺼번에 보면
 * 모델이 둘의 경계를 서로 나눠 가지느라 지문 아래를 잘라 먹거나 선지 한 줄을
 * 지문에 붙이는 일이 잦았다. 지금은 ① 지문(과 그 안의 그림)만 보는 호출,
 * ② 문제만 보는 호출로 나눈다. ②에는 ①이 찾은 지문 자리를 알려 주어 그 자리를
 * 비켜 가게 한다.
 *
 * **지문 안의 그림도 ①이 함께 찾는다**(같은 날 사용자 지시 — "luna 가 지문
 * 영역에 그림이 있어요라고 sol 에게 알려 줘"). 그 자리를 잘라 지문 인식(sol)에
 * 함께 보내고, sol 이 그림이 들어갈 자리를 짚으면 sunburst 가 다시 그려 붙인다.
 *
 * 다각형으로 찾기는 걷어냈다(같은 지시 — "다각형은 없애").
 */
export const KOREAN_PASSAGE_PROMPT = `task: page from Korean SAT (수능) 국어 영역 paper. find ONLY the PASSAGE regions (지문), plus every PICTURE printed inside a passage. ignore the questions completely.

passage:
- whole text body shared by several questions (non-fiction/literary work, incl. any 보기 material belonging to the passage)
- lead-in line e.g. "[1~3] 다음 글을 읽고 물음에 답하시오." -> start FROM that line
- several texts grouped as (가)(나) -> take TOGETHER as one region
- literature -> include trailing attribution (- 작자, 「작품명」)
- stop where the first question (its number, e.g. "1.") begins — never include question stems or choices
- passage continuing across columns -> one region per piece

figure (inside a passage only):
- a picture, diagram, graph, chart, map, photo, drawing, or a table printed as a graphic — anything that is not running text
- NOT a figure: plain text, a bordered text box / <보기> made only of text, section markers, underlines
- box hugs the picture including its own labels, legend and caption
- none -> "figures":[]

both:
- put edges in the blank gap just outside the content — NEVER clip a line (we trim blank space ourselves). exclude gutter, running heads, page numbers
- 2-column page -> order: left column top-to-bottom first, then right column

answer JSON only:
{"passages":[{"box_2d":[ymin,xmin,ymax,xmax]}],"figures":[{"box_2d":[ymin,xmin,ymax,xmax]}]}
coords normalised 0-1000. no explanation.`;

export const KOREAN_QUESTION_PROMPT = `task: page from Korean SAT (수능) 국어 영역 paper. find ONLY the QUESTION regions (문항). passages (지문) are handled separately — ignore them.

question:
- one item at a time: from its number (e.g. 12.) to the last line of its choices (①②③④⑤)
- stem + <보기> box + choices = parts of one item, don't split
- an item continuing across columns -> one region per piece, same \`no\`

both:
- put edges in the blank gap just outside the content — NEVER clip a line (we trim blank space ourselves). exclude gutter, running heads, page numbers
- regions must not overlap
- 2-column page -> order: left column top-to-bottom first, then right column

answer JSON only:
{"questions":[{"box_2d":[ymin,xmin,ymax,xmax],"no":"12"}]}
coords normalised 0-1000. \`no\` = item number (digits only). no explanation.`;

/** 문제 찾기 프롬프트 — 앞서 찾은 지문 자리를 알려 주어 비켜 가게 한다. */
export function koreanQuestionPrompt(passages: ProblemBox[]): string {
  if (passages.length === 0) return KOREAN_QUESTION_PROMPT;
  const r = (v: number) => Math.round(v * 1000);
  const list = passages
    .map((b) => `[${r(b.y)},${r(b.x)},${r(b.y + b.h)},${r(b.x + b.w)}]`)
    .join(", ");
  return `${KOREAN_QUESTION_PROMPT}

already-identified PASSAGE regions on this page (box_2d) — never include any part of these: ${list}`;
}

export type DetectedKoreanRegion = {
  kind: "passage" | "question";
  box: ProblemBox;
  /** 어느 지문에 딸렸는지. 지금은 따로 찾으므로 늘 0 이다(옛 모양을 위해 남긴다). */
  set: number;
  no: number | null;
};

/** 지문 찾기 결과. 그림은 지면 좌표(0~1)다. */
export type DetectedKoreanPassages = {
  passages: DetectedKoreanRegion[];
  figures: ProblemBox[];
};

/** 영역 찾기 한 번에 쓴 토큰(입력 전체 · 그중 캐시 · 출력). luna 갈래에서만 온다 — 원가 장부에 적는다. */
export type DetectUsage = { input: number; cached: number; output: number; /** 오픈라우터가 응답에 실어 준 실제 청구액(USD). */ costUsd?: number };

async function callDetect(dataUrl: string, prompt: string): Promise<{ text: string; model: string; usage?: DetectUsage }> {
  if (DETECT_PROVIDER === "gemini") {
    return { text: await callGemini(dataUrl, prompt), model: DETECT_MODEL };
  }
  let usage: DetectUsage | undefined;
  const text = await callOpenAIVision(dataUrl, prompt, OPENAI_DETECT_MODEL, OPENAI_DETECT_EFFORT, (u) => {
    usage = u;
  });
  return { text, model: DETECT_OPENAI_LABEL, usage };
}

export async function detectKoreanPassages(
  dataUrl: string,
): Promise<DetectedKoreanPassages & { model: string; usage?: DetectUsage }> {
  const { text, model, usage } = await callDetect(dataUrl, KOREAN_PASSAGE_PROMPT);
  return { ...parseKoreanPassages(text), model, usage };
}

export async function detectKoreanQuestions(
  dataUrl: string,
  passages: ProblemBox[] = [],
): Promise<{ regions: DetectedKoreanRegion[]; model: string; usage?: DetectUsage }> {
  const { text, model, usage } = await callDetect(dataUrl, koreanQuestionPrompt(passages));
  return { regions: parseKoreanQuestions(text), model, usage };
}

function readJsonObject(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a === -1 || b <= a) throw new DetectError("영역을 읽지 못했습니다.", 502);
    try {
      return JSON.parse(text.slice(a, b + 1)) as Record<string, unknown>;
    } catch {
      throw new DetectError("영역을 읽지 못했습니다.", 502);
    }
  }
}

/** 그림 네모. 지문·문제보다 작을 수 있어 부스러기 기준을 낮춰 읽는다. */
function toFigureBox(raw: unknown): ProblemBox | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const [ymin, xmin, ymax, xmax] = raw.map((n) => Number(n));
  if (![ymin, xmin, ymax, xmax].every(Number.isFinite)) return null;
  const clamp = (v: number) => Math.min(1, Math.max(0, v / 1000));
  const x = clamp(Math.min(xmin, xmax));
  const y = clamp(Math.min(ymin, ymax));
  const w = clamp(Math.max(xmin, xmax)) - x;
  const h = clamp(Math.max(ymin, ymax)) - y;
  if (w < 0.02 || h < 0.015) return null;
  return { x, y, w, h };
}

export function parseKoreanPassages(text: string): DetectedKoreanPassages {
  const o = readJsonObject(text);
  const list = Array.isArray(o.passages) ? o.passages : Array.isArray(o.regions) ? o.regions : [];
  const passages: DetectedKoreanRegion[] = [];
  for (const row of list) {
    const box = toBox((row as { box_2d?: unknown })?.box_2d);
    if (box) passages.push({ kind: "passage", box, set: 0, no: null });
  }
  const figures: ProblemBox[] = [];
  for (const row of Array.isArray(o.figures) ? o.figures : []) {
    const box = toFigureBox((row as { box_2d?: unknown })?.box_2d);
    if (box) figures.push(box);
  }
  if (passages.length === 0) throw new DetectError("지문을 찾지 못했습니다.", 502);
  return { passages, figures };
}

export function parseKoreanQuestions(text: string): DetectedKoreanRegion[] {
  const o = readJsonObject(text);
  const list = Array.isArray(o.questions) ? o.questions : Array.isArray(o.regions) ? o.regions : [];
  const out: DetectedKoreanRegion[] = [];
  for (const row of list) {
    const r = row as { box_2d?: unknown; no?: unknown };
    const box = toBox(r.box_2d);
    if (!box) continue;
    const no = Number(String(r.no ?? "").replace(/[^\d]/g, ""));
    out.push({ kind: "question", box, set: 0, no: Number.isFinite(no) && no > 0 ? no : null });
  }
  if (out.length === 0) throw new DetectError("문제를 찾지 못했습니다.", 502);
  return out;
}

const OPENAI_MODELS = "https://api.openai.com/v1/models";
const OPENAI_RESPONSES = "https://api.openai.com/v1/responses";
const OPENAI_CHAT = "https://api.openai.com/v1/chat/completions";

/**
 * 쓸 GPT 모델 — 앱이 "luna" 라고 부르는 것 전부(영역 찾기·채점·답지 읽기·
 * 제목 짓기)가 이 값 하나를 쓴다.
 *
 * `gpt-6-luna`(2026-09-25, 사용자 지시 — "루나 쓰는 거 다 gpt 6 luna 로").
 * **이름은 짐작하지 않고 계정의 `/v1/models` 목록에서 확인했다** — 일꾼
 * 라우트의 `probe: "models"` 로 봤고 `gpt-6-luna`·`gpt-6-sol`·`gpt-6-astra` 가
 * 있었다. `probe: "vision"` 으로 우리 요청 모양(사진 + JSON 응답, Responses
 * API)도 받는 것을 확인했다(64×64 그림, 4초). 예전 값은 `gpt-5.6-luna` 다. 되돌리려면 재배포 없이
 * `OPENAI_DETECT_MODEL` 을 넣는다. 비슷해 보이는 다른 모델로 몰래 갈아타지는
 * 않는다 — 고른 적 없는 모델에 요금이 나간 적이 있다.
 */
export const OPENAI_DETECT_MODEL = process.env.OPENAI_DETECT_MODEL ?? "gpt-6-luna";

/**
 * **영역 찾기의 추론 강도**(`reasoning.effort`). 기본 `high`(2026-09-30 사용자 — "luna 오릴 때 미디움 말고 high 로"; 그 전엔 medium). 2026-09-25 처음엔
 * `xhigh` 로 올렸다가("지문 영역 설정이랑 문제 자르는 거 전부 luna6 xhigh 가"),
 * 비교 화면에서 강도별로 돌려 본 뒤 사용자가 medium 으로 정했다("자리 잡는
 * 거는 luna medium 으로 가고"). gpt-6-luna 가 받는 값은
 * none·minimal·low·medium·high·xhigh·max 다(probe 로 확인).
 *
 * **영역 찾기에만 건다** — 채점·답지·제목 짓기는 같은 모델이라도 강도를 안
 * 올린다(요청받은 범위가 아니고, 생각 토큰은 출력 단가로 나간다). 재배포 없이
 * `OPENAI_DETECT_EFFORT` 로 바꾼다(`default` 를 넣으면 강도를 안 보내 모델 기본값이 된다).
 */
export const OPENAI_DETECT_EFFORT = (() => {
  const v = (process.env.OPENAI_DETECT_EFFORT ?? "high").trim();
  return v === "" || v === "default" ? undefined : v;
})();

/** 화면에 찍을 이름 — 어느 강도로 잡았는지까지 보여야 결과를 견줄 수 있다. */
const DETECT_OPENAI_LABEL = OPENAI_DETECT_EFFORT
  ? `${OPENAI_DETECT_MODEL} (${OPENAI_DETECT_EFFORT})`
  : OPENAI_DETECT_MODEL;

/** 404 가 났을 때, 이 계정이 실제로 가진 이름들을 붙여 준다(목록 조회는 무료). */
async function explain404(key: string, model: string): Promise<string> {
  try {
    const res = await fetch(OPENAI_MODELS, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return "";
    const ids: string[] = ((await res.json())?.data ?? [])
      .map((m: { id?: string }) => String(m.id ?? ""))
      .filter((id: string) => id.startsWith("gpt"))
      .sort();
    const near = ids.filter((id) => id.includes(model.split("-")[1] ?? ""));
    const show = (near.length ? near : ids).slice(0, 25);
    return show.length ? ` 이 계정의 gpt 계열: ${show.join(", ")}` : "";
  } catch {
    return "";
  }
}

/** 응답에서 글자만 긁어모은다(Responses API 는 여러 조각으로 나눠 준다). */
function harvest(json: unknown): string {
  const o = json as Record<string, unknown>;
  if (typeof o?.output_text === "string") return o.output_text;
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    const n = v as Record<string, unknown>;
    if (typeof n.text === "string") out.push(n.text);
    walk(n.content);
    walk(n.output);
  };
  walk(o?.output);
  return out.join("");
}

/**
 * GPT 비전 모델을 한 번 부르고 글자만 돌려준다. 프롬프트만 갈아 끼우면 영역
 * 찾기(문제)와 국어(지문+문제)에 똑같이 쓴다 — `callGemini` 와 같은 모양이다.
 */
export async function callOpenAIVision(
  dataUrl: string,
  prompt: string,
  model: string = OPENAI_DETECT_MODEL,
  /** 추론 강도(`reasoning.effort`). 없으면 모델 기본값. 영역 찾기와 probe 가 넘긴다. */
  effort?: string,
  /** 쓴 토큰을 알려 준다(원가 장부용). 응답에 usage 가 없으면 안 부른다. */
  onUsage?: (u: DetectUsage) => void,
): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new DetectError("OPENAI_API_KEY가 설정되지 않았습니다.", 500);
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };

  // **먼저 Responses API 로 부른다.** 요즘 모델은 이쪽만 받는 경우가 있다.
  // 안 받으면 Chat Completions 로 내려간다 — 이건 **같은 모델을 다른 길로**
  // 부르는 것이라, 고른 적 없는 모델로 갈아타는 것과는 다른 이야기다.
  let res = await fetch(OPENAI_RESPONSES, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            // 좌표를 재야 하므로 이미지를 흐리게 보면 안 된다.
            { type: "input_image", image_url: dataUrl, detail: "high" },
          ],
        },
      ],
      text: { format: { type: "json_object" } },
      ...(effort ? { reasoning: { effort } } : {}),
    }),
  });
  let body = await res.text();
  let viaResponses = true;

  // 추론 강도를 확인하는 중이면 거부된 이유를 그대로 봐야 한다 — Chat 으로
  // 내려가면 그 파라미터 없이 성공해 버려 "받는다"로 잘못 읽힌다.
  if (!res.ok && res.status !== 404 && !effort) {
    // 파라미터를 안 받는 경우 등. 같은 모델을 옛 길로 한 번 더 불러 본다.
    res = await fetch(OPENAI_CHAT, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
            ],
          },
        ],
        response_format: { type: "json_object" },
      }),
    });
    body = await res.text();
    viaResponses = false;
  }

  if (!res.ok) {
    const extra = res.status === 404 ? await explain404(key, model) : ` ${body.slice(0, 200)}`;
    throw new DetectError(
      res.status === 404
        ? `모델 "${model}"을 찾을 수 없습니다. OPENAI_DETECT_MODEL 로 바꿔 주세요.${extra}`
        : `문제 영역 인식에 실패했습니다 (${model}, HTTP ${res.status}).${extra}`,
      res.status,
    );
  }

  try {
    const json = JSON.parse(body);
    const u = json?.usage;
    if (onUsage && u) {
      onUsage({
        input: u.input_tokens ?? u.prompt_tokens ?? 0,
        output: u.output_tokens ?? u.completion_tokens ?? 0,
        cached: u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
      });
    }
    return viaResponses ? harvest(json) : (json?.choices?.[0]?.message?.content ?? "");
  } catch {
    throw new DetectError("모델이 정상적인 응답을 주지 않았습니다.", 502);
  }
}

/**
 * 지면 영역 찾기의 추론 강도(2026-10-09, 기본 medium — 사용자 "자동 자르기 너무 오래 걸리고"). 지면에서는 어느 문제가 어디쯤인지만
 * 맞으면 된다 — 테두리는 문제마다 확대해 다시 맞추는 단계(`pageRefine.ts`)와 `snapBoxes` 가 정한다. 국어 지문·문제 자리는 그런 단계가
 * 없어 `OPENAI_DETECT_EFFORT`(high) 그대로다. 재배포 없이 `OPENAI_PAGE_DETECT_EFFORT`.
 */
const OPENAI_PAGE_DETECT_EFFORT = (() => {
  const v = (process.env.OPENAI_PAGE_DETECT_EFFORT ?? "medium").trim();
  return v === "" || v === "default" ? undefined : v;
})();

/**
 * **지면 자르기는 Gemini 가 먼저 찾는다**(2026-10-09, 사용자 — "자동 자르기 3.5 flash lite 시켜보자"·"지면 자르기를 얘기한 거임").
 * 이름은 계정 목록(`probe: "gemini-models"`)에서 확인했다. 실패하면(자리 없음·오류·못 읽음) luna 로 넘어간다 — 어느 쪽이 했는지는
 * `model` 로 화면에 찍힌다. 끄려면 재배포 없이 `PAGE_GEMINI_MODEL=off`, 다른 Gemini 는 이름을 넣는다.
 */
export const PAGE_GEMINI_MODEL = (() => {
  const v = (process.env.PAGE_GEMINI_MODEL ?? "gemini-3.5-flash-lite").trim();
  return v === "" || v === "off" || !process.env.GEMINI_API_KEY ? null : v;
})();

async function withPageGemini(
  dataUrl: string,
  model: string,
): Promise<{ problems: DetectedProblem[]; model: string; usage?: DetectUsage }> {
  let usage: DetectUsage | undefined;
  const text = await callGeminiVision(dataUrl, PROMPT, model, (u) => {
    usage = u;
  });
  return { problems: parse(text), model, usage };
}

/** OpenRouter 모델 하나로 지면 영역 찾기(비교 화면용 — 2026-10-09). 느린 무료 모델이 있어 120초까지 기다린다. */
async function withPageOpenRouter(
  dataUrl: string,
  model: string,
  effort?: string,
): Promise<{ problems: DetectedProblem[]; model: string; usage?: DetectUsage }> {
  let usage: DetectUsage | undefined;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 120_000);
  try {
    const text = await callOpenRouterVision(dataUrl, PROMPT, model, (u) => (usage = u), 4096, ac.signal, effort);
    try {
      return { problems: parse(text), model: effort ? `${model} (${effort})` : model, usage };
    } catch (err) {
      // 어떤 글을 줬는지 보여야 고칠 수 있다(예전엔 "영역을 읽지 못했습니다"만 나왔다).
      const why = text ? `모델 글: ${text.slice(0, 300).replace(/\s+/g, " ")}` : "모델이 빈 글을 돌려줌";
      throw new Error(`${err instanceof Error ? err.message : err} · ${why}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function withOpenAI(
  dataUrl: string,
  effort: string | undefined = OPENAI_PAGE_DETECT_EFFORT,
): Promise<{ problems: DetectedProblem[]; model: string; usage?: DetectUsage }> {
  let usage: DetectUsage | undefined;
  const text = await callOpenAIVision(
    dataUrl,
    `${PROMPT}\n\nanswer as JSON object: {"problems": [...]}`,
    OPENAI_DETECT_MODEL,
    effort,
    (u) => {
      usage = u;
    },
  );
  const label = effort ? `${OPENAI_DETECT_MODEL} (${effort})` : OPENAI_DETECT_MODEL;
  return { problems: parse(text), model: label, usage };
}

/**
 * 어느 갈래로 부를지. **기본은 GPT(luna)** 다(2026-09-25, 사용자 지시 — "자리
 * 잡는 것도 이제 얘가 하게 해 줘"). 예전 기본은 Gemini 였다 — 좌표를 재는 일에
 * 맞춰 훈련된 `box_2d` 규격이 있어서다. 되돌리려면 재배포 없이
 * `DETECT_PROVIDER=gemini` 를 넣으면 된다(모델은 `GEMINI_DETECT_MODEL`).
 * 응답 형식과 뒤처리는 두 갈래가 완전히 같다.
 */
export const DETECT_PROVIDER = process.env.DETECT_PROVIDER === "gemini" ? "gemini" : "openai";

/**
 * **지면 자르기는 하이쿠(오픈라우터)가 먼저 찾는다**(2026-10-09, 사용자 — "하이쿠로 확정하고 추론강도를 올려보자"). 비교 화면에서 1위였다.
 * 실패하면 Gemini → luna 로 넘어간다. 끄려면 재배포 없이 `PAGE_OPENROUTER_MODEL=off`, 다른 모델은 이름을 넣는다.
 * 추론 강도는 `PAGE_OPENROUTER_EFFORT`(low|medium|high|xhigh, 기본 default = 안 보냄).
 */
export const PAGE_OPENROUTER_MODEL = (() => {
  const v = (process.env.PAGE_OPENROUTER_MODEL ?? "anthropic/claude-haiku-5.5").trim();
  return v === "" || v === "off" || !(process.env.OPENROUTER_KEY || process.env.OPENROUTER_API_KEY) ? null : v;
})();
const PAGE_OPENROUTER_EFFORT = (() => {
  const v = (process.env.PAGE_OPENROUTER_EFFORT ?? "default").trim();
  return v === "" || v === "default" ? undefined : v;
})();

export async function detectProblems(
  dataUrl: string,
  /** 비교 화면용: 이 모델 하나로만(실패해도 안 넘어간다). */
  only?: { engine: "gemini" | "openai" | "openrouter"; model: string; effort?: string },
): Promise<{ problems: DetectedProblem[]; model: string; usage?: DetectUsage }> {
  if (only) {
    if (only.engine === "gemini") return withPageGemini(dataUrl, only.model);
    if (only.engine === "openrouter") return withPageOpenRouter(dataUrl, only.model, only.effort);
    return withOpenAI(dataUrl, only.effort);
  }
  if (DETECT_PROVIDER !== "openai") return withGemini(dataUrl);
  if (PAGE_OPENROUTER_MODEL) {
    try {
      const r = await withPageOpenRouter(dataUrl, PAGE_OPENROUTER_MODEL, PAGE_OPENROUTER_EFFORT);
      if (r.problems.length > 0) return r;
      console.warn(`[detect] ${PAGE_OPENROUTER_MODEL} 가 문제를 하나도 못 찾음 → 다음`);
    } catch (err) {
      console.warn(`[detect] ${PAGE_OPENROUTER_MODEL} 실패 → 다음:`, err instanceof Error ? err.message : err);
    }
  }
  if (PAGE_GEMINI_MODEL) {
    try {
      const r = await withPageGemini(dataUrl, PAGE_GEMINI_MODEL);
      if (r.problems.length > 0) return r;
      console.warn(`[detect] ${PAGE_GEMINI_MODEL} 가 문제를 하나도 못 찾음 → luna`);
    } catch (err) {
      console.warn(`[detect] ${PAGE_GEMINI_MODEL} 실패 → luna:`, err instanceof Error ? err.message : err);
    }
  }
  return withOpenAI(dataUrl);
}
