import { NextResponse } from "next/server";
import { FIGURE_TOKEN_COST, OCR_TOKEN_COST } from "@/lib/tokens";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
// 잔액은 요청마다 다르다. 정적으로 구워지면 남의 잔액이 보일 수 있다.
export const dynamic = "force-dynamic";

export type TokenStatus = {
  /** 남은 토큰. 모르면(Supabase 미설정) null. */
  tokens: number | null;
  unlimited: boolean;
  paid: boolean;
  /** 기능별 소모량. 화면에 숫자를 하드코딩하지 않으려고 서버가 알려준다. */
  ocrCost: number;
  figureCost: number;
  /** AI 그림 생성이 가능한 상태인가(OPENAI_API_KEY 설정 여부). */
  figureReady: boolean;
};

/**
 * 남은 토큰과 기능별 소모량을 알려준다.
 *
 * entitlements를 직접 읽는다 — 0006에 "자기 행만 select" 정책이 있어서
 * 새 RPC나 마이그레이션 없이 그대로 조회된다.
 */
export async function GET() {
  const base = {
    ocrCost: OCR_TOKEN_COST,
    figureCost: FIGURE_TOKEN_COST,
    figureReady: Boolean(process.env.OPENAI_API_KEY),
  };

  if (!isSupabaseConfigured()) {
    return NextResponse.json({
      ...base,
      tokens: null,
      unlimited: false,
      paid: false,
    } satisfies TokenStatus);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const { data } = await supabase
    .from("entitlements")
    .select("credits, active, unlimited")
    .eq("user_id", user.id)
    .maybeSingle();

  return NextResponse.json({
    ...base,
    // 행이 아직 없으면 첫 사용 때 서버가 기본값으로 만들어 준다(0007 참고).
    tokens: data?.credits ?? null,
    unlimited: data?.unlimited ?? false,
    paid: Boolean(data?.active) || Boolean(data?.unlimited),
  } satisfies TokenStatus);
}
