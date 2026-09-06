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

import { circledCharsIn, circledPairs } from "./circledChars";
import { OPENAI_DETECT_MODEL } from "./detectProblems";
import type { GradedItem, GradeSlot, Subject } from "./gradeSummary";
import { normalizeJamo } from "./renderMathText";

export type { Subject, GradedItem, GradeSlot } from "./gradeSummary";
export { computeSummary } from "./gradeSummary";

export type GradeUsage = {
  inputTokens: number;
  outputTokens: number;
  /**
   * 그중 **캐시로 처리된** 입력 토큰. 캐시 단가가 정가의 10분의 1이라
   * (terra 기준 $2.00 → $0.20) 이걸 안 세면 원가를 크게 부풀려 잡는다.
   * 안 주는 응답도 있어서 선택 항목이다.
   */
  cachedInputTokens?: number;
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

/** OMR(마킹) 대신 손으로 쓴 답을 읽는 방식. "정식시험"(수능 당일 등)은 실제
 *  OMR 카드를 학생이 가져올 수 없어서, 시험지 여백 등에 문항 번호별로 답을
 *  적어 둔 가채점표로 채점해야 한다. */
export type GradingMethod = "omr" | "handwritten";

function subjectPrompt(subject: Subject, keyCount: number, method: GradingMethod): string {
  // 공통 지시는 짧게 유지한다 — 매 채점 호출마다 입력 토큰으로 나가므로,
  // 특정 과목에만 해당하는 설명(예: 수학의 격자형 표기)은 여기 넣지 않고
  // 그 과목 분기에만 붙인다.
  //
  // **프롬프트는 영어로 쓴다**(사용자 지시). 같은 내용을 한글로 쓰면 토큰이
  // 2~3배 든다 — 사람이 읽을 글이 아니라 모델에 보내는 지시라 영어가 싸다.
  // 다만 한글 리터럴(과목명·표기 예시)은 **데이터**라 그대로 둔다.
  const common = `
item = {"no": item number (int), "studentAnswer": what student marked (string; null if unreadable/unmarked/multi-marked), "correctAnswer": correct answer (string), "points": marks (int)}.
- answer key has no marks column at all -> omit "points" key entirely, don't invent partial values
- include every item, count must match answer key
- read student's answer ONLY from what's actually marked, never copy from answer key
- JSON only, no explanation`;

  // 가채점표(손글씨)에는 OMR의 마킹 규칙(격자·원 마킹)이 아예 없다 — 문항
  // 번호 옆에 적힌 숫자를 그대로 읽으면 된다. 지우고 다시 쓴 흔적(취소선 등)
  // 처리만 따로 알려 준다.
  const sheetLabel =
    method === "handwritten"
      ? "hand-marked tally sheet: student wrote answers by hand next to item numbers. don't look for filled bubbles, read handwritten digits/letters as-is. several attempts w/ some struck through -> take the one not struck through. nothing written = unmarked (null)."
      : "OMR answer card: student's marked (or written) answers.";

  // 탐구는 보통 1선택+2선택 두 과목을 같이 보지만, 한 과목만 풀어본
  // 연습(자체 제작 워크시트 등)도 있다 — 그때는 정답표 사진이 1장뿐이고
  // OMR에 구역을 나눌 것도 없다. keyCount로 갈라서, 1장이면 국어·수학과
  // 같은 "사진 두 장, slot 없음" 구조를 그대로 쓴다(아래로 흘러간다).
  if (subject === "elective" && keyCount === 2) {
    return `task: grade Korean HS 탐구영역 (elective science/social-studies) exam. 3 images:
1) ${sheetLabel} holds BOTH first-choice+second-choice subjects (usually 20 items each, split into 2 zones top/bottom or left/right)
2) answer key, first-choice subject
3) answer key, second-choice subject

read the 2 zones of image 1 separately, answer JSON only:
{"slots":[{"slot":1,"items":[...]},{"slot":2,"items":[...]}]}
${common}
- slot 1 item count = answer key 2's count; slot 2 item count = answer key 3's count`;
  }

  const intro =
    subject === "elective"
      ? "task: grade Korean HS 탐구영역 exam."
      : "task: grade Korean HS exam (school test, mock exam, 수능).";

  // 수학은 문항 배치가 표준 수능·모의고사 형식으로 고정돼 있다(공통 22문항
  // + 선택 8문항 = 30문항, 객관식·단답형 자리가 항상 같다). "이 문항이
  // 객관식인지 단답형인지" 를 모델이 사진만 보고 판단하게 두면(표기 방식이
  // 두 가지로 섞여 있어) 헷갈려했다(사용자가 실제로 신고했다) — 번호로
  // 못박아 주면 그 판단 자체가 필요 없어지고, 판단 과정을 설명하던 문장도
  // 줄어 프롬프트가 짧아진다(토큰 절감).
  //
  // **가채점표(손글씨)에는 이 격자 규칙이 없다** — 학생이 그냥 답 숫자를
  // 그대로 적으므로 객관식·단답형 구분 없이 "적힌 숫자를 읽으라"는 공통
  // 지시만으로 충분하고, 여기서 격자 규칙을 얹으면 오히려 없는 격자를
  // 찾으려다 헷갈린다.
  const mathNote =
    subject === "math" && method === "omr"
      ? `
standard 수능/mock-exam layout (fewer items -> apply as far as it goes):
- items 1-15,23-28 = multiple choice (①-⑤). if grid w/ item numbers as horizontal header + ①-⑤ down each column -> follow item number's COLUMN downward to find filled bubble (reading along a row mixes items up). item number itself = label, not a mark.
- items 16-22,29-30 = short answer, 3-row digit grid (hundreds/tens/units), not bubbles. decide each digit's place from label beside row (not position), concatenate. unmarked place = 0 (e.g. units=8,tens=9 -> "98"; hundreds=1 -> "100"). unmarked ONLY when all 3 rows empty.
`
      : "";

  return `${intro}
2 images:
1) ${sheetLabel}
2) answer key: correct answers per item, possibly w/ marks column.
${mathNote}
read items in number order, answer JSON only:
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
 * 사진 여러 장 + 프롬프트를 모델에 보내 **JSON 글자**를 받아 온다.
 *
 * 채점(`gradeWithVision`)과 답지 읽기(`readAnswerKeyWithVision`)가 같은 길을
 * 쓴다 — 모델 이름·Responses↔Chat 폴백·404 안내·usage 읽기가 전부 같은데
 * 두 벌로 두면 한쪽만 고치는 일이 반드시 생긴다. 다른 것은 프롬프트와
 * 결과를 어떻게 해석하느냐뿐이다.
 *
 * **Responses API 로 먼저 부르고 안 되면 Chat Completions 로 내려간다.**
 * 요즘 모델은 Responses 만 받는 경우가 있다. 이건 **같은 모델을 다른 길로**
 * 부르는 것이라, 고른 적 없는 모델로 갈아타는 것과는 다른 이야기다.
 */
async function callVision(
  prompt: string,
  images: string[],
  what: string,
  signal?: AbortSignal,
  /** 쓸 모델. 기본은 자리·채점용(luna). 지문 옮겨 적기는 terra 를 쓴다. */
  modelName?: string,
): Promise<{ text: string; usage?: GradeUsage; model: string }> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new GradeError("OPENAI_API_KEY가 설정되지 않았습니다.", 500);
  const model = modelName ?? OPENAI_DETECT_MODEL;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };

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
        : `${what}에 실패했습니다 (${model}, HTTP ${res.status}).${extra}`,
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
    | {
        input_tokens?: number;
        output_tokens?: number;
        prompt_tokens?: number;
        completion_tokens?: number;
        // Responses API / Chat Completions 가 캐시된 입력을 알려 주는 자리.
        input_tokens_details?: { cached_tokens?: number };
        prompt_tokens_details?: { cached_tokens?: number };
      }
    | undefined;
  const cached =
    usageRaw?.input_tokens_details?.cached_tokens ??
    usageRaw?.prompt_tokens_details?.cached_tokens;
  const usage = usageRaw
    ? {
        inputTokens: usageRaw.input_tokens ?? usageRaw.prompt_tokens ?? 0,
        outputTokens: usageRaw.output_tokens ?? usageRaw.completion_tokens ?? 0,
        ...(typeof cached === "number" && cached > 0
          ? { cachedInputTokens: cached }
          : {}),
      }
    : undefined;

  return { text, usage, model };
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
  method: GradingMethod = "omr",
  signal?: AbortSignal,
): Promise<{ slots: GradeSlot[]; usage?: GradeUsage; model: string }> {
  // images[0]은 OMR(또는 가채점표), 나머지가 정답표다 — 탐구가 정답표
  // 1장(한 과목만)인지 2장(1선택+2선택)인지로 프롬프트가 갈린다.
  const prompt = subjectPrompt(subject, images.length - 1, method);
  const { text, usage, model } = await callVision(prompt, images, "채점", signal);
  return { slots: parseSlots(text), usage, model };
}

/**
 * 국어 지문에 붙일 제목을 짓는다. **글자만 보낸다**(사진이 아니다) —
 * 지문은 Mathpix 가 이미 읽어 두었고, 사진을 다시 보내면 입력 그림 토큰이
 * 붙어 값이 몇 배가 된다. 글자만 보내면 지문 한 편이 1,000토큰 안쪽이다.
 *
 * 규칙은 사용자가 정한 것이다:
 * - 독서(비문학): 글이 하나면 그 글의 주제. 둘 이상 묶인 복합지문이면
 *   `(복합) 1번글 주제 + 2번글 주제`.
 * - 문학: 글 맨 아래에 저자와 제목이 적혀 있으므로 그것을 그대로 쓴다.
 */
const KOREAN_TITLE_PROMPT = `task: write SHORT TITLE for Korean SAT (수능) 국어 passage below. answer JSON only:
{"title":"...","kind":"독서"|"문학"|"기타"}

rules:
- literature (poem/fiction/essay/drama) -> find attribution line at end (or start), e.g. "- 작자, 「작품명」", use verbatim as title (e.g. "김소월, 진달래꽃"). join several works w/ " / "
- non-fiction (독서) -> title = TOPIC as short noun phrase, e.g. "이중차분법". don't summarise the argument, just say what it's about
- non-fiction combining 2+ texts of different kinds -> \`(복합) topic1 + topic2\`, e.g. "(복합) 관세 정책 + 지식재산권"
- title under 25 chars. no quotes, no trailing period. korean.
- unsure -> kind="기타", give short topic
- JSON only, no explanation

passage:
`;

export type KoreanTitle = { title: string; kind: string };

/** Mathpix 가 읽은 지문 글자로 제목을 짓는다. */
export async function readKoreanTitle(
  passageText: string,
  signal?: AbortSignal,
): Promise<{ result: KoreanTitle; usage?: GradeUsage; model: string }> {
  const { text, usage, model } = await callVision(
    KOREAN_TITLE_PROMPT + passageText,
    [],
    "제목 짓기",
    signal,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a === -1 || b <= a) throw new GradeError("제목을 짓지 못했습니다.", 502);
    try {
      parsed = JSON.parse(text.slice(a, b + 1));
    } catch {
      throw new GradeError("제목을 짓지 못했습니다.", 502);
    }
  }
  const o = parsed as { title?: unknown; kind?: unknown };
  const title = String(o?.title ?? "").trim();
  if (!title) throw new GradeError("제목을 짓지 못했습니다.", 502);
  return {
    result: { title, kind: String(o?.kind ?? "기타") },
    usage,
    model,
  };
}

/** 답지 한 문항. 배점은 답지에 있을 때만 채운다(없는 것을 지어내지 않는다). */
export type AnswerKeyItem = { no: number; answer: string; points?: number };

const ANSWER_KEY_PROMPT = `task: transcribe Korean HS ANSWER KEY photo into data. include every item shown, JSON only:
{"items":[{"no": item number (int), "answer": "correct answer", "points": marks (int)}]}
- circled digit (①-⑤) answer -> digit only (① -> "1")
- short answers: exactly as printed (fractions, decimals, letters included)
- no marks column -> omit "points" key entirely, don't invent partial values
- several photos -> merge into one array, number appears twice -> keep once
- table split into columns -> read down each column in item-number order
- JSON only, no explanation`;

/** 답지 사진에서 문항별 정답(+배점)을 읽는다. */
export async function readAnswerKeyWithVision(
  images: string[],
  signal?: AbortSignal,
): Promise<{ items: AnswerKeyItem[]; usage?: GradeUsage; model: string }> {
  const { text, usage, model } = await callVision(ANSWER_KEY_PROMPT, images, "답지 인식", signal);
  return { items: parseAnswerKey(text), usage, model };
}

function parseAnswerKey(text: string): AnswerKeyItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a === -1 || b <= a) throw new GradeError("답지를 읽지 못했습니다.", 502);
    try {
      parsed = JSON.parse(text.slice(a, b + 1));
    } catch {
      throw new GradeError("답지를 읽지 못했습니다.", 502);
    }
  }
  const raw = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { items?: unknown })?.items)
      ? ((parsed as { items: unknown[] }).items)
      : [];

  const out: AnswerKeyItem[] = [];
  const seen = new Set<number>();
  for (const row of raw) {
    const it = row as Record<string, unknown>;
    const no = Number(it?.no);
    if (!Number.isFinite(no) || seen.has(no)) continue;
    const answer = String(it?.answer ?? "").trim();
    if (!answer) continue;
    const points = Number(it?.points);
    seen.add(no);
    out.push({ no, answer, ...(Number.isFinite(points) && points > 0 ? { points } : {}) });
  }
  if (out.length === 0) throw new GradeError("답지에서 정답을 하나도 읽지 못했습니다.", 502);
  out.sort((a, b) => a.no - b.no);
  return out;
}

