import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 문항 제작 에디터 글꼴(평가원 계열)을 원본에서 잘라 비공개 버킷 `kice-fonts` 에 올린다.
 * 배포권이 없어 저장소에는 안 넣는다. 버킷에 없을 때 글꼴 라우트가 처음 한 번 부른다.
 */
export const EDITOR_FONT_SOURCES: Record<string, string> = {
  "editor-serif.woff2": "(한)신명조.TTF",
  "editor-gothic.woff2": "(환)중고딕.TTF",
  "editor-serif-bold.woff2": "(환)견명조.TTF",
  "editor-gothic-bold.woff2": "(환)견고딕.TTF",
};

const RANGES: [number, number][] = [
  [0x20, 0x7e], [0xa1, 0xff], [0x2000, 0x206f], [0x2150, 0x218f], [0x2190, 0x21ff], [0x2200, 0x22ff],
  [0x2460, 0x24ff], [0x2500, 0x257f], [0x25a0, 0x25ff], [0x2600, 0x26ff], [0x3000, 0x303f], [0x3131, 0x318e],
  [0x3200, 0x32ff], [0xac00, 0xd7a3], [0xff01, 0xff65],
];

function subsetText(): string {
  let text = "";
  for (const [a, b] of RANGES) for (let c = a; c <= b; c++) text += String.fromCodePoint(c);
  // 마지막 글리프가 깨지는 harfbuzz 버릇을 피하는 미끼(fontSubset.ts 의 HANGUL_PADDING 과 같다)
  return text + "一二三四五六七八九十百千萬億東西南北中上下左右大小年月日時分秒";
}

export async function buildEditorFont(dest: string, admin: SupabaseClient): Promise<Uint8Array<ArrayBuffer>> {
  const src = EDITOR_FONT_SOURCES[dest];
  if (!src) throw new Error(`알 수 없는 에디터 글꼴: ${dest}`);
  const r = await fetch(`https://raw.githubusercontent.com/cm99521/mcc/HEAD/${encodeURIComponent(src)}`);
  if (!r.ok) throw new Error(`원본 글꼴을 받지 못했습니다 (${r.status})`);
  const orig = Buffer.from(await r.arrayBuffer());
  const { default: subsetFont } = await import("subset-font");
  const woff2 = await subsetFont(orig, subsetText(), { targetFormat: "woff2" });
  const { error } = await admin.storage
    .from("kice-fonts")
    .upload(dest, woff2, { contentType: "font/woff2", upsert: true });
  if (error) console.warn("[editor-font] 올리기 실패", dest, error.message);
  return new Uint8Array(woff2);
}
