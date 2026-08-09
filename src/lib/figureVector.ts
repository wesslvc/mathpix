// 사회탐구·과학탐구 자료(실험 장치도, 모식도, 지층 단면, 회로도, 그래프, 지도)를
// OpenAI 비전 모델로 다시 그리는 계층.
//
// 수학 도형(diagramVector.ts, Gemini)과 일부러 완전히 분리해 뒀다. 두 API는
// 요청 모양이 다르고(이미지 넣는 법, thinking/토큰 파라미터 이름), 무엇보다
// 수학 쪽은 이미 안정적으로 돌아가고 있어서 건드리면 안 되기 때문이다.
//
// ── 비용에 대해 ────────────────────────────────────────────────────────────
// 이 API는 Gemini 무료 등급과 달리 호출할 때마다 실제로 돈이 나간다. 비용은
// 거의 전부 "출력 토큰"에서 발생한다(SVG 마크업이 길다). 그래서:
//   1) 호출 자체를 줄인다   — 사진형 자료는 아예 보내지 않는다(figureAnalysis.ts)
//                             + 같은 자료는 한 번만 보낸다(figureCache.ts)
//   2) 입력을 줄인다        — 긴 변 768px로 줄여서 보낸다(figureAnalysis.ts)
//   3) 출력을 줄인다        — MAX_OUTPUT_TOKENS 상한 + 프롬프트에서 간결함을 요구
// 1)과 2)는 브라우저에서, 3)은 여기서 한다.

/** 출력 상한. 비용의 대부분이 여기서 나오므로 넉넉하되 무제한은 아니다. */
const MAX_OUTPUT_TOKENS = 8000;

const ENDPOINT = "https://api.openai.com/v1/chat/completions";

/**
 * 후보 모델을 앞에서부터 쓰고, 404(이 키로 못 부르는 이름)면 다음으로 내려간다.
 *
 * **이 기본값은 "검증된 목록"이 아니다.** 이 저장소에서 모델 이름을 기억이나
 * 웹 검색으로 골랐다가 404를 여러 번 맞았다(phi-3.5, kimi-k2.6,
 * gemini-2.5-flash-lite — 카탈로그에 보여도 계정에 따라 못 부른다). 그래서:
 *   - 실제로 뭘 부를 수 있는지는 /api/figure/models 로 **직접 호출해 확인**하고,
 *   - 확정된 이름은 환경변수 OPENAI_FIGURE_MODELS 에 쉼표로 넣는다(재배포 불필요),
 *   - 그래도 틀리면 404가 나는 순간 다음 후보로 자동으로 내려간다.
 * 앞쪽이 싸고 뒤로 갈수록 품질이 높은 순서로 둔다.
 */
const DEFAULT_MODEL_IDS = [
  // 사용자가 지정한 모델. 계정의 /v1/models 목록에는 있지만 **실제 호출로는
  // 아직 검증되지 않았다** — 목록에 있어도 못 부르는 경우가 이 프로젝트에서
  // 여러 번 있었다. 다음 배포 뒤 /api/figure/models 를 열어 probe가 ok인지
  // 확인할 것. 못 부르면 404가 나는 순간 아래 후보로 자동으로 내려간다.
  "gpt-5.6-luna",
  // 여기부터는 2026-08 프로브에서 200을 확인한 이름들(폴백).
  "gpt-5-mini",
  "gpt-4.1-mini",
  "gpt-4o-mini",
  "gpt-5",
  "gpt-4.1",
  "gpt-4o",
];

/** 실제로 시도할 모델 목록. 환경변수가 있으면 그것만 쓴다. */
export function figureModelIds(): string[] {
  const raw = process.env.OPENAI_FIGURE_MODELS;
  if (!raw) return DEFAULT_MODEL_IDS;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return ids.length > 0 ? ids : DEFAULT_MODEL_IDS;
}

/**
 * OpenAI가 HTTP 오류를 준 경우. 상태 코드를 들고 다녀서 호출부가 "이 모델을
 * 포기하고 다음 후보로 내려갈지"를 판단할 수 있게 한다.
 */
