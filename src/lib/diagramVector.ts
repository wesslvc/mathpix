// Gemini는 NVIDIA(OpenAI 호환)와 요청 형식이 완전히 다르다. 엔드포인트 경로에
// 모델명이 들어가고, 이미지는 image_url이 아니라 inline_data(base64 원문)로 넣는다.
// 주의: /api/diagram/models 목록에 있어도 호출은 404가 날 수 있다. 2.5-flash-lite가
// 목록엔 있었는데 "no longer available to new users"로 막혔다(구세대 은퇴).
// 그래서 목록 중에서도 최신 세대를 고른다. 429가 잦으면 gemini-3.5-flash-lite나
// gemini-flash-lite-latest로 내리고, 품질이 부족하면 gemini-3.6-flash 유지.
const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const PROMPT = `이 이미지는 수학 문제집에 있는 도형(원, 삼각형, 그래프 등)입니다.
이 도형을 원본과 최대한 똑같은 비율·각도·위치로, 깨끗한 벡터 그래픽으로 다시 그려주세요.
- 점, 선분, 각도 표시, 라벨(문자/숫자)까지 원본에 보이는 그대로 재현하세요.
- 새로운 내용을 추가하거나 원본에 없는 부분을 생략하지 마세요.
- 배경은 흰색(투명 없음)으로, 선 색은 검정으로 통일하세요.
- 답은 오직 하나의 <svg>...</svg> 태그로만 출력하세요. 설명이나 코드블록 표시(\`\`\`) 없이 SVG 마크업만 출력하세요.
- viewBox는 원본 이미지의 가로세로 비율에 맞게 설정하세요.`;

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
function describeApiError(status: number, body: string): string {
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
          ? ` (모델 "${GEMINI_MODEL}"이 이 키로 접근 가능한 목록에 없습니다)`
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
 * Gemini 2.5 Flash Lite(신규 사용자 미제공 404) → gemini-3.6-flash.
 * 이 키로 실제 부를 수 있는 모델 목록은 /api/diagram/models 로 확인한다.)
 */
export async function vectorizeDiagram(
  imageDataUrl: string,
): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const image = parseDataUrl(imageDataUrl);
  if (!image) {
    console.error("[diagramVector] data URL 형식이 아님");
    return null;
  }

  const res = await fetch(GEMINI_ENDPOINT, {
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
        maxOutputTokens: 8192,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(
      `[diagramVector] ${GEMINI_MODEL} 호출 실패 ${res.status} ${res.statusText}: ${body.slice(0, 2000)}`,
    );
    throw new Error(describeApiError(res.status, body));
  }

  const json = await res.json();
  const candidate = json?.candidates?.[0];
  const text: string | undefined = candidate?.content?.parts
    ?.map((p: { text?: string }) => p?.text ?? "")
    .join("");

  if (!text) {
    // 안전필터에 걸리면 parts 없이 finishReason만 온다. 원인을 남겨둔다.
    console.error(
      `[diagramVector] ${GEMINI_MODEL} 응답에 본문이 없음(finishReason=${candidate?.finishReason}): ${JSON.stringify(json).slice(0, 2000)}`,
    );
    return null;
  }

  const svg = extractSvg(text);
  if (!svg) {
    console.error(
      `[diagramVector] ${GEMINI_MODEL} 응답에서 <svg>를 못 찾음: ${text.slice(0, 1000)}`,
    );
    return null;
  }
  return sanitizeSvg(svg);
}
