import { stripCardBorder } from "./stripBorder";

/**
 * 저장된 문제 그림(카드 PNG)을 받아 온다. PDF 와 ZIP 내보내기가 같이 쓴다.
 *
 * 카드 주소는 그림을 고칠 때마다 새로 생기므로(내용이 안 바뀐다) 브라우저 캐시를 그대로 쓴다 — 예전엔 no-store 라 PDF 를
 * 만들 때마다 문제 그림을 전부 다시 받았다. 예전에 저장된 문제에는 카드 테두리가 구워져 있는데 실제 문제지에는 없는
 * 네모라서 여기서 지운다.
 */
export async function loadPng(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`이미지를 불러오지 못했습니다 (HTTP ${res.status}).`);
  return stripCardBorder(new Uint8Array(await res.arrayBuffer()));
}
