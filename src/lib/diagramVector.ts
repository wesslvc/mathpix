// Gemini는 NVIDIA(OpenAI 호환)와 요청 형식이 완전히 다르다. 엔드포인트 경로에
// 모델명이 들어가고, 이미지는 image_url이 아니라 inline_data(base64 원문)로 넣는다.
// 주의: /api/diagram/models 목록에 있어도 호출은 404가 날 수 있다. 2.5-flash-lite가
// 목록엔 있었는데 "no longer available to new users"로 막혔다(구세대 은퇴).
// -latest 별칭을 쓰면 구글이 알아서 현행 세대로 라우팅해줘서 이 문제를 피한다.
//
// 사용자가 두 모델 중 고른다. flash는 품질이 좋은 대신 무료 등급 RPD(하루 요청
// 수)를 빨리 소진하므로 결제자에게 하루 5장(플래시쿠폰)으로 묶고, lite는
// 사진인식권 5장을 받고 자유롭게 쓰게 한다. 과금·한도는 전부 서버에서
// 강제한다(supabase/migrations/0010_diagram_model_quota.sql).
export const DIAGRAM_MODELS = {
  flash: "gemini-flash-latest",
  lite: "gemini-flash-lite-latest",
} as const;

export type DiagramModel = keyof typeof DIAGRAM_MODELS;

export function isDiagramModel(value: unknown): value is DiagramModel {
  return value === "flash" || value === "lite";
}

function endpointFor(model: DiagramModel): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${DIAGRAM_MODELS[model]}:generateContent`;
}

// Gemini 3 계열은 thinking이 기본 ON이라 SVG를 뱉기 전에 추론 토큰을 잔뜩 쓴다.
// 3.6-flash로 처음 돌렸을 때 출력 토큰이 10K 가까이 튀면서 8192 한도에 걸려
// </svg>가 잘려나갔고(그래서 "다시 그리지 못했습니다"), 60초 함수 제한도 넘겼다.
// Vercel Hobby는 maxDuration 60초가 상한이라 시간을 늘릴 수 없으니 출력을 줄여야 한다.
//
// 문제는 thinking을 끄는 필드 이름이 세대마다 다르다는 것 —
// Gemini 3.x는 thinkingLevel, 2.5는 thinkingBudget이고, 모르는 필드를 보내면 400이 난다.
// -latest 별칭은 지금 어느 세대에 붙어 있는지 알 수 없으므로, 400이 나면
// 다음 후보로 넘어가며 순서대로 시도한다(400은 즉시 떨어져서 비용이 거의 없다).
const THINKING_CONFIGS: (Record<string, unknown> | null)[] = [
  { thinkingConfig: { thinkingLevel: "low" } },
  { thinkingConfig: { thinkingBudget: 0 } },
  null, // 전부 거부당하면 thinking을 켠 채로라도 시도한다
];

/** thinking 관련 필드를 몰라서 난 400인지(=다음 후보로 재시도) 판별한다. */
function isUnknownThinkingFieldError(status: number, body: string): boolean {
  return status === 400 && /thinking/i.test(body);
}

const PROMPT = `이 이미지는 수학 문제집에 있는 도형(원, 삼각형, 그래프 등)입니다.
이 도형을 원본과 최대한 똑같은 비율·각도·위치로, 깨끗한 벡터 그래픽으로 다시 그려주세요.

가장 중요한 것은 "어느 점에서 만나는가"입니다. 수학 문제는 도형의 예쁨이 아니라
점들의 관계로 풀리므로, 아래를 먼저 정확히 파악한 뒤에 그리세요.
- 교점: 두 선(또는 곡선)이 만나는 지점의 좌표를 먼저 정하고, 양쪽 선이 반드시 그
  좌표를 정확히 지나가게 그리세요. 선이 교점 근처에서 어긋나거나 스치듯 지나가면 안 됩니다.
- 접점: 접선이나 접하는 원은 딱 한 점에서만 닿아야 합니다. 파고들거나 떨어지면 안 됩니다.
- 곡선이 x축·y축과 만나는 점, 극대·극소점, 꼭짓점의 위치를 원본과 같게 맞추세요.
- 한 점에 여러 선이 모이면(삼각형의 꼭짓점, 수선의 발, 중점 등) 그 선들이 모두
  정확히 같은 좌표에서 만나게 하세요.
