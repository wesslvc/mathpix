// **luna 로 빠르게 보는 두 가지**(2026-10-04, 사용자 — "이미지 업로드하자마자 luna low 가 자동 자르기해 주고, luna 가 대충
// 봤을 때 그리기 어려울 것 같으면 medium 부터 AI 생성 시작하고, 개어려울 것 같으면(매우 세밀한 그래프나 매우 많은 손글씨)
// high 부터, 텍스트 위주고 원문자 적고 low 로도 성공할 것 같으면 low 스타트해서 최대한 비용 절감을 노리자. luna medium 이
// AI 생성 버튼을 누르면 검수해서 보내는 거지"). **서버 전용.**
//
//   ① `cropOneProblem` — 사진 한 장에서 문제 하나의 자리(luna, 추론 강도 low). 업로드 직후 화면이 부른다(`crop` 작업).
//   ② `assessDifficulty` — 문제 통째로 그리기를 **어느 quality 부터** 시작할지(luna, 추론 강도 medium). 그리기 작업의 첫
//      단계(`problemLoopRun.ts` 의 `assess`)가 부른다.
//
// 둘 다 서버 키로 부른다(BYOK 계정도) — 값이 몇 원이고 우리 쪽 판단이라서다. 원가는 부르는 쪽이 장부에 적는다.

import { callOpenAIVision, OPENAI_DETECT_MODEL, type DetectUsage } from "./detectProblems";
import type { ProblemBox } from "./problemBoxes";

/** 자동 자르기의 추론 강도. 재배포 없이 `OPENAI_CROP_EFFORT`(기본 high — 사용자 "luna 가 매우 정확하게", `default` 면 안 보냄). */
const CROP_EFFORT = (() => {
  const v = (process.env.OPENAI_CROP_EFFORT ?? "high").trim();
  return v === "" || v === "default" ? undefined : v;
})();

/** 난이도 판단의 추론 강도. 재배포 없이 `OPENAI_ASSESS_EFFORT`(기본 medium, `default` 면 안 보냄). */
const ASSESS_EFFORT = (() => {
  const v = (process.env.OPENAI_ASSESS_EFFORT ?? "medium").trim();
  return v === "" || v === "default" ? undefined : v;
})();

const CROP_PROMPT = `A student photographed a page of a Korean exam/workbook to save ONE problem they got wrong.
Find that problem and return the box that encloses ALL of it: the problem number, the question stem, any
condition box / <보기> box, figures, graphs, tables, maps, and the answer choices (①~⑤) or answer blank.

- If the photo shows exactly one problem (or one problem fills most of it), box that problem.
- If several problems are visible, pick the most complete one closest to the centre of the photo.
- Exclude everything else: page headers and footers, page numbers, neighbouring problems (even partly cut ones),
  the desk / background outside the paper, the paper edge, fingers, shadows.
- Keep the box tight to the printed content (no wide empty margins), but never cut through any line of text,
  a figure, or the choices. Handwriting inside the problem area may be included; handwriting far outside is not part of it.

CHECK BEFORE YOU ANSWER — the most common mistake is cutting off the problem number or the last choices:
1. Locate the printed problem number (e.g. "17.", "03", a number in a small box) at the start of the problem.
   Give its own box in "number". Your main box MUST contain it completely.
2. Locate EVERY answer choice. Multiple-choice problems have FIVE (① ② ③ ④ ⑤); they may be on one line, two lines,
   in two columns, or one per line, and the last ones are often at the very bottom or far right — look there.
   Give one box per choice in "choices", each covering the marker AND the whole choice text/formula/figure after it.
   Your main box MUST contain all of them completely. If you found fewer than five, look again before answering.
   If the problem has no choices (short-answer), "choices" is [].
3. The main box must also contain the last line of the stem and any figure/table below it.
- Coordinates: every box is [ymin, xmin, ymax, xmax], each normalised to 0~1000 of the photo.

ALSO TELL US (the student will not have to do these by hand):
- "rotate": how many quarter turns CLOCKWISE (0, 1, 2 or 3) the photo must be turned so the printed text reads upright.
  0 if it is already upright. Photos taken sideways are common (text running top-to-bottom → 1 or 3; upside down → 2).
  Box coordinates always refer to the photo AS GIVEN (not rotated).
- "advice": what to do with this problem image —
  "asis"   = the printed problem is already clean enough to print as it is: flat, sharp, good contrast, little or no handwriting
             or pen marks over the problem area, no strong shadow.
  "redraw" = it should be redrawn cleanly: handwriting / pen or pencil marks / circled answers over the problem, strong shadow
             or uneven lighting, blur, curled or skewed paper, low contrast, or stains.
  "advice_reason": one short Korean phrase for the student (e.g. "깨끗한 인쇄", "손글씨가 많음", "그림자·기울어짐").

answer as JSON object only:
{"box_2d":[ymin,xmin,ymax,xmax],"number":{"text":"17.","box_2d":[...]},"choices":[{"label":"①","box_2d":[...]},...],"rotate":0,"advice":"asis","advice_reason":"깨끗한 인쇄"}
— "number" is null if no printed number is visible; {"box_2d":null} if no problem is visible.`;

