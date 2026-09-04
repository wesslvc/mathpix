declare module "subset-font" {
  export type SubsetFontOptions = {
    targetFormat?: "sfnt" | "woff" | "woff2";
    preserveNameIds?: number[];
    keepFeatures?: string[];
    noLayoutClosure?: boolean;
    glyphNames?: boolean;
    noHinting?: boolean;
    dropTables?: string[];
    variationAxes?: Record<string, number | { min?: number; max?: number; default?: number }>;
  };
  export default function subsetFont(
    buffer: Buffer,
    text: string,
    options?: SubsetFontOptions,
  ): Promise<Buffer>;
}
