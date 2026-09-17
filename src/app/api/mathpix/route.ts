import { NextRequest, NextResponse } from "next/server";
import { recognizeImage } from "@/lib/mathpixClient";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { OCR_TOKEN_COST } from "@/lib/tokens";
import { getBillingContext } from "@/lib/byod";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: { image?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "잘못된 요청 본문입니다." },
      { status: 400 },
    );
  }

  if (!body.image || typeof body.image !== "string") {
    return NextResponse.json(
      { error: "image(base64 data URL) 필드가 필요합니다." },
      { status: 400 },
    );
  }

  // mock 응답(Mathpix 키 미설정)은 실제 API 호출이 아니므로 크레딧을 쓰지 않는다.
  const isMock = !process.env.MATHPIX_APP_ID || !process.env.MATHPIX_APP_KEY;

  let supabase: Awaited<ReturnType<typeof createClient>> | null = null;
  if (!isMock && isSupabaseConfigured()) {
    supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    }

    // **BYOD 패스는 Mathpix를 무제한 무료로 쓴다**(사용자 결정) — Mathpix는
    // OpenAI와 무관한 별도 제공자라 본인 키와 상관없이, 그냥 토큰만 안 받는다
    // (무제한 계정과 같은 대우다).
    const { unlimited, byod } = await getBillingContext(supabase, user.id);
    if (!unlimited && !byod) {
      // **`p_amount`를 명시적으로 넘긴다.** 예전엔 안 넘겨서 DB 함수의 기본값
      // (1)에 기대고 있었다 — `OCR_TOKEN_COST`를 5로 올려도 여기서 안 넘기면
      // 실제 차감은 그대로 1이었을 것이다.
      const { data: remaining, error: rpcError } = await supabase.rpc(
        "consume_recognition_credit",
        { p_amount: OCR_TOKEN_COST },
      );
      if (rpcError) {
        return NextResponse.json({ error: rpcError.message }, { status: 500 });
      }
      if (remaining === null) {
        return NextResponse.json(
          {
            error: `토큰이 부족해요. 문제 인식에는 최소 ${OCR_TOKEN_COST}토큰이 필요합니다.`,
          },
          { status: 402 },
        );
      }
    }
  }

  try {
    const result = await recognizeImage(body.image, {
      appId: process.env.MATHPIX_APP_ID,
      appKey: process.env.MATHPIX_APP_KEY,
    });

    return NextResponse.json(result);
  } catch (err) {
    // Mathpix 호출 자체가 실패했다면 방금 차감한 크레딧을 되돌려준다.
    if (supabase) {
      try {
        await supabase.rpc("refund_recognition_credit");
      } catch {
        // 환불 실패는 무시 — 사용자에게는 원래 오류만 보여준다.
      }
    }
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