/** luna 가 짚은 "꼭 들어가야 할 것"(번호·선지)과 함께 돌려주는 자리. `keep` 은 화면이 글자에 맞춰 다듬은 뒤에도 꼭 품는다. */
export type CropBox = ProblemBox & { keep?: ProblemBox[] };

export interface CropFinding {
  box: CropBox | null;
  /** luna 가 읽은 번호 글자(못 봤으면 없음). */
  number?: string;
  /** 찾은 선지 수. */
  choices: number;
  /** 글자가 똑바로 서려면 시계 방향으로 몇 번(90°) 돌려야 하는지(0~3). */
  rotate?: number;
  /** luna 의 추천 — 원본 그대로(asis) / 깨끗하게 다시 그리기(redraw). */
  advice?: "asis" | "redraw";
  adviceReason?: string;
}

/** 사진 한 장에서 문제 하나의 자리(0~1). 못 찾으면 box 가 null. */
export async function cropOneProblem(
  dataUrl: string,
): Promise<CropFinding & { model: string; usage?: DetectUsage; retried: boolean }> {
  const total: DetectUsage = { input: 0, cached: 0, output: 0 };
  const add = (u: DetectUsage) => {
    total.input += u.input;
    total.cached += u.cached;
    total.output += u.output;
  };
  let first = parseCrop(await callOpenAIVision(dataUrl, CROP_PROMPT, OPENAI_DETECT_MODEL, CROP_EFFORT, add));
  let retried = false;
  // 선지를 일부만 찾았으면(1~4개) 한 번 더 — 대개 맨 아래·오른쪽 선지를 놓친 경우다.
  if (first.box && first.choices > 0 && first.choices < 5) {
    retried = true;
    const again = parseCrop(
      await callOpenAIVision(
        dataUrl,
        `${CROP_PROMPT}\n\nA previous look found only ${first.choices} of the five choices (${first.choices} boxes). The missing ones are almost always below or to the right of the found ones — find all five this time and make the main box contain them.`,
        OPENAI_DETECT_MODEL,
        CROP_EFFORT,
        add,
      ),
    );
    if (again.box && again.choices >= first.choices) first = again;
  }
  return { ...first, model: OPENAI_DETECT_MODEL, usage: total.input || total.output ? total : undefined, retried };
}

