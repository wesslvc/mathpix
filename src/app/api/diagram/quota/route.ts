import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
// 항상 최신 잔량을 보여줘야 하므로 캐시하지 않는다.
export const dynamic = "force-dynamic";

export type DiagramQuota = {
  /** 이용권을 결제했는지. false면 도형 추가인식 자체를 쓸 수 없다. */
  paid: boolean;
  /** 남은 사진인식권(lite 도형 재구성에 쓰인다). */
  credits: number;
  /** 오늘 남은 플래시쿠폰. */
  flashRemaining: number;
  /** 하루에 주어지는 플래시쿠폰 수. */
  flashDailyLimit: number;
  /** lite 도형 재구성 1회당 차감되는 사진인식권 수. */
  liteCost: number;
};

/**
 * 도형 추가인식 버튼 옆에 "쓸 수 있는지 / 얼마나 남았는지"를 보여주기 위한
 * 조회 전용 엔드포인트. 한도 자체는 이 값이 아니라 /api/diagram의 차감 RPC가
 * 강제하므로, 여기 값이 조작돼도 실제로 더 쓸 수는 없다.
 */
export async function GET() {
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

  const { data, error } = await supabase.rpc("diagram_quota");
  if (error) {
    console.error("[api/diagram/quota] rpc error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const raw = (data ?? {}) as Record<string, unknown>;
  const quota: DiagramQuota = {
    paid: Boolean(raw.paid),
    credits: Number(raw.credits ?? 0),
    flashRemaining: Number(raw.flash_remaining ?? 0),
    flashDailyLimit: Number(raw.flash_daily_limit ?? 0),
    liteCost: Number(raw.lite_cost ?? 0),
  };
  return NextResponse.json(quota);
}
