import type { DiagramRegion, RecognizeResponse } from "./types";

const MATHPIX_ENDPOINT = "https://api.mathpix.com/v3/text";

const MOCK_RESPONSE: RecognizeResponse = {
  mock: true,
  confidence: 0.5,
  latex: "\\int_0^1 x^2 \\,dx = \\dfrac{1}{3}",
  text:
    "(Mathpix API 키가 아직 설정되지 않아 예시 결과를 표시합니다.)\n\n" +
    "21. 함수 $f(x)$가 다음 조건을 만족시킨다.\n\n" +
    "> 모든 실수 $x$에 대하여\n" +
    "> $$f(x) = \\int_0^x (t^2 - 2t) \\, dt$$\n" +
    "> 이다.\n\n" +
    "$f(2)$의 값을 구하시오. [4점]\n\n" +
    "$$\\int_0^1 x^2 \\,dx = \\dfrac{1}{3}$$",
  diagrams: [],
};

type MathpixLineData = {
  id?: string;
  type?: string;
  region?: {
    top_left_x?: number;
    top_left_y?: number;
    width?: number;
    height?: number;
  };
};

/** line_data 중 OCR로 옮길 수 없는 도형/그림 영역만 골라낸다. */
function extractDiagrams(lineData: unknown): DiagramRegion[] {
  if (!Array.isArray(lineData)) return [];
  return (lineData as MathpixLineData[])
    .filter((line) => line.type === "diagram" && line.region)
    .map((line, idx) => ({
      id: line.id ?? `diagram-${idx}`,
      left: line.region?.top_left_x ?? 0,
      top: line.region?.top_left_y ?? 0,
      width: line.region?.width ?? 0,
      height: line.region?.height ?? 0,
    }))
    .filter((d) => d.width > 0 && d.height > 0);
}

type RecognizeOptions = {
  appId: string | undefined;
  appKey: string | undefined;
};

/**
 * Mathpix v3/text API를 호출해 이미지에서 텍스트/LaTeX를 추출한다.
 * 앱 키가 아직 없다면(API 미구매 상태) 목(mock) 데이터를 반환해
 * 나머지 화면 흐름을 그대로 개발/테스트할 수 있게 한다.
 */
export async function recognizeImage(
  imageDataUrl: string,
  { appId, appKey }: RecognizeOptions,
): Promise<RecognizeResponse> {
  if (!appId || !appKey) {
    return MOCK_RESPONSE;
  }

  const res = await fetch(MATHPIX_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      app_id: appId,
      app_key: appKey,
    },
    body: JSON.stringify({
      src: imageDataUrl,
      formats: ["text", "latex_styled"],
      data_options: {
        include_latex: true,
      },
      // 도형/그림 영역의 위치(픽셀 좌표)를 받아 원본 이미지에서 그대로
      // 오려 붙일 수 있게 한다(OCR로는 도형 자체를 텍스트화할 수 없음).
      include_line_data: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Mathpix API 요청이 실패했습니다 (${res.status}): ${body || res.statusText}`,
    );
  }

  const json = await res.json();

  if (json.error) {
    throw new Error(json.error_info?.message ?? json.error);
  }

  return {
    mock: false,
    latex: json.latex_styled ?? json.text ?? "",
    text: json.text ?? "",
    confidence: typeof json.confidence === "number" ? json.confidence : null,
    diagrams: extractDiagrams(json.line_data),
  };
}