- 어떤 점이 선분 위에 있으면(내분점, 수선의 발 등) 반드시 그 선분 위에 놓으세요.
- 라벨(A, B, P, O 등)은 그 점이 가리키는 위치 바로 옆에 붙이고, 서로 겹치지 않게 하세요.

함수 그래프(좌표평면)라면 다음을 지키세요.
- x축과 y축을 직선으로 긋고 원점 O를 표시하세요. 원본에 축 화살표나 축 이름(x, y)이
  있으면 그대로 넣으세요.
- 그래프가 축과 만나는 점(x절편, y절편)의 위치를 원본과 같게 맞추고, 원본에 그 좌표가
  적혀 있으면 숫자도 같이 쓰세요.
- 곡선의 모양을 원본 그대로 유지하세요: 어디서 증가하고 감소하는지, 극대·극소가 몇 개이고
  어디인지, 위로 볼록인지 아래로 볼록인지, 변곡점이 있는지.
- 점근선이 있으면 원본과 같은 위치에 점선으로 긋고, 곡선이 점근선에 닿거나 넘어가지
  않게 하세요.
- 여러 그래프가 함께 있으면 서로 만나는 점의 개수와 위치를 원본과 똑같이 하세요
  (한 번 만나는지 두 번 만나는지가 문제의 핵심인 경우가 많습니다).
- 눈금과 격자가 있으면 간격을 일정하게 그리고, 표시된 눈금 숫자를 그대로 적으세요.
- 색칠된 영역(정적분 넓이 등)이 있으면 경계를 정확히 맞춰 같은 방식으로 칠하세요.