export class FigureApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly modelId: string,
  ) {
    super(message);
    this.name = "FigureApiError";
  }

  /**
   * 이 모델로는 같은 요청을 다시 보내봐야 소용없는 상태인가.
   * 404 = 이 키로 부를 수 없는 이름, 403 = 이 모델에 대한 권한 없음,
   * 429 = 한도(속도/쿼터) 소진.
   */
  get shouldTryNextModel(): boolean {
    return this.status === 404 || this.status === 403 || this.status === 429;
  }
}

/**
 * 모델 세대마다 받는 파라미터 이름이 다르다. 신형은 max_completion_tokens,
 * 구형은 max_tokens이고, 추론 모델은 temperature를 아예 안 받는가 하면
 * reasoning_effort를 받기도 한다. 모르는 파라미터를 보내면 400이 난다.
 *
 * Gemini 쪽에서 thinking 필드 이름 때문에 똑같이 당했다(THINKING_CONFIGS).
 * 여기서도 같은 방식으로 앞에서부터 시도하고, 파라미터 때문에 난 400이면
 * 다음 조합으로 넘어간다. 400은 즉시 떨어져서 비용이 거의 없다.
 *
 * reasoning_effort를 먼저 낮게 잡는 이유: 추론 모델은 SVG를 뱉기 전에 추론
 * 토큰을 잔뜩 쓴다. Gemini 3.6에서 이것 때문에 출력 한도를 다 써서 </svg>가
 * 잘려나갔다. 같은 사고를 미리 막는다.
 */
const PARAM_VARIANTS: Record<string, unknown>[] = [
  { max_completion_tokens: MAX_OUTPUT_TOKENS, reasoning_effort: "low" },
  {
    max_completion_tokens: MAX_OUTPUT_TOKENS,
    reasoning_effort: "low",
    temperature: 0.1,
  },
  { max_completion_tokens: MAX_OUTPUT_TOKENS, temperature: 0.1 },
  { max_completion_tokens: MAX_OUTPUT_TOKENS },
  { max_tokens: MAX_OUTPUT_TOKENS, temperature: 0.1 },
  { max_tokens: MAX_OUTPUT_TOKENS },
];

/** 파라미터 이름/값 때문에 난 400인지(=다음 조합으로 재시도) 판별한다. */
function isUnsupportedParamError(status: number, body: string): boolean {
  if (status !== 400) return false;
  return /max_tokens|max_completion_tokens|temperature|reasoning_effort|unsupported|unrecognized/i.test(
    body,
  );
}

/**
 * 모델별로 "통했던 파라미터 조합"을 기억해 다음 요청부터 곧바로 쓴다.
 * 서버리스 인스턴스가 재사용되는 동안만 유지되는 캐시라 틀려도 손해는 없고,
 * 맞으면 매 요청마다 400을 몇 번씩 맞는 왕복을 없앤다.
 */
const workingVariant = new Map<string, number>();

