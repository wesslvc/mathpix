import subsetFont from "subset-font";
import fontkit from "@pdf-lib/fontkit";
import { KICE_FONT_FILES } from "./fonts";
import frames from "../../../public/kice/frames.json";

/**
 * **PC 없이 글꼴을 올린다.**
 *
 * `scripts/upload-kice-fonts.mjs`는 `pyftsubset`(Python)로 미리 잘라 둔
 * 파일을 요구한다 — 컴퓨터가 있어야 한다. 여기서는 원본 TTF를 **그대로**
 * 받아 서버(`/api/admin/kice-font`)에서 `subset-font`(harfbuzz WASM)로 직접
 * 잘라 올린다. 휴대폰 브라우저만으로 끝난다.
 *
 * **(한)신중명조는 한글을 통째로 넣는다.** 정답표의 답과 실모 제목, 이제는
 * 지문 본문까지 사용자가 자유롭게 타이핑하는 글이라 미리 셀 수 없다 — 이
 * 파일에 대해서만은 "필요한 글자만" 대신 "완성형 한글 전체"를 남긴다.
 * 나머지 넷(신그래픽체·디나루·견명조·태고딕)은 문제지 틀에 박힌 글자와
 * 우리가 갈아 끼우는 글자만 있으면 되므로 좁게 자른다 — 그러지 않으면
 * pyftsubset 쪽과 달리 파일이 다시 몇 MB로 불어난다.
 */

/** 완성형 한글 전체(U+AC00~D7A3) + 라틴/기호 + 자모·원문자. */
function fullHangulText(): string {
  const parts: string[] = [];
  for (let cp = 0xac00; cp <= 0xd7a3; cp++) parts.push(String.fromCodePoint(cp));
  for (let cp = 0x0020; cp <= 0x007e; cp++) parts.push(String.fromCodePoint(cp));
  for (let cp = 0x3131; cp <= 0x318e; cp++) parts.push(String.fromCodePoint(cp));
  for (let cp = 0x2460; cp <= 0x2473; cp++) parts.push(String.fromCodePoint(cp));
  for (let cp = 0x3260; cp <= 0x327f; cp++) parts.push(String.fromCodePoint(cp));
  return parts.join("");
}

/**
 * 나머지 네 글꼴이 실제로 그리는 글자.
 *
 * `upload-kice-fonts.mjs`의 `EXTRA` 표와 같은 값이다 — frames.json에 박힌
 * 글자 + 우리가 갈아 끼우는 영역명·과목명·정답표 머리글. 둘이 갈라지면
 * 한쪽으로 올린 글꼴만 온전하다.
 */
const FRAME_EXTRA: Record<string, string> = {
  "신그래픽체":
    "국어수학영어사회탐구과학탐구영역" +
    "생활과윤리사상한국지리세계동아시아사경제정치법문화" +
    "물리학Ⅰ화명생명과지구Ⅱ",
  "(한)신중명조": "번호정답①②③④⑤",
};

function textFromFrames(): string {
  const seen = new Set<string>();
  const walk = (frame: unknown) => {
    if (!frame || typeof frame !== "object") return;
    const items = (frame as { items?: unknown }).items;
    if (!Array.isArray(items)) return;
    for (const it of items) {
      if (it && typeof it === "object" && (it as { k?: unknown }).k === "text") {
        const t = (it as { t?: unknown }).t;
        if (typeof t === "string") for (const c of t) seen.add(c);
      }
    }
  };
  for (const set of Object.values(frames as Record<string, unknown>)) {
    if (!set || typeof set !== "object") continue;
    for (const frame of Object.values(set as Record<string, unknown>)) walk(frame);
  }
  return [...seen].join("");
}

/** 이 글꼴 이름에 대해 얼마나 넓게 남길지 정한다. */
function textFor(fontName: string): string {
  if (fontName === "(한)신중명조") return fullHangulText();
  return textFromFrames() + (FRAME_EXTRA[fontName] ?? "") + "0123456789";
}

export type SubsetResult = {
  bytes: Uint8Array;
  missing: string[];
};

/**
 * 원본 TTF를 필요한 글자만 남기고 자른다.
 *
 * **자른 뒤 실제로 그 글자가 있는지 다시 확인한다** — 원본에 애초에 없는
 * 글자는 잘라내도 여전히 없다. 잘라 낸 글자는 PDF에서 조용히 네모(⊠)로
 * 찍히므로, 여기서 미리 알려 준다(`pdf.ts`의 `fontForText`와 같은 걱정).
 */
export async function subsetKiceFont(
  fontName: string,
  original: Buffer,
): Promise<SubsetResult> {
  const text = textFor(fontName);
  const bytes = await subsetFont(original, text, {
    targetFormat: "sfnt",
    noHinting: true,
  });

  const missing: string[] = [];
  try {
    const font = fontkit.create(bytes);
    const need = new Set(text);
    for (const ch of need) {
      if (!ch.trim()) continue;
      if (!font.hasGlyphForCodePoint(ch.codePointAt(0)!)) missing.push(ch);
    }
  } catch {
    // 확인만 실패한 것이지 자르기 자체는 됐다 — 결과는 그대로 돌려준다.
  }
  return { bytes, missing };
}

/** 이 이름이 올릴 수 있는 글꼴인지(버킷 파일명도 함께). */
export function kiceFontFile(fontName: string): string | null {
  return KICE_FONT_FILES[fontName] ?? null;
}
