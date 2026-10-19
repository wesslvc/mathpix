import { NextRequest, NextResponse } from "next/server";
import { requireFontAdmin } from "../admin/kice-font/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadAsDataUrl, removeStored, splitDataUrl, storeBytes } from "@/lib/figureRun";
import { originPathFor, submitReady } from "@/lib/variantBatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * **변형문제를 Batch 로 넣는다**(무제한 계정 전용, `variantBatch.ts`). 화면이 원본을 `<uid>/_jobs/` 에 올리고 경로와 변형 설정을 보낸다.
 * `{items:[{srcPath, params:{categoryId, level, novelty, copy, copies, srcKey, srcLabel, no, width, height, effort, quality}}]}`
 * → 원본을 `_origins/` 로 옮기고 변형마다 한 줄을 넣은 뒤 곧바로 설계(plan) batch 를 건다.
 */
export async function POST(req: NextRequest) {
  const gate = await requireFontAdmin();
  if (!gate.ok) return gate.response;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  let body: { items?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }
  const raw = Array.isArray(body.items) ? (body.items as { srcPath?: unknown; params?: unknown }[]).slice(0, 300) : [];
  const own = (v: unknown): v is string => typeof v === "string" && v.length < 300 && v.startsWith(`${user.id}/_jobs/`) && !v.includes("..") && /^[\w./-]+$/.test(v);
  const admin = createAdminClient();
  const groupId = crypto.randomUUID();
  const moved = new Map<string, string>();
  const rows: Record<string, unknown>[] = [];
  const cats = new Set<string>();
  for (const r of raw) {
    const params = (r.params && typeof r.params === "object" ? r.params : {}) as Record<string, unknown>;
    const cat = typeof params.categoryId === "string" ? params.categoryId : "";
    if (!own(r.srcPath) || !/^[0-9a-f-]{36}$/i.test(cat)) continue;
    cats.add(cat);
    const srcKey = typeof params.srcKey === "string" && params.srcKey ? params.srcKey.slice(0, 200) : r.srcPath;
    if (!moved.has(r.srcPath)) {
      const url = await loadAsDataUrl(admin, r.srcPath);
      const parts = url ? splitDataUrl(url) : null;
      const dest = originPathFor(user.id, srcKey);
      if (!parts || !(await storeBytes(admin, dest, parts.bytes, parts.mime))) continue;
      moved.set(r.srcPath, dest);
    }
    rows.push({ user_id: user.id, group_id: groupId, category_id: cat, src_path: moved.get(r.srcPath), params: { ...params, srcKey }, stage: "plan" });
  }
  if (!rows.length) return NextResponse.json({ error: "넣을 변형이 없어요." }, { status: 400 });
  const { data: owned } = await admin.from("categories").select("id").eq("user_id", user.id).in("id", [...cats]);
  const ok = new Set((owned ?? []).map((c) => c.id as string));
  const valid = rows.filter((r) => ok.has(r.category_id as string));
  if (!valid.length) return NextResponse.json({ error: "저장할 묶음을 찾지 못했어요." }, { status: 400 });
  const { error } = await admin.from("variant_batch_items").insert(valid);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await removeStored(admin, [...moved.keys()]);
  let submitted = 0;
  try {
    submitted = await submitReady(admin, Date.now() + 200_000);
  } catch (err) {
    console.warn("[variant-batch] 첫 batch 걸기 실패 — cron 이 다시 시도합니다:", err instanceof Error ? err.message : err);
  }
  return NextResponse.json({ ok: true, groupId, count: valid.length, submitted });
}
