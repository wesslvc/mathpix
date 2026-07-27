import { NextRequest, NextResponse } from "next/server";
import { vectorizeDiagram } from "@/lib/diagramVector";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** 도형 추가인식 1회당 차감되는 크레딧(OCR 1개와 별도). */
const DIAGRAM_CREDIT_COST = 2;

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

  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY가 설정되지 않아 도형 재구성 기능을 쓸 수 없습니다." },
      { status: 500 },
    );
  }

  let supabase: Awaited<ReturnType<typeof createClient>> | null = null;
  if (isSupabaseConfigured()) {
    supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    }

    const { data: remaining, error: rpcError } = await supabase.rpc(
      "consume_recognition_credit",
      { p_amount: DIAGRAM_CREDIT_COST },
    );
    if (rpcError) {
      return NextResponse.json({ error: rpcError.message }, { status: 500 });
    }
    if (remaining === null) {
      return NextResponse.json(
        {
          error: `도형 재구성에는 사진인식권 ${DIAGRAM_CREDIT_COST}개가 필요합니다. 남은 인식권이 부족해요.`,
        },
        { status: 402 },
      );
    }
  }

  try {
    const svg = await vectorizeDiagram(body.image);
    if (!svg) {
      if (supabase) {
        try {
          await supabase.rpc("refund_recognition_credit", {
            p_amount: DIAGRAM_CREDIT_COST,
          });
        } catch {
          // 환불 실패는 무시 — 사용자에게는 원래 오류만 보여준다.
        }
      }
      return NextResponse.json(
        { error: "도형을 다시 그리지 못했습니다. 다시 시도해주세요." },
        { status: 502 },
      );
    }

    return NextResponse.json({ svg });
  } catch (err) {
    if (supabase) {
      try {
        await supabase.rpc("refund_recognition_credit", {
          p_amount: DIAGRAM_CREDIT_COST,
        });
      } catch {
        // 환불 실패는 무시.
      }
    }
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
