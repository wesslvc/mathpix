const NVIDIA_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";
// 주의: build.nvidia.com 카탈로그에 보이는 모델이라도 계정 키로 호출이
// 안 될 수 있다. 예전 키로 kimi-k2.6을 호출했을 땐 404 "Function '...':
// Not found for account '...'"가 났었다(카탈로그엔 있지만 그 계정엔 미제공).
// 사용자가 API 키를 새로 발급해서 다시 k2.6으로 돌려놓은 상태다.
// 또 404가 나면 /api/diagram/models 로 "이 키로 실제 호출 가능한 목록"을 확인할 것.
const NVIDIA_MODEL = "moonshotai/kimi-k2.6";

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

/** NVIDIA API가 준 에러 본문에서 사람이 읽을 만한 메시지만 뽑아낸다. */
function describeApiError(status: number, body: string): string {
  let detail = body.trim();
  try {
    const parsed = JSON.parse(body);
    detail =
      parsed?.error?.message ??
      parsed?.detail ??
      parsed?.message ??
      parsed?.title ??
      detail;
    if (typeof detail !== "string") detail = JSON.stringify(detail);
  } catch {
    // JSON이 아니면(HTML 에러 페이지 등) 원문 앞부분을 그대로 쓴다.
  }
  if (detail.length > 300) detail = `${detail.slice(0, 300)}...`;

  // 상태 코드별로 "무엇을 확인해야 하는지"를 붙여준다. 특히 403은
  // build.nvidia.com 모델 페이지에서 약관 동의(Acknowledge & Continue)를
  // 안 눌렀을 때 자주 난다.
  const hint =
    status === 401
      ? " (NVIDIA_API_KEY가 잘못됐거나 만료됐습니다)"
      : status === 403
        ? " (build.nvidia.com의 해당 모델 페이지에서 약관 동의가 필요할 수 있습니다)"
        : status === 404
          ? ` (모델 이름 "${NVIDIA_MODEL}"이 카탈로그에 없을 수 있습니다)`
          : status === 400 || status === 422
            ? " (이 모델이 요청 형식/파라미터를 지원하지 않을 수 있습니다)"
            : status >= 500
              ? " (NVIDIA 서버 오류입니다. 잠시 후 재시도해주세요)"
              : "";

  return `도형 재구성 API 오류 ${status}${hint}: ${detail || "(응답 본문 없음)"}`;
}

/**
 * 사용자가 직접 오려낸 도형 이미지(data URL)를 NVIDIA API 카탈로그의
 * kimi-k2.6(Moonshot AI, MoonViT 비전 인코더가 달린 네이티브 멀티모달
 * 모델)에 보내 깨끗한 SVG로 다시 그리게 한다. OpenAI 호환
 * chat/completions 형식이라 image_url에 data URL을 그대로 넣는다.
 *
 * 실패 시: 원인을 알 수 있는 경우(HTTP 에러)는 상태 코드와 API가 준
 * 메시지를 그대로 담아 throw하고(호출부가 크레딧을 환불하고 그 메시지를
 * 사용자에게 보여준다), 응답은 정상인데 SVG를 못 뽑은 경우만 null을
 * 반환한다. 예전엔 모든 실패를 null로 뭉개서 "왜 안 되는지"를 전혀 알
 * 수 없었기 때문에 이렇게 나눠둔 것이다.
 *
 * (모델 변경 이력: 가벼운 nemotron-nano-12b-v2-vl → 품질이 떨어져
 * llama-3.2-90b-vision-instruct → 너무 느려 11b → 중간에 실제로는 이
 * 카탈로그에 없는 phi-3.5-vision-instruct로 잘못 바꿨다가 11b로 되돌림
 * → 사용자 요청으로 kimi-k2.6. 같은 계정/키로 호출하는 무료 엔드포인트라
 * 비용 차이는 없음.)
 */
export async function vectorizeDiagram(
  imageDataUrl: string,
): Promise<string | null> {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) return null;

  const res = await fetch(NVIDIA_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: NVIDIA_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 8192,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(
      `[diagramVector] ${NVIDIA_MODEL} 호출 실패 ${res.status} ${res.statusText}: ${body.slice(0, 2000)}`,
    );

    if (res.status === 429) {
      // 계정 분당 요청 한도(RPM) 초과. 재시도하면 될 문제라 명확히 구분해
      // 알려준다.
      throw new Error(
        "NVIDIA API 요청 한도(분당 요청 수)를 초과했습니다. 잠시 후 다시 시도해주세요.",
      );
    }
    throw new Error(describeApiError(res.status, body));
  }

  const json = await res.json();
  const message = json.choices?.[0]?.message;
  // 일부 추론(thinking) 모델은 본문을 content가 아니라 reasoning_content에
  // 담아 보내기도 해서, content가 비면 그쪽도 확인한다.
  const text: string | undefined =
    message?.content || message?.reasoning_content;

  if (!text) {
    console.error(
      `[diagramVector] ${NVIDIA_MODEL} 응답에 본문이 없음: ${JSON.stringify(json).slice(0, 2000)}`,
    );
    return null;
  }

  const svg = extractSvg(text);
  if (!svg) {
    console.error(
      `[diagramVector] ${NVIDIA_MODEL} 응답에서 <svg>를 못 찾음: ${text.slice(0, 1000)}`,
    );
    return null;
  }
  return sanitizeSvg(svg);
}
