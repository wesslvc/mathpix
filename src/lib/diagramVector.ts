const NVIDIA_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_MODEL = "nvidia/nemotron-nano-12b-v2-vl";

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
 * 사용자가 직접 오려낸 도형 이미지(data URL)를 NVIDIA API 카탈로그의
 * nemotron-nano-12b-v2-vl(비전 특화, 가벼운 모델)에 보내 깨끗한 SVG로
 * 다시 그리게 한다. 실패하면 null을 반환한다(호출부에서 크레딧 환불 처리).
 * OpenAI 호환 chat/completions 형식이라 image_url에 data URL을 그대로 넣는다.
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
      max_tokens: 4096,
    }),
  });

  if (res.status === 429) {
    // 계정 분당 요청 한도(RPM) 초과. 재시도하면 될 문제라 명확히 구분해
    // 알려준다(그 외 실패는 원인이 다양해 일반 메시지로 남긴다).
    throw new Error(
      "NVIDIA API 요청 한도(분당 요청 수)를 초과했습니다. 잠시 후 다시 시도해주세요.",
    );
  }

  if (!res.ok) return null;

  const json = await res.json();
  const text: string | undefined = json.choices?.[0]?.message?.content;
  if (!text) return null;

  const svg = extractSvg(text);
  return svg ? sanitizeSvg(svg) : null;
}
