import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { kiceFontFile, subsetKiceFont } from "@/lib/kice/fontSubset";
import { requireFontAdmin } from "../auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 자르기(harfbuzz WASM)는 빠르지만, 조각을 전부 내려받아 잇는 데 시간이 든다.
export const maxDuration = 60;

/**
 * 조각을 이어 붙이고, **원본 그대로**(자르지 않고) 잘라서 올린다.
 *
 * `pyftsubset` 대신 `subset-font`(harfbuzz WASM)를 쓴다 — Python이 없는
 * Vercel Node 런타임에서도 돌아간다. 이게 이 라우트가 있는 이유 전부다:
 * **컴�터 없이, 휴대폰 브라우저만으로 글꼴을 올릴 수 있게** 하려는 것.
 */
export async function POST(req: NextRequest) {
  const gate = await requireFontAdmin();
  if (!gate.ok) return gate.response;

  let body: { uploadId?: unknown; total?: unknown; fontName?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }
  const uploadId = String(body.uploadId ?? "");
  const total = Number(body.total);
  const fontName = String(body.fontName ?? "");
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(uploadId) || !Number.isInteger(total) || total <= 0) {
    return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 400 });
  }
  const file = kiceFontFile(fontName);
  if (!file) {
    return NextResponse.json({ error: "알 수 없는 글꼴 이름입니다." }, { status: 400 });
  }

  const admin = createAdminClient();
  const paths = Array.from({ length: total }, (_, i) => `_tmp/${uploadId}/${i}`);

  try {
    const parts: Uint8Array[] = [];
    for (const path of paths) {
      const { data, error } = await admin.storage.from("kice-fonts").download(path);
      if (error || !data) throw new Error(`조각을 못 읽었습니다 (${path}).`);
      parts.push(new Uint8Array(await data.arrayBuffer()));
    }
    const size = parts.reduce((n, p) => n + p.length, 0);
    const original = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      original.set(p, at);
      at += p.length;
    }

    const { bytes, missing } = await subsetKiceFont(fontName, Buffer.from(original));

    const { error: upErr } = await admin.storage
      .from("kice-fonts")
      .upload(file, bytes, { upsert: true, contentType: "font/ttf" });
    if (upErr) throw upErr;

    return NextResponse.json({
      ok: true,
      file,
      originalBytes: size,
      subsetBytes: bytes.length,
      missing,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "글꼴을 처리하지 못했습니다." },
      { status: 500 },
    );
  } finally {
    // 임시 조각은 성공하든 실패하든 지운다 — 실패했으면 처음부터 다시 보낼
    // 것이므로 남겨 둘 이유가 없다.
    await admin.storage.from("kice-fonts").remove(paths);
  }
}
