import sharp from "sharp";
import type { DiagramRegion } from "./types";

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

const PROMPT = `이 이미지는 수학 문제집에 있는 도형(원, 삼각형, 그래프 등)입니다.
이 도형을 원본과 최대한 똑같은 비율·각도·위치로, 깨끗한 벡터 그래픽으로 다시 그려주세요.
- 점, 선분, 각도 표시, 라벨(문자/숫자)까지 원본에 보이는 그대로 재현하세요.
- 새로운 내용을 추가하거나 원본에 없는 부분을 생략하지 마세요.
- 배경은 흰색(투명 없음)으로, 선 색은 검정으로 통일하세요.
- 답은 오직 하나의 <svg>...</svg> 태그로만 출력하세요. 설명이나 코드블록 표시(\`\`\`) 없이 SVG 마크업만 출력하세요.
- viewBox는 원본 이미지의 가로세로 비율에 맞게 설정하세요.`;

/** 원본 이미지(data URL)에서 도형 영역만 잘라낸 PNG를 만든다. */
async function cropRegion(
  imageDataUrl: string,
  region: DiagramRegion,
): Promise<Buffer> {
  const base64 = imageDataUrl.replace(/^data:image\/\w+;base64,/, "");
  const input = Buffer.from(base64, "base64");
  const image = sharp(input);
  const meta = await image.metadata();
  const maxWidth = meta.width ?? region.left + region.width;
  const maxHeight = meta.height ?? region.top + region.height;

  const left = Math.max(0, Math.round(region.left));
  const top = Math.max(0, Math.round(region.top));
  const width = Math.max(1, Math.min(Math.round(region.width), maxWidth - left));
  const height = Math.max(1, Math.min(Math.round(region.height), maxHeight - top));

  return image.extract({ left, top, width, height }).png().toBuffer();
}

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

async function callGemini(png: Buffer, apiKey: string): Promise<string | null> {
  const res = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: PROMPT },
            {
              inline_data: {
                mime_type: "image/png",
                data: png.toString("base64"),
              },
            },
          ],
        },
      ],
      generationConfig: { temperature: 0.1 },
    }),
  });

  if (!res.ok) return null;

  const json = await res.json();
  const text: string | undefined = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return null;

  const svg = extractSvg(text);
  return svg ? sanitizeSvg(svg) : null;
}

/**
 * Mathpix가 찾아낸 도형 영역들을 원본 이미지에서 잘라내 Gemini로 깨끗한
 * SVG로 다시 그리게 한다. 실패한 도형은 svg 없이 그대로 두어(호출부에서
 * 원본 크롭 이미지로 대체 표시) 전체 인식 결과에 영향을 주지 않는다.
 */
export async function vectorizeDiagrams(
  imageDataUrl: string,
  diagrams: DiagramRegion[],
): Promise<DiagramRegion[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || diagrams.length === 0) return diagrams;

  return Promise.all(
    diagrams.map(async (d) => {
      try {
        const png = await cropRegion(imageDataUrl, d);
        const svg = await callGemini(png, apiKey);
        return svg ? { ...d, svg } : d;
      } catch {
        return d;
      }
    }),
  );
}