/**
 * 국어 지문 사진을 **구조화된 글자**로 옮긴다(terra).
 *
 * 그림으로 다시 그리는 것과 다르다 — 결과가 글자라 우리가 평가원 글꼴로
 * 조판할 수 있다(`textFlow.ts`). 확대해도 또렷하고 단을 따라 흐른다.
 *
 * **모델을 따로 둔다**(`OPENAI_TEXT_MODEL`, 기본 `gpt-5.6-terra`). 사용자가
 * 이 일을 terra 에 맡기라고 정했다 — 자리를 재는 luna 와 갈라 두면 한쪽을
 * 바꿔도 다른 쪽이 흔들리지 않는다.
 *
 * **Mathpix 가 읽은 글을 함께 준다.** 글자를 정확히 읽는 일은 Mathpix 가 낫고,
 * 무엇이 문단이고 무엇이 상자인지 가리는 일은 vision 모델이 낫다.
 */
export const OPENAI_TEXT_MODEL = process.env.OPENAI_TEXT_MODEL ?? "gpt-5.6-terra";

/**
 * **지문 인식은 Gemini Flash 를 먼저 쓰고, 안 되면 terra 로 내려간다**
 * (사용자 지시 — "terra 를 gemini flash latest 로 바꿔 봐, flash 써 보고 안
 * 되면 테라로 넘어가게").
 *
 * 값이 훨씬 싸다 — terra 는 입력 $2.00 · 출력 $12.00 (100만 토큰당)이고
 * 지문 한 편이 약 7,000토큰이라 원가가 70원쯤 든다. 이 일은 "사진을 보고
 * 글자와 구조를 옮겨 적기"라 Flash 가 못 할 이유도 없다.
 *
 * **이 저장소의 "조용히 다른 모델로 갈아타지 않는다" 원칙의 예외다.**
 * 그 원칙은 *고른 적 없는* 모델에 요금이 나가는 것을 막으려던 것인데, 여기서는
 * 두 모델을 **사용자가 직접 골라 순서까지 정했다.** 그래서 갈아타되 **숨기지
 * 않는다** — 어느 모델이 실제로 답했는지 응답(`model`)과 로그에 그대로 찍히고,
 * 갈아탄 이유도 로그에 남는다.
 *
 * `GEMINI_API_KEY` 가 없으면 이 갈래는 아예 건너뛰고 예전처럼 terra 만 쓴다.
 * 이름은 못박아 두고 `KOREAN_TEXT_GEMINI_MODEL` 로 바꾼다(자동으로 고르지
 * 않는다 — 고른 적 없는 모델이 왜 실패하는지 알 수 없게 된다). **쉼표로 여러
 * 개를 적으면 앞에서부터 시도한다** — `gemini-flash-latest` 가 503(자리 없음)을
 * 자주 내는 것을 겪고 나서, 재배포 없이 예비 이름을 둘 수 있게 열어 뒀다.
 * 그래도 이름을 지어내는 건 우리가 아니라 **사용자**다.
 */