그 밖의 규칙:
- 점, 선분, 각도 표시, 직각 표시, 라벨(문자/숫자)까지 원본에 보이는 그대로 재현하세요.
- 새로운 내용을 추가하거나 원본에 없는 부분을 생략하지 마세요.
- 배경은 흰색(투명 없음)으로, 선 색은 검정으로 통일하세요.
- 답은 오직 하나의 <svg>...</svg> 태그로만 출력하세요. 설명이나 코드블록 표시(\`\`\`) 없이 SVG 마크업만 출력하세요.
- viewBox는 원본 이미지의 가로세로 비율에 맞게 설정하세요.
- 생각 과정을 적지 말고 곧바로 SVG를 출력하세요. 곡선은 path 하나로 간결하게 그리고,
  불필요한 주석·중복 좌표·과도한 소수점 자리는 쓰지 마세요.
- 교점 좌표는 숫자로 정해두고 그 값을 양쪽 도형에 그대로 재사용하세요(눈대중으로
  두 번 따로 찍으면 어긋납니다).`;

function extractSvg(text: string): string | null {
  const match = text.match(/<svg[\s\S]*?<\/svg>/i);
  return match ? match[0] : null;
}

/**
 * LLM이 만든 SVG는 그대로 dangerouslySetInnerHTML에 들어가므로, 실행 가능한
 * 부분(스크립트 태그, 이벤트 핸들러 속성, javascript: 스킴)을 제거해둔다.
 */
function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/(href\s*=\s*["'])\s*javascript:[^"']*/gi, "$1");
}

/**
 * "data:image/jpeg;base64,XXXX" 형태의 data URL을 Gemini가 요구하는
 * { mimeType, data } 로 쪼갠다. Gemini는 접두어 없는 순수 base64만 받는다.
 */
function parseDataUrl(
  dataUrl: string,
): { mimeType: string; data: string } | null {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

/** Gemini가 준 에러 본문에서 사람이 읽을 만한 메시지만 뽑아낸다. */
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

  // 상태 코드별로 "무엇을 확인해야 하는지"를 붙여준다.
  const hint =
    status === 400
      ? " (요청 형식이 맞지 않거나 API 키가 잘못됐습니다)"
      : status === 403
        ? " (API 키 권한이 없거나 Generative Language API가 비활성 상태입니다)"
        : status === 404
          ? ` (모델 "${modelId}"이 이 키로 접근 가능한 목록에 없습니다)`
          : status === 429
            ? " (무료 사용량 한도를 초과했습니다. 잠시 후 다시 시도해주세요)"
            : status >= 500
              ? " (Gemini 서버 오류입니다. 잠시 후 재시도해주세요)"
              : "";

  return `도형 재구성 API 오류 ${status}${hint}: ${detail || "(응답 본문 없음)"}`;
}

/**
 * 사용자가 직접 오려낸 도형 이미지(data URL)를 Gemini에 보내 깨끗한 SVG로
 * 다시 그리게 한다.
 *
 * 실패 시: 원인을 알 수 있는 경우(HTTP 에러)는 상태 코드와 API가 준 메시지를
 * 그대로 담아 throw하고(호출부가 크레딧을 환불하고 그 메시지를 사용자에게
 * 보여준다), 응답은 정상인데 SVG를 못 뽑은 경우만 null을 반환한다.
 *
 * (모델 변경 이력: Gemini 2.0 Flash → 계정에서 사라져 2.5 Flash/Flash-Lite →
 * 429가 계속 나 NVIDIA 카탈로그로 이동 → nemotron-nano-12b-v2-vl(품질 부족) →
 * llama-3.2-90b(너무 느림) → 11b → phi-3.5(카탈로그에 없는 모델이었음) →
 * kimi-k2.6(404, 계정 미제공) → nemotron-nano-vl-8b → 사용자 요청으로 다시
 * Gemini 2.5 Flash Lite(신규 사용자 미제공 404) → gemini-3.6-flash →
 * -latest 별칭 2종(사용자가 flash/lite 중 선택).
 * 이 키로 실제 부를 수 있는 모델 목록은 /api/diagram/models 로 확인한다.)
 */
export async function vectorizeDiagram(
  imageDataUrl: string,
  model: DiagramModel,
): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const modelId = DIAGRAM_MODELS[model];
  const endpoint = endpointFor(model);

  const image = parseDataUrl(imageDataUrl);
  if (!image) {
    console.error("[diagramVector] data URL 형식이 아님");
    return null;
  }

  let res: Response | null = null;
  for (const thinking of THINKING_CONFIGS) {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: PROMPT },
              { inline_data: { mime_type: image.mimeType, data: image.data } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 16384,
          ...thinking,
        },
      }),
    });

    if (res.ok) break;

    const body = await res.text().catch(() => "");
    if (isUnknownThinkingFieldError(res.status, body)) {
      // 이 세대가 모르는 필드였다. 다음 후보로 넘어간다.
      console.warn(
        `[diagramVector] ${modelId}이 ${JSON.stringify(thinking)}를 거부함, 다음 후보 시도: ${body.slice(0, 300)}`,
      );
      continue;
    }

    console.error(
      `[diagramVector] ${modelId} 호출 실패 ${res.status} ${res.statusText}: ${body.slice(0, 2000)}`,
    );
    throw new Error(describeApiError(res.status, body, modelId));
  }

  if (!res || !res.ok) {
    throw new Error(
      "도형 재구성 요청이 모두 거부됐습니다(thinking 설정 호환 실패). 서버 로그를 확인해주세요.",
    );
  }

  const json = await res.json();
  const candidate = json?.candidates?.[0];
  const finishReason: string | undefined = candidate?.finishReason;

  // thinking이 켜져 있으면 추론 파트가 thought: true로 섞여 온다. 그건 SVG가 아니다.
  const text: string | undefined = candidate?.content?.parts
    ?.filter((p: { thought?: boolean }) => !p?.thought)
    .map((p: { text?: string }) => p?.text ?? "")
    .join("");

  if (!text) {
    // 안전필터에 걸리면 parts 없이 finishReason만 온다. 원인을 남겨둔다.
    console.error(
      `[diagramVector] ${modelId} 응답에 본문이 없음(finishReason=${finishReason}): ${JSON.stringify(json).slice(0, 2000)}`,
    );
    if (finishReason === "MAX_TOKENS") {
      throw new Error(
        "모델이 생각하는 데 출력 한도를 다 써서 도형을 그리지 못했습니다. 도형 영역을 더 좁게 잘라서 다시 시도해주세요.",
      );
    }
    return null;
  }

  const svg = extractSvg(text);
  if (!svg) {
    console.error(
      `[diagramVector] ${modelId} 응답에서 <svg>를 못 찾음(finishReason=${finishReason}): ${text.slice(0, 1000)}`,
    );
    // 출력 한도에 걸리면 </svg>가 잘려서 여기로 온다. 원인을 사용자에게 알려준다.
    if (finishReason === "MAX_TOKENS") {
      throw new Error(
        "도형이 너무 복잡해 출력이 중간에 잘렸습니다. 도형 영역을 더 좁게 잘라서 다시 시도해주세요.",
      );
    }
    return null;
  }
  return sanitizeSvg(svg);
}
