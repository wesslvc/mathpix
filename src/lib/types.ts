export type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Mathpix가 감지한 도형/그림 영역(원본 이미지 픽셀 좌표). 텍스트로 옮길 수 없어
 * 원본 이미지에서 그대로 오려 붙여야 하는 부분(원, 삼각형 등 그림)이다. */
export type DiagramRegion = {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
};

export type RecognizeResponse = {
  mock: boolean;
  latex: string;
  text: string;
  confidence: number | null;
  /** OCR로 옮길 수 없는 도형 영역들. 없으면 빈 배열. */
  diagrams: DiagramRegion[];
  error?: string;
};
