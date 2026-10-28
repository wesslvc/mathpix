import { NextRequest, NextResponse } from "next/server";
import { requireFontAdmin } from "../admin/kice-font/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { removeStored } from "@/lib/figureRun";
import type { VariantAutoState } from "@/lib/variantAuto";
import { enqueueOp } from "@/lib/variantOps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * **변형문제 자동 검수·수정의 손잡이**(무제한 계정 전용, `variantAuto.ts`).
 *
 * 전부 OpenAI Batch 로 돈다(`variantOps.ts`) — 여기서는 작업(`variant_ops`)만 넣고, pg_cron 이 1분 안에 깨워 batch 로 건다.
 * - `{action:"start", ids}`   재검수를 건다(진행 중·통과한 것은 건너뛴다, `force` 면 통과한 것도).
 * - `{action:"approve", ids}` 승인 대기인 것을 승인 → 그림 편집(draw)으로 끝까지 수정(high). 끝나면 저절로 재검수.
 * - `{action:"accept", ids}`  지적이 있어도 지금 그대로 확정(통과로 적고 보관하던 이전 그림을 지운다).
 */
export async function POST(req: NextRequest) {
  const gate = await requireFontAdmin();
  if (!gate.ok) return gate.response;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  let body: { action?: unknown; ids?: unknown; force?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }
  const action = body.action;
  if (action !== "start" && action !== "approve" && action !== "accept") {
    return NextResponse.json({ error: "알 수 없는 동작이에요." }, { status: 400 });
  }
  const ids = Array.isArray(body.ids)
    ? [...new Set((body.ids as unknown[]).filter((x): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 300)
    : [];
  if (!ids.length) return NextResponse.json({ error: "문제를 고르세요." }, { status: 400 });

  const admin = createAdminClient();
  const { data: rows, error } = await admin.from("problems").select("id,image_path,box_range").eq("user_id", user.id).in("id", ids);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const now = new Date().toISOString();
  let done = 0;
  for (const row of rows ?? []) {
    const br = ((row.box_range ?? {}) as Record<string, unknown>) || {};
    const st = br.variantAuto as VariantAutoState | undefined;
    if (action === "start") {
      if (st?.status === "checking" || st?.status === "fixing" || st?.status === "rendering") continue;
      if (st?.status === "passed" && body.force !== true) continue;
      if (!(await enqueueOp(admin, user.id, row.id, "check"))) continue;
      const next: VariantAutoState = { ...(st ?? { round: 0 }), round: st?.round ?? 0, status: "checking", notes: undefined, message: undefined, at: now };
      await admin.from("problems").update({ box_range: { ...br, variantAuto: next } }).eq("id", row.id).eq("user_id", user.id);
      done++;
    } else if (action === "approve") {
      if (st?.status !== "needs_approval" || !st.notes?.length) continue;
      // 수정은 늘 그림 편집으로 끝까지 간다(SVG 덮개는 쓰지 않는다). 처음 만들 때(medium) 한 번에 안 된 것이니 고칠 때는 high.
      const quality = "high";
      if (!(await enqueueOp(admin, user.id, row.id, "draw", { notes: st.notes, quality, ...(st.lastFail ? { lastFail: st.lastFail } : {}) }))) continue;
      await admin.from("problems").update({ box_range: { ...br, variantAuto: { ...st, status: "fixing", at: now } } }).eq("id", row.id).eq("user_id", user.id);
      done++;
    } else {
      if (st?.status === "checking" || st?.status === "fixing") continue;
      const keep = row.image_path as string;
      const old = [st?.baseImagePath, (br.variantFix as { prevImagePath?: string } | undefined)?.prevImagePath].filter((p): p is string => !!p && p !== keep);
      await admin
        .from("problems")
        .update({
          box_range: {
            ...br,
            variantFix: undefined,
            variantRecheck: undefined,
            variantReview: undefined,
            variantAuto: { status: "passed", round: st?.round ?? 0, at: now, message: "그대로 확정" },
          },
        })
        .eq("id", row.id)
        .eq("user_id", user.id);
      if (old.length) await removeStored(admin, old);
      done++;
    }
  }
  return NextResponse.json({ ok: true, done });
}
