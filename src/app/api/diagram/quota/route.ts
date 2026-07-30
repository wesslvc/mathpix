import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
// 항상 최신 잔량을 보여줘야 하므로 캐시하지 않는다.
export const dynamic = "force-dynamic";

export type DiagramQuota = {
  /** 이용권을 결제했는지(무제한 계정도 true). flash는 결제자만 쓸 수 있다. */
  paid: boolean;
  /** 한도 없이 쓸 수 있는 계정인지(운영자 등). */
  unlimited: boolean;
  /** 남은 사진인식권(무료 사용자의 lite 도형 재구성에 쓰인다). */
  credits: number;
  /** 이 사용자에게 lite가 공짜인지(결제자는 무료). */
  liteFree: boolean;
  /** 오늘 남은 플래시쿠폰. 미결제자는 0. */
  flashRemaining: number;
  /** 하루에 주어지는 플래시쿠폰 수. */
  flashDailyLimit: number;
  /** 무료 사용자가 lite 1회에 쓰는 사진인식권 수. */
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
    unlimited: Boolean(raw.unlimited),
    credits: Number(raw.credits ?? 0),
    liteFree: Boolean(raw.lite_free),
    flashRemaining: Number(raw.flash_remaining ?? 0),
    flashDailyLimit: Number(raw.flash_daily_limit ?? 0),
    liteCost: Number(raw.lite_cost ?? 0),
  };
  return NextResponse.json(quota);
}