const PROMPT = `이 이미지는 한국 고등학교 사회탐구/과학탐구 문제집에 실린 자료(그림, 도식, 그래프, 실험 장치, 모식도, 단면도, 회로도 등)입니다.
이 자료를 원본과 최대한 똑같이 벡터 그래픽(SVG)으로 다시 그려주세요.

이 자료는 문제를 푸는 데 쓰이는 정보 그 자체입니다. 예쁘게 그리는 것보다 원본에 있는
정보를 하나도 빠뜨리지 않고 정확히 옮기는 것이 훨씬 중요합니다.

가장 중요한 것 (이게 틀리면 문제를 풀 수 없습니다):
- 글자: 자료에 적힌 모든 글자(한글 라벨, 기호, 숫자, 단위)를 **원본 그대로** 옮기세요.
  비슷한 말로 바꾸거나 번역하지 말고, 보이는 글자를 그대로 쓰세요. 읽을 수 없는 글자는
  지어내지 말고 생략하세요.
- 위치 관계: 무엇이 무엇의 위 / 아래 / 안 / 밖 / 왼쪽 / 오른쪽에 있는지를 원본과 똑같이
  하세요(예: 지층의 순서, 세포 안의 소기관, 회로의 연결 순서, 대기층의 높이 순서).
- 연결: 선이나 관으로 이어진 것들은 원본과 똑같은 것끼리 이어지게 하세요. 회로라면
  어느 소자가 어느 소자와 직렬/병렬로 연결되는지가 답을 좌우합니다.
- 화살표: 방향을 원본과 똑같이 하세요(물질의 이동, 힘, 전류, 시간 순서 등). 화살표
  방향이 반대면 완전히 다른 자료가 됩니다.
- 개수: 원본에 있는 것의 개수를 그대로 지키세요(눈금, 층, 입자, 칸, 화살표 개수 등).

그래프라면 추가로:
- 가로축·세로축의 이름과 단위를 그대로 적고, 눈금 숫자도 그대로 옮기세요.
- 곡선이 어디서 증가/감소하는지, 최대·최소가 어디인지, 축과 만나는 점이 어디인지를
  원본과 같게 맞추세요.
- 여러 곡선이 있으면 서로 만나는 지점의 위치와 개수를 원본과 똑같이 하고, 범례를
  원본대로 넣으세요.

표라면 <text>로 칸 안의 값을 하나도 빠짐없이 옮기고, 칸 구분선을 그리세요.

색:
- 원본에서 색이 의미를 구분하고 있으면(지층, 영역, 계열, 온도 등) 그 구분을 유지하세요.
  색상 자체는 비슷하면 됩니다.
- 색 구분이 없는 자료는 흰 배경에 검은 선으로만 그리세요.

출력 규칙 (반드시 지켜주세요):
- 오직 하나의 <svg>...</svg> 태그만 출력하세요. 설명, 머리말, 코드블록 표시(\`\`\`)를
  절대 붙이지 마세요.
- viewBox는 원본 이미지의 가로세로 비율에 맞추세요.
- 글자는 <text>로 넣고 font-family는 지정하지 마세요.
- 생각 과정을 적지 말고 곧바로 SVG를 출력하세요.
- 간결하게 그리세요: 좌표 소수점은 한 자리까지만, 주석·중복 좌표·불필요한 그라디언트나
  필터는 쓰지 마세요. 출력이 길어지면 중간에 잘려서 그림이 통째로 못 쓰게 됩니다.`;

function extractSvg(text: string): string | null {
  const match = text.match(/<svg[\s\S]*?<\/svg>/i);
  return match ? match[0] : null;
}

