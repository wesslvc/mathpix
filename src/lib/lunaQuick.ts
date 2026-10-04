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
Find that problem and return the box that tightly encloses ALL of it: the problem number, the question stem, any
condition box / <보기> box, figures, graphs, tables, maps, and the answer choices (①~⑤) or answer blank.

- If the photo shows exactly one problem (or one problem fills most of it), box that problem.
- If several problems are visible, pick the most complete one closest to the centre of the photo.
- Exclude everything else: page headers and footers, page numbers, neighbouring problems (even partly cut ones),
  the desk / background outside the paper, the paper edge, fingers, shadows.
- Keep the box tight to the printed content (no wide empty margins), but never cut through any line of text,
  a figure, or the choices. Handwriting inside the problem area may be included; handwriting far outside is not part of it.
- Coordinates: box_2d = [ymin, xmin, ymax, xmax], each normalised to 0~1000 of the photo.

answer as JSON object only: {"box_2d":[ymin,xmin,ymax,xmax]}  — or {"box_2d":null} if no problem is visible.`;

/** 사진 한 장에서 문제 하나의 자리(0~1). 못 찾으면 box 가 null. */
export async function cropOneProblem(
  dataUrl: string,
): Promise<{ box: ProblemBox | null; model: string; usage?: DetectUsage }> {
  let usage: DetectUsage | undefined;
  const text = await callOpenAIVision(dataUrl, CROP_PROMPT, OPENAI_DETECT_MODEL, CROP_EFFORT, (u) => {
    usage = u;
  });
  return { box: parseBox(text), model: OPENAI_DETECT_MODEL, usage };
}

/** `{"box_2d":[…]}` → 0~1 상자. 모양이 이상하거나 너무 작으면 null(그때는 화면이 제 계산을 쓴다). */
export function parseBox(text: string): ProblemBox | null {
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
  // 너무 작으면 문제가 아니라 부스러기다.
  if (x1 - x0 < 0.08 || y1 - y0 < 0.04) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
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
- If there is no printed problem number at the start (the problem begins directly with text such as "밑줄 친 ㉠…" or "가. …"),
  return null. Choice markers (①~⑤), page numbers, and numbers inside the question are NOT the problem number.
- Coordinates: box_2d = [ymin, xmin, ymax, xmax], each normalised to 0~1000 of the image.

- "text": the number exactly as printed, including its punctuation (e.g. "17.", "05", "[22]").

answer as JSON object only: {"box_2d":[ymin,xmin,ymax,xmax],"text":"17."}  — or {"box_2d":null}.`;

/** 문제 그림에서 인쇄된 문제 번호의 자리(0~1). 없으면 box 가 null. 여러 실모를 묶어 1번부터 다시 매길 때 쓴다. */
export async function findProblemNumber(
  dataUrl: string,
): Promise<{ box: ProblemBox | null; text: string; model: string; usage?: DetectUsage }> {
  let usage: DetectUsage | undefined;
  const text = await callOpenAIVision(dataUrl, NUMBER_PROMPT, OPENAI_DETECT_MODEL, NUMBER_EFFORT, (u) => {
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