export const KOREAN_TEXT_GEMINI_MODELS = (
  process.env.KOREAN_TEXT_GEMINI_MODEL ?? "gemini-flash-latest"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * **잠깐 밀려서 나는 오류는 다시 시도한다.**
 *
 * 실제로 겪은 일이다(운영 로그): `gemini-flash-latest` 가 503 UNAVAILABLE —
 * "This model is currently experiencing high demand. Spikes in demand are
 * usually temporary." 를 돌려줬다. 이건 이름이 틀렸거나 요청이 잘못된 게
 * 아니라 **그 순간 자리가 없다**는 뜻이라, 곧바로 terra 로 내려가면 70원짜리
 * 호출을 하게 된다. 몇 초 기다렸다 다시 물어보는 값이 훨씬 싸다.
 *
 * 404(없는 이름)·400(잘못된 요청)은 다시 시도해도 같은 답이라 뺀다.
 */
const GEMINI_TRANSIENT = new Set([429, 500, 502, 503, 504]);
/** 다시 시도하기 전에 기다릴 시간. 전부 합쳐도 4초라 뒤의 terra 를 밀지 않는다. */
const GEMINI_RETRY_MS = [1000, 3000];

/**
 * Gemini 로 사진 한 장 + 프롬프트를 보내 JSON 을 받는다.
 *
 * 요청 모양은 이미 이 저장소에서 `gemini-flash-latest` 로 검증된 것
 * (`detectProblems.ts` 의 `callGemini`)을 그대로 따른다 — 거기서 되는 조합을
 * 바꿀 이유가 없다. 다른 점은 셋뿐이다: 길이 상한(지문 JSON 은 길다),
 * 중단 신호(요청이 시간 안에 안 끝나면 우리가 먼저 끊는다), usage 읽기.
 */
async function callGeminiVision(
  prompt: string,
  imageDataUrl: string,
  what: string,
  signal?: AbortSignal,
  modelName: string = KOREAN_TEXT_GEMINI_MODELS[0],
): Promise<{ text: string; usage?: GradeUsage; model: string }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new GradeError("GEMINI_API_KEY가 설정되지 않았습니다.", 500);
  const m = imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new GradeError("이미지를 읽을 수 없습니다.", 400);

  const request = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inline_data: { mime_type: m[1], data: m[2] } },
            { text: prompt },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        // 옮겨 적는 일이라 매번 같은 답이 나와야 한다.
        temperature: 0,
        // 지문 한 편의 JSON 은 실측 3,544토큰이었다(terra 기준). 넉넉히 두되
        // 넘치면 잘린 JSON 이 오므로 아래에서 실패로 보고 terra 로 내려간다.
        maxOutputTokens: 8192,
      },
    }),
  };

  let body = "";
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(
      `${GEMINI_ENDPOINT}/${modelName}:generateContent?key=${key}`,
      request,
    );
    body = await res.text();
    if (res.ok) break;

    // 자리가 없어 밀린 것뿐이면 몇 초 기다렸다 다시 묻는다 — 곧바로 terra 로
    // 내려가면 70원짜리 호출이 된다.
    const wait = GEMINI_RETRY_MS[attempt];
    if (GEMINI_TRANSIENT.has(res.status) && wait != null && !signal?.aborted) {
      console.warn(
        `[korean-text] ${modelName} HTTP ${res.status} — ${wait}ms 뒤 다시 시도합니다.`,
      );
      await new Promise((r) => setTimeout(r, wait));
      if (signal?.aborted) {
        throw new GradeError(`${what}이 제때 끝나지 않았습니다.`, 504);
      }
      continue;
    }

    throw new GradeError(
      res.status === 404
        ? `모델 "${modelName}"을 찾을 수 없습니다. KOREAN_TEXT_GEMINI_MODEL 로 바꿔 주세요.`
        : `${what}에 실패했습니다 (${modelName}, HTTP ${res.status}). ${body.slice(0, 200)}`,
      res.status,
    );
  }

  let json: {
    candidates?: {
      content?: { parts?: { text?: string }[] };
      finishReason?: string;
    }[];
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      cachedContentTokenCount?: number;
    };
  };
  try {
    json = JSON.parse(body);
  } catch {
    throw new GradeError("모델이 정상적인 응답을 주지 않았습니다.", 502);
  }

  const candidate = json.candidates?.[0];
  // 길이에 걸려 잘린 JSON 은 파싱은 실패하고 요금은 나간다 — 여기서 분명히
  // 실패로 보고 넘겨야 왜 terra 로 내려갔는지 로그에 남는다.
  if (candidate?.finishReason && candidate.finishReason !== "STOP") {
    throw new GradeError(
      `${what}이 중간에 끊겼습니다 (${modelName}, ${candidate.finishReason}).`,
      502,
    );
  }
  // 글을 여러 조각으로 나눠 주는 경우가 있어 이어 붙인다.
  const text = (candidate?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("");

  const u = json.usageMetadata;
  const cached = u?.cachedContentTokenCount;
  const usage: GradeUsage | undefined = u
    ? {
        inputTokens: u.promptTokenCount ?? 0,
        outputTokens: u.candidatesTokenCount ?? 0,
        ...(typeof cached === "number" && cached > 0
          ? { cachedInputTokens: cached }
          : {}),
      }
    : undefined;

  return { text, usage, model: modelName };
}