function toBox(b: unknown): ProblemBox | null {
  if (!Array.isArray(b) || b.length !== 4) return null;
  const [ymin, xmin, ymax, xmax] = b.map((n) => Number(n));
  if (![ymin, xmin, ymax, xmax].every(Number.isFinite)) return null;
  const c = (v: number) => Math.max(0, Math.min(1, v / 1000));
  const x0 = c(Math.min(xmin, xmax));
  const x1 = c(Math.max(xmin, xmax));
  const y0 = c(Math.min(ymin, ymax));
  const y1 = c(Math.max(ymin, ymax));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * 자동 자르기 응답 → 자리. **번호·선지 자리는 본 자리 안으로 끌어들인다**(합집합) — luna 가 본 자리를 좁게 잡아도 스스로 짚은
 * 번호·선지는 잘리지 않게. 본 자리보다 멀리(사진의 25% 넘게) 떨어진 것은 옆 문제를 짚은 것으로 보고 안 넣는다.
 */
export function parseCrop(text: string): CropFinding {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return { box: null, choices: 0 };
  }
  const o = (raw ?? {}) as { box_2d?: unknown; number?: { text?: unknown; box_2d?: unknown } | null; choices?: unknown };
  const main = toBox(o.box_2d);
  // 너무 작으면 문제가 아니라 부스러기다.
  if (!main || main.w < 0.08 || main.h < 0.04) return { box: null, choices: 0 };
  const near = (b: ProblemBox) =>
    b.x < main.x + main.w + 0.25 && b.x + b.w > main.x - 0.25 && b.y < main.y + main.h + 0.25 && b.y + b.h > main.y - 0.25;
  const keep: ProblemBox[] = [];
  const nb = o.number && typeof o.number === "object" ? toBox(o.number.box_2d) : null;
  if (nb && near(nb)) keep.push(nb);
  let choices = 0;
  if (Array.isArray(o.choices)) {
    for (const c of o.choices.slice(0, 8)) {
      const cb = toBox((c as { box_2d?: unknown })?.box_2d);
      if (cb && near(cb)) {
        keep.push(cb);
        choices++;
      }
    }
  }
  let x0 = main.x, y0 = main.y, x1 = main.x + main.w, y1 = main.y + main.h;
  for (const k of keep) {
    x0 = Math.min(x0, k.x);
    y0 = Math.min(y0, k.y);
    x1 = Math.max(x1, k.x + k.w);
    y1 = Math.max(y1, k.y + k.h);
  }
  const number = o.number && typeof o.number.text === "string" ? o.number.text.trim().slice(0, 12) : undefined;
  const extra = raw as { rotate?: unknown; advice?: unknown; advice_reason?: unknown };
  const r = Math.round(Number(extra.rotate));
  const rotate = Number.isFinite(r) && r >= 0 && r <= 3 ? r : 0;
  const advice = extra.advice === "asis" || extra.advice === "redraw" ? extra.advice : undefined;
  const adviceReason = typeof extra.advice_reason === "string" ? extra.advice_reason.trim().slice(0, 40) : undefined;
  return {
    box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0, ...(keep.length ? { keep } : {}) },
    number: number || undefined,
    choices,
    rotate,
    ...(advice ? { advice } : {}),
    ...(adviceReason ? { adviceReason } : {}),
  };
}

/** `{"box_2d":[…]}` → 0~1 상자. 모양이 이상하거나 너무 작으면 null(그때는 화면이 제 계산을 쓴다). */
export function parseBox(text: string): ProblemBox | null {
  const box = parseCrop(text).box;
  if (!box) return null;
  return { x: box.x, y: box.y, w: box.w, h: box.h };
}

/** 번호 자리 찾기의 추론 강도. 재배포 없이 `OPENAI_NUMBER_EFFORT`(기본 low — 쉬운 일이다, `default` 면 안 보냄). */
const NUMBER_EFFORT = (() => {
  const v = (process.env.OPENAI_NUMBER_EFFORT ?? "low").trim();
  return v === "" || v === "default" ? undefined : v;
})();

const NUMBER_PROMPT = `This image is ONE exam problem (Korean exam/workbook). Find the PRINTED problem number that starts the problem —
e.g. "17.", "3.", "112.", "05", "[22]", a number in a small box or circle tag — usually at the top-left, right before the question text.

- Return the box that tightly encloses ONLY that number and its punctuation (period, bracket, box/tag border). Do not include the
  question text after it.
- Almost every problem here HAS a printed number. Look carefully at the top-left corner — it can be small, bold, a different font,
  inside a small box/circle tag, or slightly separated from the text. Return null only when you are sure there is none (the
  problem begins directly with text such as "밑줄 친 ㉠…" or "가. …"). Choice markers (①~⑤), page numbers, and numbers inside the question are NOT the problem number.
- Coordinates: box_2d = [ymin, xmin, ymax, xmax], each normalised to 0~1000 of the image.

- "text": the number exactly as printed, including its punctuation (e.g. "17.", "05", "[22]").

answer as JSON object only: {"box_2d":[ymin,xmin,ymax,xmax],"text":"17."}  — or {"box_2d":null}.`;

