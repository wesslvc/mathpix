import { NextRequest, NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 도형 사용량 보고(운영자용). 누가 flash/lite를 몇 번 썼는지, 오늘 전역 예산이
 * 얼마나 남았는지 돌려준다.
 *
 * 권한 검사는 DB 함수(diagram_usage_report)가 한다 — unlimited 계정이 아니면
 * 예외를 던진다. 여기서 한 번 더 확인하지 않는 이유는, 판단 기준이 두 군데로
 * 갈리면 어긋나기 때문이다.
 *
 * 사용법: /api/diagram/usage?days=7
 */
export async function GET(req: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase 미설정" }, { status: 503 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const days = Number(req.nextUrl.searchParams.get("days") ?? 7);

  const { data, error } = await supabase.rpc("diagram_usage_report", {
    p_days: Number.isFinite(days) ? Math.min(Math.max(days, 1), 90) : 7,
  });

  if (error) {
    // 무제한 계정이 아니면 DB 함수가 'forbidden'으로 예외를 던진다.
    if (error.message.includes("forbidden")) {
      return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });
    }
    console.error("[api/diagram/usage] rpc error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}