const KOREAN_TEXT_PROMPT = `task: transcribe Korean SAT (수능) 국어 passage image into structured text for re-typesetting.
reproduce EXACTLY — copying, not editing.

answer JSON only: {"blocks":[ ... ]}

block = one of:
- {"kind":"para","runs":[{"t":"text","b":true,"u":true,"sq":true}],"indent":true}
  \`b\`=printed bold, \`u\`=printed underline, \`sq\`=printed small box/rectangle drawn tightly around this word or phrase — a DIFFERENT mark from underline, used the same way (points at the expression a question refers to). omit each when absent. \`indent\`=paragraph's first line indented (usual for body paragraphs). split \`runs\` only where styling changes, else 1 run.
- {"kind":"box","blocks":[ ... ]} — a bordered frame actually drawn in the image (조건 박스, <보기>, or a frame enclosing several lettered sections like (가)(나) together). one continuous border = exactly ONE box block containing every paragraph inside it, from where the border starts to where it ends — never split one border into multiple box blocks, never leave a paragraph that is visually inside the border sitting outside as a top-level para.
  a box is the EXCEPTION, not the default. rules:
  - the passage body itself is NEVER in a box. 수능 국어 지문 본문(독서·문학·판소리 사설·고전소설) has no frame around it — plain paragraphs, even when it carries markers like [중모리], (가)(나), or 「」.
  - if your candidate box would hold most of the passage, it is wrong — emit those paragraphs as top-level para blocks instead.
  - a real box is small (a few lines), sits apart from the body, and you can see all four ruled sides.
  - the column rule / page frame printed on every exam page is NOT a box.
  - when unsure, do NOT emit a box. a missed box costs a border; an invented box swallows the whole passage.
- {"kind":"figure","id":"f1","ratio":0.6} — picture/table not expressible as text. \`ratio\`=height/width.

rules:
- copy every character exactly, reading the IMAGE itself for these (the reference text below can be wrong here): 「」『』()·, ㄱ/ㄴ/ㄷ list markers, markers like (가)(나), literary work's trailing attribution line
- circled chars (㉠㉡㉢, ①②③) are the ONE exception: take them from the reference text, never from your own reading of the image (see the circled-chars line below)
- no summarise/modernise/translate/fix-spelling/add anything
- keep original paragraph breaks: 1 printed paragraph = 1 "para" block
- lead-in line e.g. "[1~3] 다음 글을 읽고 물음에 답하시오." = own para block
- mark bold/underline/sq only where PRINT shows it, ignore handwriting
- exclude running heads, page numbers, questions printed below passage
- JSON only, no explanation`;