/** 문제 그림에서 인쇄된 문제 번호의 자리(0~1). 없으면 box 가 null. 여러 실모를 묶어 1번부터 다시 매길 때 쓴다. */
export async function findProblemNumber(
  dataUrl: string,
  effort?: string,
): Promise<{ box: ProblemBox | null; text: string; model: string; usage?: DetectUsage }> {
  let usage: DetectUsage | undefined;
  const text = await callOpenAIVision(dataUrl, NUMBER_PROMPT, OPENAI_DETECT_MODEL, effort ?? NUMBER_EFFORT, (u) => {
    usage = u;
  });
  const box = parseNumberBox(text);
  let printed = "";
  try {
    const raw = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")) as { text?: unknown };
    if (typeof raw?.text === "string") printed = raw.text.trim().slice(0, 12);
  } catch {
    /* 글자는 덤이다 */
  }
  return { box, text: box ? printed : "", model: OPENAI_DETECT_MODEL, usage };
}

/** 번호는 작다 — 문제 자리용 `parseBox` 의 "너무 작으면 버림"을 쓰면 안 된다. 대신 너무 크면(번호일 리 없다) 버린다. */
export function parseNumberBox(text: string): ProblemBox | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return null;
  }
  const b = (raw as { box_2d?: unknown } | null)?.box_2d;
  if (!Array.isArray(b) || b.length !== 4) return null;
  const [ymin, xmin, ymax, xmax] = b.map((n) => Number(n));
  if (![ymin, xmin, ymax, xmax].every(Number.isFinite)) return null;
  const c = (v: number) => Math.max(0, Math.min(1, v / 1000));
  const x0 = c(Math.min(xmin, xmax));
  const x1 = c(Math.max(xmin, xmax));
  const y0 = c(Math.min(ymin, ymax));
  const y1 = c(Math.max(ymin, ymax));
  if (x1 - x0 <= 0 || y1 - y0 <= 0 || x1 - x0 > 0.4 || y1 - y0 > 0.4) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export type StartQuality = "low" | "medium" | "high";

const ASSESS_PROMPT = `This is one cropped exam problem (photo or scan). It will be redrawn as a clean printed image by an image
generation model. Image quality tiers cost more as they go up: low (cheap) → medium → high (expensive). Pick the CHEAPEST
tier that will very likely reproduce the problem correctly on the first try.

- "low": mostly printed text and simple math; no figure or only a simple one (a few lines/shapes, a small plain table);
  few or no circled markers (㉠ ① ⓐ ㉮ — up to about five); little or no handwriting. Most problems are this.
- "medium": hard to draw: a real graph, geometry figure, diagram, map, data table with many cells, or a mix of them;
  many circled markers (more than about five) or tiny symbols/subscripts; noticeable handwriting over the printed content.
- "high": VERY hard: very fine, dense graphs or diagrams (many tick marks and tiny labels, many crossing curves, detailed maps
  or apparatus drawings), OR very heavy handwriting covering much of the printed content.

When unsure between two tiers, choose the cheaper one — a later check can still ask to redraw at a higher tier.

answer as JSON object only: {"start":"low"|"medium"|"high","reason":"한 줄 한국어 이유"}`;

/** 그리기를 어느 quality 부터 시작할지. 못 읽으면 예외 — 부르는 쪽이 low 로 간다. */
export async function assessDifficulty(
  dataUrl: string,
): Promise<{ start: StartQuality; reason: string; model: string; usage?: DetectUsage }> {
  let usage: DetectUsage | undefined;
  const text = await callOpenAIVision(dataUrl, ASSESS_PROMPT, OPENAI_DETECT_MODEL, ASSESS_EFFORT, (u) => {
    usage = u;
  });
  return { ...parseAssess(text), model: OPENAI_DETECT_MODEL, usage };
}