/**
 * LLM이 만든 SVG는 그대로 dangerouslySetInnerHTML에 들어가므로, 실행 가능한
 * 부분(스크립트 태그, 이벤트 핸들러 속성, javascript: 스킴)과 외부 리소스를
 * 불러오는 부분을 제거해둔다.
 */
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/(href\s*=\s*["'])\s*javascript:[^"']*/gi, "$1");
}

/** OpenAI가 준 에러 본문에서 사람이 읽을 만한 메시지만 뽑아낸다. */
function describeApiError(
  status: number,
  body: string,
  modelId: string,
): string {
  let detail = body.trim();
  try {
    const parsed = JSON.parse(body);
    detail = parsed?.error?.message ?? parsed?.message ?? detail;
    if (typeof detail !== "string") detail = JSON.stringify(detail);
  } catch {
    // JSON이 아니면(HTML 에러 페이지 등) 원문 앞부분을 그대로 쓴다.
  }
  if (detail.length > 300) detail = `${detail.slice(0, 300)}...`;

  const hint =
    status === 401
      ? " (OPENAI_API_KEY가 잘못됐거나 만료됐습니다)"
      : status === 403
        ? ` (이 키로 "${modelId}" 모델을 쓸 권한이 없습니다)`
        : status === 404
          ? ` (모델 "${modelId}"이 이 키로 접근 가능한 목록에 없습니다)`
          : status === 429
            ? " (요청 한도를 초과했거나 결제 잔액이 부족합니다)"
            : status >= 500
              ? " (OpenAI 서버 오류입니다. 잠시 후 재시도해주세요)"
              : "";

  return `자료 재구성 API 오류 ${status}${hint}: ${detail || "(응답 본문 없음)"}`;
}

export type FigureResult = {
  svg: string;
  /** 이번 호출에 실제로 쓴 토큰(비용 추적용). 모르면 null. */
  inputTokens: number | null;
  outputTokens: number | null;
};

/**
 * 사용자가 오려낸 사과탐 자료 이미지(data URL)를 OpenAI에 보내 SVG로 다시 그린다.
 *
 * 실패 시: 원인을 알 수 있는 경우(HTTP 에러)는 상태 코드와 API 메시지를 담아
 * throw하고(호출부가 크레딧을 환불하고 그 메시지를 사용자에게 보여준다),
 * 응답은 정상인데 SVG를 못 뽑은 경우만 null을 반환한다. 예전에 전부 null을
 * 돌려주다가 원인을 몇 번이나 잘못 짚었던 적이 있어 이 구분을 지킨다.
 */
export async function vectorizeFigure(
  imageDataUrl: string,
  modelId: string,
): Promise<FigureResult | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  if (!/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(imageDataUrl)) {
    console.error("[figureVector] data URL 형식이 아님");
    return null;
  }

  // 이전에 통한 조합이 있으면 그것부터, 없으면 처음부터.
  const startAt = workingVariant.get(modelId) ?? 0;
  const order = [
    ...PARAM_VARIANTS.slice(startAt),
    ...PARAM_VARIANTS.slice(0, startAt),
  ];

  let res: Response | null = null;
  let usedVariant = startAt;

  for (let i = 0; i < order.length; i++) {
    const params = order[i];
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: PROMPT },
              {
                type: "image_url",
                // 라벨 글자를 읽어야 하므로 detail은 high여야 한다. 대신 이미지
                // 자체를 브라우저에서 768px로 줄여 보내 타일 수를 묶어둔다.
                image_url: { url: imageDataUrl, detail: "high" },
              },
            ],
          },
        ],
        ...params,
      }),
    });

    if (res.ok) {
      usedVariant = (startAt + i) % PARAM_VARIANTS.length;
      break;
    }

    const body = await res.text().catch(() => "");
    if (isUnsupportedParamError(res.status, body)) {
      console.warn(
        `[figureVector] ${modelId}이 ${JSON.stringify(params)}를 거부함, 다음 조합 시도: ${body.slice(0, 300)}`,
      );
      continue;
    }

    console.error(
      `[figureVector] ${modelId} 호출 실패 ${res.status} ${res.statusText}: ${body.slice(0, 2000)}`,
    );
    throw new FigureApiError(
      describeApiError(res.status, body, modelId),
      res.status,
      modelId,
    );
  }

  if (!res || !res.ok) {
    throw new Error(
      "자료 재구성 요청이 모두 거부됐습니다(파라미터 호환 실패). 서버 로그를 확인해주세요.",
    );
  }
  workingVariant.set(modelId, usedVariant);

  const json = await res.json();
  const choice = json?.choices?.[0];
  const finishReason: string | undefined = choice?.finish_reason;
  const text: string | undefined = choice?.message?.content;
  const inputTokens: number | null = json?.usage?.prompt_tokens ?? null;
  const outputTokens: number | null = json?.usage?.completion_tokens ?? null;

  if (!text) {
    console.error(
      `[figureVector] ${modelId} 응답에 본문이 없음(finish_reason=${finishReason}): ${JSON.stringify(json).slice(0, 2000)}`,
    );
    if (finishReason === "length") {
      throw new Error(
        "모델이 생각하는 데 출력 한도를 다 써서 자료를 그리지 못했습니다. 자료 영역을 더 좁게 잘라서 다시 시도해주세요.",
      );
    }
    return null;
  }

  const svg = extractSvg(text);
  if (!svg) {
    console.error(
      `[figureVector] ${modelId} 응답에서 <svg>를 못 찾음(finish_reason=${finishReason}): ${text.slice(0, 1000)}`,
    );
    // 출력 한도에 걸리면 </svg>가 잘려서 여기로 온다.
    if (finishReason === "length") {
      throw new Error(
        "자료가 너무 복잡해 출력이 중간에 잘렸습니다. 자료를 두 부분으로 나눠서 각각 재구성하거나, 원본 이미지를 그대로 붙여주세요.",
      );
    }
    return null;
  }

  return { svg: sanitizeSvg(svg), inputTokens, outputTokens };
}
