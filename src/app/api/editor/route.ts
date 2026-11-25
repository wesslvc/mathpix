import { NextRequest, NextResponse } from "next/server";
import { r2Delete, r2Get, r2Put } from "@/lib/r2";
import { readDoc, type QIndexRow } from "@/lib/editor/doc";
import { docPath, indexPath, requireEditor, validId } from "./auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function readIndex(uid: string): Promise<QIndexRow[]> {
  const res = await r2Get(indexPath(uid)).catch(() => null);
  if (!res) return [];
  try {
    const v = (await res.json()) as unknown;
    return Array.isArray(v) ? (v as QIndexRow[]) : [];
  } catch {
    return [];
  }
}
const writeIndex = (uid: string, rows: QIndexRow[]) => r2Put(indexPath(uid), new TextEncoder().encode(JSON.stringify(rows)), "application/json");

/** 목록(최근 고친 것부터) 또는 `?id=` 문항 하나. */
export async function GET(req: NextRequest) {
  const auth = await requireEditor();
  if (!auth.ok) return auth.response;
  const id = req.nextUrl.searchParams.get("id");
  if (id) {
    if (!validId(id)) return NextResponse.json({ error: "잘못된 id" }, { status: 400 });
    const res = await r2Get(docPath(auth.userId, id));
    if (!res) return NextResponse.json({ error: "없는 문항입니다." }, { status: 404 });
    return NextResponse.json({ doc: readDoc(await res.json(), id) });
  }
  const rows = await readIndex(auth.userId);
  rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return NextResponse.json({ items: rows });
}

/** 저장(새로 만들기도 같다). */
export async function POST(req: NextRequest) {
  const auth = await requireEditor();
  if (!auth.ok) return auth.response;
  const body = (await req.json().catch(() => null)) as { doc?: { id?: string } } | null;
  const id = String(body?.doc?.id ?? "");
  if (!validId(id)) return NextResponse.json({ error: "잘못된 id" }, { status: 400 });
  const doc = readDoc(body!.doc, id);
  await r2Put(docPath(auth.userId, id), new TextEncoder().encode(JSON.stringify(doc)), "application/json");
  const rows = (await readIndex(auth.userId)).filter((r) => r.id !== id);
  rows.push({ id, title: doc.title, subject: doc.subject, updatedAt: doc.updatedAt });
  await writeIndex(auth.userId, rows);
  return NextResponse.json({ doc });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireEditor();
  if (!auth.ok) return auth.response;
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!validId(id)) return NextResponse.json({ error: "잘못된 id" }, { status: 400 });
  await r2Delete([docPath(auth.userId, id)]);
  await writeIndex(auth.userId, (await readIndex(auth.userId)).filter((r) => r.id !== id));
  return NextResponse.json({ ok: true });
}
