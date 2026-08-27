/**
 * OMR 카드 + 정답표 사진을 보고 채점한다.
 *
 * **문제 영역 자동 찾기(`detectProblems.ts`)와는 별개 기능이다** — 코드를
 * 일부러 겹치지 않게 뒀다(이 저장소의 다른 GPT 연동들도 그렇다. 수학 도형은
 * Gemini, 사과탐 자료는 OpenAI 이지만 서로 코드를 안 나눈다). 다만 **모델
 * 이름은 같은 것을 쓴다** — 사용자가 "luna"라고 부르는 것이 정확히
 * `OPENAI_DETECT_MODEL`(기본 `gpt-5.6-luna`)이고, 이미 이 계정에서 검증된
 * 값이다. 이름을 또 하나 만들면 모델을 추측하는 셈이 된다.
 */

import { OPENAI_DETECT_MODEL } from "./detectProblems";
import type { GradedItem, GradeSlot, Subject } from "./gradeSummary";

export type { Subject, GradedItem, GradeSlot } from "./gradeSummary";
export { computeSummary } from "./gradeSummary";

export type GradeUsage = {
  inputTokens: number;
  outputTokens: number;
};

export class GradeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GradeError";
  }
}

function subjectPrompt(subject: Subject): string {
  const common = `
각 문항은 {"no": 문항번호(정수), "studentAnswer": 학생이 마킹한 답(문자열, 못 읽었거나 무마킹·복수마킹이면 null), "correctAnswer": 정답(문자열), "points": 배점(정수)} 형태입니다.
- **정답표 전체에 배점(점수) 칸이 하나도 없으면 모든 문항에서 points 키를 아예 넣지 마세요.** 일부만 있는 것처럼 지어내지 마세요.
- 문항을 하나도 빠뜨리지 말고, 정답표에 있는 문항 수만큼 전부 넣으세요.
- 학생 답은 실제로 마킹(칠하거나 표시)된 것만 읽으세요. 정답표를 보고 지어내지 마세요.
- 설명은 쓰지 말고 JSON만 답하세요.`;

  if (subject === "elective") {
    return `당신은 한국 고등학교 탐구영역 시험을 채점하는 도우미입니다.
사진은 세 장입니다.
1) OMR 카드 — 1선택 과목과 2선택 과목의 마킹이 한 장에 함께 있습니다(보통 각 20문항이고, 위아래 또는 좌우로 구역이 나뉘어 있습니다).
2) 1선택 과목 정답표
3) 2선택 과목 정답표

OMR에서 1선택 과목 구역과 2선택 과목 구역의 마킹을 각각 구분해서 읽고, 다음 JSON으로만 답하세요:
{"slots":[{"slot":1,"items":[...]},{"slot":2,"items":[...]}]}
${common}
- slot 1의 items 개수는 1선택 정답표의 문항 수와, slot 2는 2선택 정답표의 문항 수와 같아야 합니다.`;
  }

  return `당신은 한국 고등학교 시험(내신·모의고사·수능)의 답안을 채점하는 도우미입니다.
사진은 두 장입니다.
1) OMR 카드 — 학생이 마킹(또는 적은) 답입니다.
2) 정답표 — 문항별 정답이고, 배점(점수) 칸이 있을 수도 있습니다.

문항 번호 순서대로 읽어 다음 JSON으로만 답하세요:
{"slots":[{"items":[...]}]}
${common}`;
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

const OPENAI_MODELS = "https://api.openai.com/v1/models";
const OPENAI_RESPONSES = "https://api.openai.com/v1/responses";
const OPENAI_CHAT = "https://api.openai.com/v1/chat/completions";

/** 404 가 났을 때, 이 계정이 실제로 가진 이름들을 붙여 준다(목록 조회는 무료). */
async function explain404(key: string, model: string): Promise<string> {
  try {
    const res = await fetch(OPENAI_MODELS, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return "";
    const ids: string[] = ((await res.json())?.data ?? [])
      .map((m: { id?: string }) => String(m.id ?? ""))
      .filter((id: string) => id.startsWith("gpt"))
      .sort();
    return ids.length ? ` 이 계정의 gpt 계열: ${ids.slice(0, 25).join(", ")}` : "";
  } catch {
    return "";
  }
}

function parseSlots(text: string): GradeSlot[] {
  const take = (raw: unknown): unknown[] => {
    const o = raw as Record<string, unknown> | null;
    if (Array.isArray(o)) return o;
    if (o && Array.isArray(o.slots)) return o.slots;
    return [];
  };
  const toSlot = (raw: unknown): GradeSlot | null => {
    const o = raw as Record<string, unknown>;
    const items = Array.isArray(o?.items) ? o.items : [];
    const parsed: GradedItem[] = [];
    for (const item of items) {
      const it = item as Record<string, unknown>;
      const no = Number(it?.no);
      if (!Number.isFinite(no)) continue;
      const points = Number(it?.points);
      parsed.push({
        no,
        studentAnswer:
          it?.studentAnswer === null || it?.studentAnswer === undefined
            ? null
            : String(it.studentAnswer),
        correctAnswer: String(it?.correctAnswer ?? ""),
        ...(Number.isFinite(points) ? { points } : {}),
      });
    }
    if (parsed.length === 0) return null;
    const slotNum = Number(o?.slot);
    return { ...(slotNum === 1 || slotNum === 2 ? { slot: slotNum as 1 | 2 } : {}), items: parsed };
  };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a === -1 || b <= a) throw new GradeError("채점 결과를 읽지 못했습니다.", 502);
    try {
      parsedJson = JSON.parse(text.slice(a, b + 1));
    } catch {
      throw new GradeError("채점 결과를 읽지 못했습니다.", 502);
    }
  }
  const slots = take(parsedJson).map(toSlot).filter((s): s is GradeSlot => s !== null);
  if (slots.length === 0) throw new GradeError("채점 결과가 비어 있습니다.", 502);
  return slots;
}

