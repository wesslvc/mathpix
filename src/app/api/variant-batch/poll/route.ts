import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { workerToken } from "@/lib/figureJobsServer";
import { pollBatches, submitReady } from "@/lib/variantBatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** pg_cron(`kick_variant_batches`)이 1분마다 부른다 — 끝난 batch 를 처리하고 다음 단계를 건다. 일꾼 비밀값으로만 열린다. */
export async function POST(req: NextRequest) {
  const admin = createAdminClient();
  const token = await workerToken(admin);
  const given = req.headers.get("x-worker-token");
  if (!token || !given || given !== token) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const deadline = Date.now() + 240_000;
  const polled = await pollBatches(admin, deadline - 60_000);
  const submitted = await submitReady(admin, deadline);
  return NextResponse.json({ ...polled, submitted });
}
