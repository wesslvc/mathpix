export type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RecognizeResponse = {
  mock: boolean;
  latex: string;
  text: string;
  confidence: number | null;
  error?: string;
};