/**
 * OMR·정답표 사진을 모델에 보내 채점한다.
 *
 * `images` 순서가 곧 프롬프트가 말하는 "1) OMR, 2) 정답표..." 순서다 —
 * 어긋나면 모델이 엉뚱한 사진을 정답표로 읽는다.
 */
export async function gradeWithVision(
  subject: Subject,
  images: string[],
  signal?: AbortSignal,
): Promise<{ slots: GradeSlot[]; usage?: GradeUsage; model: string }> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new GradeError("OPENAI_API_KEY가 설정되지 않았습니다.", 500);
  const model = OPENAI_DETECT_MODEL;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
  const prompt = subjectPrompt(subject);

  let res = await fetch(OPENAI_RESPONSES, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      model,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            ...images.map((dataUrl) => ({
              type: "input_image",
              image_url: dataUrl,
              detail: "high",
            })),
          ],
        },
      ],
      text: { format: { type: "json_object" } },
    }),
  });
  let body = await res.text();
  let viaResponses = true;

  if (!res.ok && res.status !== 404) {
    res = await fetch(OPENAI_CHAT, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              ...images.map((dataUrl) => ({
                type: "image_url",
                image_url: { url: dataUrl, detail: "high" },
              })),
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
    throw new GradeError(
      res.status === 404
        ? `모델 "${model}"을 찾을 수 없습니다. OPENAI_DETECT_MODEL 로 바꿔 주세요.${extra}`
        : `채점에 실패했습니다 (${model}, HTTP ${res.status}).${extra}`,
      res.status,
    );
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(body);
  } catch {
    throw new GradeError("모델이 정상적인 응답을 주지 않았습니다.", 502);
  }
  const text = viaResponses
    ? harvest(json)
    : ((json?.choices as { message?: { content?: string } }[])?.[0]?.message?.content ?? "");

  const usageRaw = json?.usage as
    | { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number }
    | undefined;
  const usage = usageRaw
    ? {
        inputTokens: usageRaw.input_tokens ?? usageRaw.prompt_tokens ?? 0,
        outputTokens: usageRaw.output_tokens ?? usageRaw.completion_tokens ?? 0,
      }
    : undefined;

  return { slots: parseSlots(text), usage, model };
}
