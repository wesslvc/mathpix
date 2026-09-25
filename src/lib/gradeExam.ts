/**
 * OMR 카드 + 정답표 사진을 보고 채점한다.
 *
 * **문제 영역 자동 찾기(`detectProblems.ts`)와는 별개 기능이다** — 코드를
 * 일부러 겹치지 않게 뒀다(이 저장소의 다른 GPT 연동들도 그렇다. 수학 도형은
 * Gemini, 사과탐 자료는 OpenAI 이지만 서로 코드를 안 나눈다). 다만 **모델
 * 이름은 같은 것을 쓴다** — 사용자가 "luna"라고 부르는 것이 정확히
 * `OPENAI_DETECT_MODEL`(기본 `gpt-6-luna`)이고, 이미 이 계정에서 검증된
 * 값이다. 이름을 또 하나 만들면 모델을 추측하는 셈이 된다.
 */

import { OPENAI_DETECT_MODEL } from "./detectProblems";
import { marksReviewPrompt, parseMarksReview, type MarksReviewPara } from "./kice/marksReview";
import type { GradedItem, GradeSlot, Subject } from "./gradeSummary";

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

function subjectPrompt(
  subject: Subject,
  keyCount: number,
  method: GradingMethod,
  electiveLabel?: string,
): string {
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

  // 수학(미적분/기하/확률과 통계)·국어(언어와 매체/화법과 작문)는 선택과목에
  // 따라 정답이 갈리는 문항이 있다. 학원 정답표는 그 문항에 선택과목별 답을
  // **나란히** 적어 둔다(예: "24. 미적분 ③ 기하 ② 확통 ①") — 학생이 고른
  // 과목 하나만 봐야 하는데, 어느 것인지 안 알려주면 모델이 아무거나 골라
  // 채점한다(사용자 신고 — "미적기하확통이 답지에 같이있을때는 그 선택과목을
  // 보고 채점해야하는데 자꾸 그냥함"). 화면에서 이미 고른 선택과목을 그대로
  // 박아 준다 — 프롬프트가 없으면 정답표에 답이 여러 개 있다는 것 자체를
  // 모델이 모른다.
  const electiveNote =
    (subject === "math" || subject === "korean") && electiveLabel
      ? `\nstudent's elective subject is "${electiveLabel}". if the answer key lists separate answers per elective for some items (e.g. "24. 미적분 ③ 기하 ② 확통 ①"), use ONLY the "${electiveLabel}" answer for those items and ignore the other electives' answers entirely.\n`
      : "";

  return `${intro}
2 images:
1) ${sheetLabel}
2) answer key: correct answers per item, possibly w/ marks column.
${mathNote}${electiveNote}
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
  /**
   * BYOK 사용자의 본인 OpenAI 키. 있으면 공유 `OPENAI_API_KEY` 대신 이
   * 값으로 부른다 — item 5(BYOK는 공유 키를 절대 못 건드린다)에 따라
   * 호출부가 반드시 본인 키를 확보한 뒤에만 넘겨야 한다.
   */
  apiKeyOverride?: string,
  /** 추론 강도(`reasoning.effort`). 없으면 모델 기본값 — 지금은 비교 화면만 넘긴다. */
  effort?: string,
): Promise<{ text: string; usage?: GradeUsage; model: string }> {
  const key = apiKeyOverride || process.env.OPENAI_API_KEY;
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
      ...(effort ? { reasoning: { effort } } : {}),
    }),
  });
  let body = await res.text();
  let viaResponses = true;

  // 추론 강도를 정해 부른 것이면 Chat 으로 내려가지 않는다 — 그쪽은 그 값을
  // 빼고 성공해 버려서, 고른 강도로 돈 것처럼 잘못 보인다.
  if (!res.ok && res.status !== 404 && !effort) {
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
  electiveLabel?: string,
  /** BYOK 사용자의 본인 OpenAI 키. 없으면 공유 키를 쓴다. */
  apiKeyOverride?: string,
): Promise<{ slots: GradeSlot[]; usage?: GradeUsage; model: string }> {
  // images[0]은 OMR(또는 가채점표), 나머지가 정답표다 — 탐구가 정답표
  // 1장(한 과목만)인지 2장(1선택+2선택)인지로 프롬프트가 갈린다.
  const prompt = subjectPrompt(subject, images.length - 1, method, electiveLabel);
  const { text, usage, model } = await callVision(
    prompt,
    images,
    "채점",
    signal,
    undefined,
    apiKeyOverride,
  );
  return { slots: parseSlots(text), usage, model };
}

/**
 * 국어 지문에 붙일 제목을 짓는다.
 *
 * 예전에는 따로 읽어 둔 지문 글자만 보냈다(그림 토큰을 아끼려고). 글자만 따로
 * 읽는 호출이 없어진 뒤로는(2026-09-25, 지문 인식을 한 번으로 합침) **사진을
 * 그대로** 보낸다 — luna 라 사진 한 장을 붙여도 몇 원이다. 글자가 이미 있으면
 * (`text`) 예전처럼 글만 보낸다.
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

passage (text below, or the attached image):
`;

export type KoreanTitle = { title: string; kind: string };

/** 지문 사진(또는 이미 읽어 둔 글)으로 제목을 짓는다. */
export async function readKoreanTitle(
  input: { text?: string; image?: string },
  signal?: AbortSignal,
  /** BYOK 사용자의 본인 OpenAI 키. 없으면 공유 키를 쓴다. */
  apiKeyOverride?: string,
): Promise<{ result: KoreanTitle; usage?: GradeUsage; model: string }> {
  const { text, usage, model } = await callVision(
    KOREAN_TITLE_PROMPT + (input.text ?? ""),
    input.text ? [] : input.image ? [input.image] : [],
    "제목 짓기",
    signal,
    undefined,
    apiKeyOverride,
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
  /** BYOK 사용자의 본인 OpenAI 키. 없으면 공유 키를 쓴다. */
  apiKeyOverride?: string,
): Promise<{ items: AnswerKeyItem[]; usage?: GradeUsage; model: string }> {
  const { text, usage, model } = await callVision(
    ANSWER_KEY_PROMPT,
    images,
    "답지 인식",
    signal,
    undefined,
    apiKeyOverride,
  );
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
 * 국어 지문 사진을 **구조화된 글자**로 옮긴다.
 *
 * 그림으로 다시 그리는 것과 다르다 — 결과가 글자라 우리가 평가원 글꼴로
 * 조판할 수 있다(`textFlow.ts`). 확대해도 또렷하고 단을 따라 흐른다.
 *
 * **한 번의 호출로 글자와 모양을 함께 읽는다**(2026-09-25, 사용자 지시 — "sol
 * medium 으로 통합한 다음에 지문 텍스트 인식과 요소 인식을 통합해 버리자").
 * 한때는 ① 글자만 옮겨 적는 호출(처음엔 Mathpix, 그다음 GPT) ② 모양을 읽는
 * 호출 ③ ①의 글자를 ②의 뼈대에 갈아 끼우는 코드로 셋을 나눴는데, 갈아 끼우는
 * 자리에서 글자 줄을 맞추느라 서식 경계가 흔들렸고 호출도 두 번 나갔다.
 * 지금은 모델이 문단마다 **글 전체**와 **서식 구간**(`marks`: 정확히 어디부터
 * 어디까지가 굵게·밑줄·네모인지)을 함께 준다(`applyMarks`, richText.ts).
 *
 * 모델은 `OPENAI_TEXT_MODEL`(기본 `gpt-6-sol`), 추론 강도는 `OPENAI_TEXT_EFFORT`
 * (기본 `medium`) — 둘 다 재배포 없이 바꾼다. 강도를 비우려면 `none` 이 아니라
 * `default` 를 적는다(모델 기본값으로 부른다). OpenAI 하나뿐이다 — 예전의
 * Gemini Flash 먼저 시도하기는 걷어냈다(같은 지시).
 */
export const OPENAI_TEXT_MODEL = process.env.OPENAI_TEXT_MODEL?.trim() || "gpt-6-sol";
const TEXT_EFFORT_ENV = process.env.OPENAI_TEXT_EFFORT?.trim() || "medium";
export const OPENAI_TEXT_EFFORT: string | undefined =
  TEXT_EFFORT_ENV === "default" ? undefined : TEXT_EFFORT_ENV;

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
  signal: AbortSignal | undefined,
  modelName: string,
  /** 출력 상한. 생각(thinking) 토큰도 여기에 든다 — 비교 화면은 넉넉히 준다. */
  maxOutputTokens = 8192,
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
        maxOutputTokens,
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
        ? `모델 "${modelName}"을 찾을 수 없습니다.`
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
      /** 생각(thinking) 토큰. 출력 단가로 청구되므로 출력에 더한다. */
      thoughtsTokenCount?: number;
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
        outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
        ...(typeof cached === "number" && cached > 0
          ? { cachedInputTokens: cached }
          : {}),
      }
    : undefined;

  return { text, usage, model: modelName };
}

export const KOREAN_TEXT_PROMPT = `task: read a Korean SAT (수능) 국어 passage image and write it out for re-typesetting — every printed character exactly, AND the layout and printed marks exactly where the image shows them. copying, not editing.

answer JSON only: {"blocks":[ ... ]}

block = one of:
- {"kind":"para","text":"...","marks":[{"type":"u","before":"...","text":"...","after":"...","nth":1}],"indent":true,"center":true,"right":true}
  text = the WHOLE paragraph exactly as printed, as one string.
  marks = every printed styling span in this paragraph ("marks":[] if none):
    type "b" = printed bold · "u" = printed underline · "sq" = small printed box drawn tightly around a word/phrase (a different mark from underline, used the same way).
    text = the EXACT characters the mark covers, copied verbatim from this paragraph's text — from the first marked character to the last one, nothing more, nothing less. never stretch a mark to the whole line or paragraph unless the print really covers all of it.
    before / after = the 1-4 characters immediately before / after the mark (NOT marked), copied from the text — they pin where an underline starts and stops. empty at the start/end of the text.
    nth = which occurrence inside this paragraph's text when the same characters appear more than once (1 = first). omit when they appear once.
    a span with two styles (e.g. bold + underline) = two marks with the same text.
  indent = first line indented (usual for body paragraphs). center = line printed centred (a title). right = line pushed to the right edge (typically the trailing attribution "- 작자 미상, 「적벽가」 -"). omit each when absent.
- {"kind":"box","blocks":[ ... ]} — a bordered frame actually drawn in the image (조건 박스, <보기>, or a frame enclosing several lettered sections like (가)(나) together). one continuous border = exactly ONE box block containing every paragraph inside it — never split one border into several boxes, never leave a paragraph that is inside the border outside it.
  a box is the EXCEPTION, not the default:
  - the passage body itself is NEVER in a box. 수능 국어 지문 본문(독서·문학·판소리 사설·고전소설) has no frame — plain paragraphs, even with markers like [중모리], (가)(나), 「」.
  - a candidate box holding most of the passage is wrong — emit those paragraphs as top-level para blocks.
  - a real box is small (a few lines), sits apart from the body, all four ruled sides visible. the column rule / page frame is NOT a box.
  - unsure -> no box. a missed box costs a border; an invented box swallows the whole passage.
- {"kind":"figure","id":"f1"} — the place where a picture sits. ONLY as told in the "pictures" section at the end.

characters:
- copy exactly: every Hangul syllable, Hanja in its original character (never convert 漢字 to Hangul or the reverse), Latin, digits, punctuation/symbols 「」『』〈〉《》()[]·~…—‘’“” ※ ○ ◎ ● □ ▲ →
- circled chars: identify each one individually by its inner character — ㉠㉡㉢㉣㉤㉥㉦ (ㄱㄴㄷㄹㅁㅂㅅ), ㉮㉯㉰㉱ (가나다라), ①②③④⑤ (1-5), ⓐⓑⓒⓓⓔ (a-e). look at each closely; never guess from neighbours or alphabetical order, never switch families, never add one that is not printed
- list markers ㄱ. ㄴ. ㄷ., section markers (가)(나)(다), [A][B], [중모리] — exactly as printed, at their position
- no summarise/modernise/translate/fix-spelling/add anything. hard to read -> best reading, never drop text
- reading order: two columns -> the whole left column top to bottom, then the right

layout:
- 1 printed paragraph = 1 para block. lead-in line e.g. "[1~3] 다음 글을 읽고 물음에 답하시오." = its own para
- verse (시·시조·가사·민요, a play's lines): every printed line ends with "\\n" inside text; a blank line between stanzas = a new para. prose: never put "\\n" inside a paragraph — the typesetter wraps it
- keep printed word spacing, including a wide gap inside a verse line (two spaces)
- exclude running heads, page numbers, questions/answer choices printed below the passage

printed vs handwritten marks:
- printed underline = crisp, straight, even, same dark ink as the text, sitting right under the characters. a faint, wobbly, pencil/pen line, uneven in thickness, overshooting the words or in another colour is a student's HANDWRITTEN mark — never a mark. ignore handwritten circles, ticks and notes entirely too
- an underline that begins right after a circled marker (㉠ ⓐ ① …) — "㉠ 표현을 밑줄로" style — is almost always PRINTED: questions ask about "밑줄 친 ㉠". mark it as "u" covering exactly the underlined words (the circled char itself only if the rule clearly runs under it too)
- JSON only, no explanation`;

/**
 * 지문 인식 프롬프트 — 그림 안내까지 붙인 것.
 *
 * **그림이 있는지는 luna 가 먼저 알려 준다**(지문 찾기, `KOREAN_PASSAGE_PROMPT`).
 * 우리가 그 자리를 잘라 사진 뒤에 붙여 보내고, sol 은 각 그림이 지문의 어디에
 * 들어가는지만 짚는다(`figure` 블록). 그림 안의 글자(축 이름·범례)는 옮겨 적지
 * 않게 한다 — 그림은 이미지로 붙는다.
 *
 * 그림이 없으면 figure 블록을 **아예 못 쓰게** 한다. 짚은 자리에 붙일 그림이
 * 없으면 조판에 빈 네모만 남는다.
 */
export function koreanTextPrompt(figureCount: number): string {
  if (figureCount <= 0) {
    return `${KOREAN_TEXT_PROMPT}

pictures: this passage has none — never emit a figure block.`;
  }
  const ids = Array.from({ length: figureCount }, (_, i) => `f${i + 1}`).join(", ");
  return `${KOREAN_TEXT_PROMPT}

pictures: this passage contains exactly ${figureCount} picture(s), found beforehand. the first image is the passage; the next ${figureCount} image(s) are those pictures cropped out of it, in reading order, named ${ids}.
- at the exact place each picture sits in the passage (between the paragraphs around it), emit {"kind":"figure","id":"fK"}. emit every id exactly once, in the order the pictures appear
- never transcribe text that is inside a picture (labels, legends, axis numbers, captions printed within it) — the picture is pasted as an image
- never emit a figure block with any other id`;
}

/** 지문 사진 → 구조화된 블록(`text` + `marks` 모양, `readRichBlocks` 가 토막으로 바꾼다). */
export async function readKoreanRichText(
  imageDataUrl: string,
  signal?: AbortSignal,
  /** BYOK 사용자의 본인 OpenAI 키. 없으면 공유 키를 쓴다. */
  apiKeyOverride?: string,
  /** luna 가 찾은 지문 안 그림들(잘라 낸 것, 읽는 차례). */
  figures: string[] = [],
): Promise<{ blocks: unknown; usage?: GradeUsage; model: string }> {
  const { text, usage, model } = await callVision(
    koreanTextPrompt(figures.length),
    [imageDataUrl, ...figures],
    "지문 인식",
    signal,
    OPENAI_TEXT_MODEL,
    apiKeyOverride,
    OPENAI_TEXT_EFFORT,
  );
  return { blocks: parseBlocks(text), usage, model };
}

/**
 * **서식 검수 — 두 번째 호출**(`marksReview.ts` 주석 참고). 글자는 이미 읽었으니
 * 원문자·굵게·밑줄·네모만 다시 본다. 사진은 전체 한 장 + 확대한 가로 띠들이다.
 *
 * 모델·강도는 `OPENAI_MARKS_MODEL` / `OPENAI_MARKS_EFFORT`(비우면 지문 인식과 같은
 * 값). 재배포 없이 바꾼다 — 서식만 보는 일이라 강도를 따로 올려 볼 수 있게 열어 뒀다.
 */
export const OPENAI_MARKS_MODEL = process.env.OPENAI_MARKS_MODEL?.trim() || OPENAI_TEXT_MODEL;
const MARKS_EFFORT_ENV = process.env.OPENAI_MARKS_EFFORT?.trim();
export const OPENAI_MARKS_EFFORT: string | undefined =
  MARKS_EFFORT_ENV === "default" ? undefined : (MARKS_EFFORT_ENV || OPENAI_TEXT_EFFORT);

export async function readKoreanMarks(
  images: string[],
  paragraphs: string[],
  signal?: AbortSignal,
  apiKeyOverride?: string,
  target: { model?: string; effort?: string } = {},
): Promise<{ review: MarksReviewPara[]; usage?: GradeUsage; model: string }> {
  const { text, usage, model } = await callVision(
    marksReviewPrompt(paragraphs),
    images,
    "서식 검수",
    signal,
    target.model ?? OPENAI_MARKS_MODEL,
    apiKeyOverride,
    target.model ? target.effort : OPENAI_MARKS_EFFORT,
  );
  const review = parseMarksReview(text);
  if (review.length === 0) throw new GradeError("서식 검수 결과를 읽지 못했습니다.", 502);
  return { review, usage, model };
}

/**
 * **비교용** — 정해 준 모델·강도로만 읽는다. 프롬프트·파싱은 운영과 **같은 것**을
 * 쓴다(다르면 견준 결과가 운영에 안 맞는다).
 */
export async function readKoreanRichTextWith(
  imageDataUrl: string,
  target: { model: string; effort?: string },
  signal?: AbortSignal,
  figures: string[] = [],
): Promise<{ blocks: unknown; usage?: GradeUsage; model: string; raw: string }> {
  const { text, usage, model } = await callVision(
    koreanTextPrompt(figures.length),
    [imageDataUrl, ...figures],
    "지문 인식",
    signal,
    target.model,
    undefined,
    target.effort,
  );
  return { blocks: parseBlocks(text), usage, model, raw: text };
}

/**
 * **오래 생각하는 OpenAI 호출은 백그라운드로 건다**(Responses API `background`).
 *
 * gpt-6-luna 를 추론 강도 `max` 로 지문 한 편에 돌렸더니 285초 안에 안 끝났다
 * (2026-09-25 운영 로그 — 우리 쪽 마감에 걸려 504). Vercel 함수는 300초가
 * 한도라 기다리는 방식으로는 못 받는다. 백그라운드로 걸면 OpenAI 가 제 서버에서
 * 끝까지 돌리고, 우리는 id 만 들고 있다가 짧은 요청으로 몇 번이고 물어본다.
 *
 * 비교 화면 전용이다. Chat Completions 로는 내려가지 않는다(백그라운드도,
 * 추론 강도도 그쪽에는 없다).
 */
export async function startKoreanTextBackground(
  imageDataUrl: string,
  model: string,
  effort?: string,
  figures: string[] = [],
): Promise<string> {
  return startVisionBackground(
    koreanTextPrompt(figures.length),
    [imageDataUrl, ...figures],
    model,
    effort,
  );
}

/**
 * 사진 한 장 + 프롬프트를 **백그라운드로** 건다(JSON 응답). 지문 읽기와 지문
 * 위치 찾기(비교 화면)가 같이 쓴다 — 프롬프트와 결과 해석만 다르다.
 */
export async function startVisionBackground(
  prompt: string,
  /** 사진 한 장 또는 여러 장(지문 + 그림들). */
  images: string | string[],
  model: string,
  effort?: string,
): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new GradeError("OPENAI_API_KEY가 설정되지 않았습니다.", 500);
  const res = await fetch(OPENAI_RESPONSES, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      background: true,
      // 백그라운드 결과는 저장돼 있어야 나중에 꺼낼 수 있다.
      store: true,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            ...(Array.isArray(images) ? images : [images]).map((url) => ({
              type: "input_image",
              image_url: url,
              detail: "high",
            })),
          ],
        },
      ],
      text: { format: { type: "json_object" } },
      ...(effort ? { reasoning: { effort } } : {}),
    }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new GradeError(
      `지문 인식을 시작하지 못했습니다 (${model}, HTTP ${res.status}). ${body.slice(0, 300)}`,
      res.status,
    );
  }
  const id = (JSON.parse(body) as { id?: unknown }).id;
  if (typeof id !== "string" || !id.startsWith("resp")) {
    throw new GradeError("OpenAI 가 작업 id 를 주지 않았습니다.", 502);
  }
  return id;
}