/** 지문 사진 → 구조화된 블록. `reference` 는 Mathpix 가 읽은 글(있으면 더 정확하다). */
export async function readKoreanRichText(
  imageDataUrl: string,
  reference: string,
  signal?: AbortSignal,
): Promise<{ blocks: unknown; usage?: GradeUsage; model: string }> {
  // 조합용 자모(ᄀᄂᄃ)를 먼저 호환용(ㄱㄴㄷ)으로 바꾼다 — Mathpix 가 이 형태로
  // 주는 경우가 있는데, 그대로 두면 모델이 "참고 글을 베끼라"는 지시를 따라
  // 이 깨진 코드를 그대로 옮겨 적는다(renderMathText.ts 와 같은 사고).
  const cleanedReference = normalizeJamo(reference.trim());

  /**
   * **원문자는 무조건 Mathpix 를 따른다**(사용자 지시, 실제 결과물을 보고 정함).
   *
   * 한때는 반대로 적어 뒀다 — "Mathpix 가 기호를 자주 놓치니 원문자도 사진을
   * 보라". 그런데 사용자가 실제로 조판된 지문을 보고 **원문자만 유독 틀린다**고
   * 알려 왔다. 생각해 보면 당연하다: ㉠ 은 사람 눈에도 작은 동그라미 안의 획
   * 하나라, **사진을 눈으로 읽는 쪽(terra)이 가장 불리한 글자**다. 반대로
   * Mathpix 는 인쇄물의 글자를 코드포인트로 집어내는 일에 맞춰진 엔진이라
   * 이 자리에서는 더 낫다. "기호는 사진이 낫다"는 일반론을 원문자에까지
   * 밀어붙인 것이 잘못이었다.
   *
   * 두 겹으로 못박는다 — ① 프롬프트 규칙에서 원문자만 예외로 빼 두고,
   * ② 참고 글에 **실제로 나온 원문자를 우리가 뽑아 목록으로 준다**
   * (`circledCharsIn`). 목록을 주는 쪽이 결정적이다: 문장 안에 섞여 있으면
   * 모델이 사진 쪽 읽기로 덮어쓰지만, "이 지문의 원문자는 정확히 이것들이다"
   * 라고 따로 뽑아 주면 그대로 쓴다(그림 프롬프트의 `circledNote` 가 이미
   * 같은 방식으로 효과를 봤다).
   *
   * **대가**: Mathpix 가 아예 못 읽은 원문자는 우리도 못 살린다. 그건 받아들인
   * 선택이다 — 틀린 글자가 찍히는 것보다 낫고(㉠ 이 ㉡ 으로 바뀌면 문제가
   * 성립하지 않는다), 참고 글이 없을 때는 예전처럼 사진을 본다.
   */
  const circled = circledCharsIn(cleanedReference);
  const circledLine = circled.length
    ? `
circled chars — this passage contains EXACTLY these, in this order: ${circledPairs(circled)}.
use these exact characters from the reference. never substitute a different inner char, never reorder, never add or drop one based on the image.`
    : "";

  // 일반 산문은 참고 글을 우선하되, **구조**(문단·박스·굵게·밑줄·네모)는
  // 사진을 우선한다 — 참고 글에는 그 정보가 아예 없기 때문이다.
  const prompt = cleanedReference
    ? `${KOREAN_TEXT_PROMPT}${circledLine}

reference — same passage as read by a text recogniser (Mathpix). for ORDINARY PROSE WORDING and for CIRCLED CHARS, treat it as authoritative — copy it over your own reading when they differ. it can still drop ㄱ/ㄴ/ㄷ list markers and other symbols, and it carries no structure at all — for those (paragraph breaks, boxes, bold, underline, sq), trust the IMAGE instead:
"""
${cleanedReference}
"""`
    : KOREAN_TEXT_PROMPT;

  /**
   * **Flash 를 먼저, 안 되면 terra**(사용자 지시). 갈아타는 이유가 무엇이든
   * 로그에 남긴다 — 조용히 내려가면 Flash 가 왜 안 되는지 영영 모른다.
   *
   * **읽기와 파싱을 한 묶음으로 시도한다.** 응답이 오더라도 JSON 이 깨져
   * 있으면(잘림·군더더기) 쓸 수 없으므로 그것도 실패로 보고 다음으로 내려가야
   * 한다. 파싱까지 해 봐야 그 판단이 선다.
   */
  const attempts: { label: string; run: () => Promise<{ text: string; usage?: GradeUsage; model: string }> }[] = [];
  if (process.env.GEMINI_API_KEY) {
    // 여러 이름을 적어 두면 앞에서부터 시도한다(`KOREAN_TEXT_GEMINI_MODEL` 에
    // 쉼표로). **우리가 이름을 지어내지는 않는다** — 사용자가 적은 것만 쓴다.
    for (const name of KOREAN_TEXT_GEMINI_MODELS) {
      attempts.push({
        label: name,
        run: () => callGeminiVision(prompt, imageDataUrl, "지문 인식", signal, name),
      });
    }
  }
  if (process.env.OPENAI_API_KEY) {
    attempts.push({
      label: OPENAI_TEXT_MODEL,
      run: () =>
        callVision(prompt, [imageDataUrl], "지문 인식", signal, OPENAI_TEXT_MODEL),
    });
  }
  if (attempts.length === 0) {
    throw new GradeError(
      "GEMINI_API_KEY 도 OPENAI_API_KEY 도 설정되지 않아 지문 인식을 쓸 수 없습니다.",
      500,
    );
  }

  let lastError: unknown;
  for (const [i, attempt] of attempts.entries()) {
    try {
      const { text, usage, model } = await attempt.run();
      return { blocks: parseBlocks(text), usage, model };
    } catch (err) {
      lastError = err;
      // **시간이 다 됐으면 갈아타지 않는다.** 어차피 다음 호출도 곧바로
      // 끊기는데 요금만 한 번 더 나간다.
      if (signal?.aborted) throw err;
      const isLast = i === attempts.length - 1;
      if (isLast) throw err;
      console.warn(
        `[korean-text] ${attempt.label} 실패 → ${attempts[i + 1].label} 로 넘어감: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new GradeError("지문을 읽지 못했습니다.", 502);
}

/**
 * 모델이 준 글에서 `blocks` 를 꺼낸다.
 *
 * JSON 만 달라고 했어도 앞뒤에 군더더기가 붙어 오는 경우가 있어 중괄호
 * 구간을 다시 잘라 본다. 그래도 안 되면 **실패**다 — 부르는 쪽이 그걸 보고
 * 다음 모델로 내려간다.
 */
function parseBlocks(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a === -1 || b <= a) throw new GradeError("지문을 읽지 못했습니다.", 502);
    try {
      parsed = JSON.parse(text.slice(a, b + 1));
    } catch {
      throw new GradeError("지문을 읽지 못했습니다.", 502);
    }
  }
  return (parsed as { blocks?: unknown })?.blocks ?? parsed;
}