export function parseAssess(text: string): { start: StartQuality; reason: string } {
  const raw = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")) as { start?: unknown; reason?: unknown };
  const s = String(raw?.start ?? "").trim().toLowerCase();
  if (s !== "low" && s !== "medium" && s !== "high") throw new Error(`알 수 없는 난이도: ${s.slice(0, 20)}`);
  return { start: s, reason: typeof raw.reason === "string" ? raw.reason.trim().slice(0, 120) : "" };
}

/** luna 사용량 → 원가 계산에 쓰는 모양. */
export function lunaUsage(u: DetectUsage) {
  return { inputTokens: u.input, outputTokens: u.output, ...(u.cached ? { cachedInputTokens: u.cached } : {}) };
}

/** 그림 자리 찾기의 추론 강도. 재배포 없이 `OPENAI_FIGURES_EFFORT`(기본 low, `default` 면 안 보냄). */
const FIGURES_EFFORT = (() => {
  const v = (process.env.OPENAI_FIGURES_EFFORT ?? "low").trim();
  return v === "" || v === "default" ? undefined : v;
})();

function figuresPrompt(blocks: string[]): string {
  const list = blocks.map((b, i) => `B${i}: ${b.replace(/\s+/g, " ").slice(0, 90)}`).join("\n");
  return `This image is ONE exam problem. Its text was already read by OCR and split into these blocks (reading order):
${list || "(no text blocks)"}

Find every VISUAL element that text cannot express: graphs, geometry figures, diagrams, maps, photos, drawn apparatus,
and tables that are pictures (not plain text). Do NOT include ordinary text, condition boxes made of text, <보기> boxes of text,
the problem number, or answer choices that are only text/formulas.

For each visual element give:
- "box_2d": [ymin, xmin, ymax, xmax] tight around it (include its own labels and captions), normalised to 0~1000 of the image.
- "before": the index of the text block that comes RIGHT AFTER the visual in reading order (${blocks.length} if it comes after the last block).

answer as JSON object only: {"figures":[{"box_2d":[...],"before":2}, ...]}  — {"figures":[]} if there is none.`;
}

export type FigurePlace = ProblemBox & { before: number };

/**
 * **글자로 인식한 문제의 그림 자리**(2026-10-09, "luna 를 써서 편해질 수 있으면 다 때려박자"). 그림을 오려 붙이고 문단 사이
 * 제자리로 옮기는 일을 사람이 하던 것을 luna 가 한다 — 자리와 "어느 문단 앞에 오는지"를 짚는다.
 */
export async function placeFigures(
  dataUrl: string,
  blocks: string[],
): Promise<{ figures: FigurePlace[]; model: string; usage?: DetectUsage }> {
  let usage: DetectUsage | undefined;
  const text = await callOpenAIVision(dataUrl, figuresPrompt(blocks), OPENAI_DETECT_MODEL, FIGURES_EFFORT, (u) => {
    usage = u;
  });
  return { figures: parseFigures(text, blocks.length), model: OPENAI_DETECT_MODEL, usage };
}

export function parseFigures(text: string, blockCount: number): FigurePlace[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return [];
  }
  const list = (raw as { figures?: unknown } | null)?.figures;
  if (!Array.isArray(list)) return [];
  const out: FigurePlace[] = [];
  for (const f of list.slice(0, 8)) {
    const box = toBox((f as { box_2d?: unknown })?.box_2d);
    // 너무 작은 것은 부스러기, 거의 전부를 덮는 것은 문제 전체를 짚은 것이다.
    if (!box || box.w < 0.04 || box.h < 0.03 || box.w * box.h > 0.85) continue;
    const b = Math.round(Number((f as { before?: unknown }).before));
    out.push({ ...box, before: Number.isFinite(b) ? Math.max(0, Math.min(blockCount, b)) : blockCount });
  }
  return out;
}
