import { NextRequest, NextResponse } from "next/server";
import { recognizeImage } from "@/lib/mathpixClient";
import { vectorizeDiagrams } from "@/lib/diagramVector";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

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

    const { data: remaining, error: rpcError } = await supabase.rpc(
      "consume_recognition_credit",
    );
    if (rpcError) {
      return NextResponse.json({ error: rpcError.message }, { status: 500 });
    }
    if (remaining === null) {
      return NextResponse.json(
        {
          error:
            "사진인식권이 모두 소진됐습니다. 이용권을 구매하면 1000개가 충전돼요.",
        },
        { status: 402 },
      );
    }
  }

  try {
    const result = await recognizeImage(body.image, {
      appId: process.env.MATHPIX_APP_ID,
      appKey: process.env.MATHPIX_APP_KEY,
    });

    // 도형이 감지됐고 Gemini 키가 있으면 깨끗한 SVG로 재구성한다. 실패해도
    // 인식 결과 자체는 그대로 돌려준다(클라이언트가 원본 크롭으로 대체 표시).
    if (result.diagrams.length > 0) {
      try {
        result.diagrams = await vectorizeDiagrams(body.image, result.diagrams);
      } catch {
        // 무시 — diagrams는 원본(svg 없는) 상태로 남는다.
      }
    }

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