export type BackgroundPoll =
  | { status: "running"; openaiStatus: string }
  | { status: "done"; blocks: unknown; usage?: GradeUsage; model: string }
  | { status: "error"; message: string };

/** 백그라운드 작업이 어떻게 됐는지 한 번 묻는다(지문 읽기 — 블록까지 꺼낸다). */
export async function pollKoreanTextBackground(id: string): Promise<BackgroundPoll> {
  const poll = await pollVisionBackground(id);
  if (poll.status !== "done") return poll;
  try {
    return { status: "done", blocks: parseBlocks(poll.text), usage: poll.usage, model: poll.model };
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : "지문을 읽지 못했습니다." };
  }
}

export type VisionPoll =
  | { status: "running"; openaiStatus: string }
  | { status: "done"; text: string; usage?: GradeUsage; model: string }
  | { status: "error"; message: string };

/** 백그라운드 작업을 한 번 묻고, 끝났으면 **글자 그대로** 돌려준다. */
export async function pollVisionBackground(id: string): Promise<VisionPoll> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new GradeError("OPENAI_API_KEY가 설정되지 않았습니다.", 500);
  const res = await fetch(`${OPENAI_RESPONSES}/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const body = await res.text();
  if (!res.ok) {
    return { status: "error", message: `상태를 못 읽었습니다 (HTTP ${res.status}). ${body.slice(0, 300)}` };
  }
  const json = JSON.parse(body) as {
    status?: string;
    model?: string;
    error?: { message?: string } | null;
    incomplete_details?: { reason?: string } | null;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
    };
  };
  const st = json.status ?? "";
  if (st === "queued" || st === "in_progress") return { status: "running", openaiStatus: st };
  if (st !== "completed") {
    const why = json.error?.message ?? json.incomplete_details?.reason ?? st;
    return { status: "error", message: `모델이 끝내지 못했습니다 (${st}: ${why}).` };
  }
  const u = json.usage;
  const cached = u?.input_tokens_details?.cached_tokens;
  const usage: GradeUsage | undefined = u
    ? {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        ...(typeof cached === "number" && cached > 0 ? { cachedInputTokens: cached } : {}),
      }
    : undefined;
  return { status: "done", text: harvest(json), usage, model: json.model ?? "" };
}

/**
 * Gemini 로 사진 한 장 + 프롬프트를 보내 JSON 글과 usage 를 받는다(비교 화면의
 * 지문 위치 찾기용). 요청 모양은 지문 읽기와 같은 `callGeminiVision` 이다.
 */
export async function callGeminiJson(
  prompt: string,
  imageDataUrl: string,
  model: string,
  signal?: AbortSignal,
): Promise<{ text: string; usage?: GradeUsage; model: string }> {
  return callGeminiVision(prompt, imageDataUrl, "지문 위치 찾기", signal, model, 65536);
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
