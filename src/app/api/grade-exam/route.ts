import { NextRequest, NextResponse } from "next/server";
import { GradeError, gradeWithVision, type Subject } from "@/lib/gradeExam";
import {
  GRADING_TOKEN_DEPOSIT,
  gradingEstKrw,
  gradingTokenCharge,
} from "@/lib/tokens";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 사진 최대 3장(탐구: OMR 1 + 정답표 2)을 한 번에 읽는다. detect-problems(60초,
// 사진 1장)보다 여유를 둔다.
export const maxDuration = 90;

/**
 * OMR·정답표 사진을 채점한다. 결과는 **곧바로 저장하지 않는다** — 화면이
 * 검토(수정) 화면을 먼저 보여주고, 사용자가 확인을 눌러야 `exam_scores`에
 * 저장된다(vision이 마킹을 잘못 읽는 일이 있어 사람이 보정할 자리가 필요하다).
 *
 * 과금은 그림 생성과 같은 모양(보증금 → 정산)을 쓰지만, 이 모델의 **단가를
 * 모른다**(gpt-image-2 처럼 청구서로 검증한 적이 없다). 그래서 단가
 * 환경변수를 채우지 않으면 보증금이 그대로 최종 차감액이 된다
 * (`gradingTokenCharge`, `src/lib/tokens.ts` 참고).
 */
export async function POST(req: NextRequest) {
  let body: { subject?: string; omr?: string; keys?: { slot?: number; label?: string; image?: string }[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }

  const subject: Subject =
    body.subject === "math" || body.subject === "elective" ? body.subject : "korean";
  const omr = typeof body.omr === "string" ? body.omr : null;
  const keys = Array.isArray(body.keys)
    ? body.keys.filter((k): k is { slot?: number; label?: string; image: string } =>
        typeof k?.image === "string",
      )
    : [];

  if (!omr) {
    return NextResponse.json({ error: "OMR 카드 사진이 필요합니다." }, { status: 400 });
  }
  const expectedKeys = subject === "elective" ? 2 : 1;
  if (keys.length !== expectedKeys) {
    return NextResponse.json(
      { error: `정답표 사진이 ${expectedKeys}장 필요합니다.` },
      { status: 400 },
    );
  }

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY가 설정되지 않아 자동채점을 쓸 수 없습니다." },
      { status: 500 },
    );
  }
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase가 설정되지 않았습니다." }, { status: 503 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  const userId = user.id;
  const { data: ent } = await supabase
    .from("entitlements")
    .select("unlimited")
    .eq("user_id", userId)
    .maybeSingle();
  const unlimited = ent?.unlimited === true;

  let charged = false;
  if (!unlimited) {
    const { data, error } = await supabase.rpc("consume_recognition_credit", {
      p_amount: GRADING_TOKEN_DEPOSIT,
    });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (data === null) {
      return NextResponse.json(
        { error: `토큰이 부족해요. 자동채점에는 최소 ${GRADING_TOKEN_DEPOSIT}토큰이 필요합니다.` },
        { status: 402 },
      );
    }
    charged = true;
  }

  async function refund() {
    if (!charged) return;
    try {
      await supabase.rpc("refund_recognition_credit", { p_amount: GRADING_TOKEN_DEPOSIT });
    } catch {
      // 환불 실패는 무시 — 사용자에게는 원래 오류만 보여준다.
    }
  }

  /** 보증금과 실제 값(알면)의 차이를 맞춘다. 잔액 부족으로 추가 차감이
   * 실패해도 이미 돌려준 채점 결과를 무를 수는 없으니 로그만 남긴다 — 그림
   * 생성과 달리 여기엔 "잠글" 저장된 자원이 없다(카드 이미지가 아니라 그냥
   * 텍스트 결과라 사용자가 저장하기 전까지는 아무것도 남지 않는다). */
  async function settle(estKrw: number | undefined): Promise<number | null> {
    if (!charged) return null;
    const want = gradingTokenCharge(estKrw);
    const diff = want - GRADING_TOKEN_DEPOSIT;
    try {
      if (diff < 0) {
        await supabase.rpc("refund_recognition_credit", { p_amount: -diff });
      } else if (diff > 0) {
        const { data } = await supabase.rpc("consume_recognition_credit", { p_amount: diff });
        if (data === null) {
          console.warn(`[api/grade-exam] ${userId} 잔액 부족으로 ${diff}토큰을 못 받았습니다.`);
        }
      }
    } catch (err) {
      console.error("[api/grade-exam] 정산 실패:", err);
    }
    return want;
  }

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), (maxDuration - 10) * 1000);

  try {
    const result = await gradeWithVision(
      subject,
      [omr, ...keys.map((k) => k.image)],
      deadline.signal,
    );

    const estKrw = result.usage ? gradingEstKrw(result.usage) : undefined;
    const chargedTokens = await settle(estKrw);

    // 슬롯에 사용자가 적어 준 과목명(elective_label)을 그대로 이어 붙인다.
    const slots = result.slots.map((s) => {
      const key = s.slot ? keys.find((k) => k.slot === s.slot) : keys[0];
      return { ...s, label: key?.label };
    });

    // 금액은 무제한 계정에만 보여준다(막는 자리는 서버 — 화면 숨김은 우회 가능).
    const usage = unlimited ? result.usage : undefined;

    return NextResponse.json({ slots, usage, chargedTokens, model: result.model });
  } catch (err) {
    if (deadline.signal.aborted) {
      await refund();
      return NextResponse.json(
        { error: `채점이 ${maxDuration}초 안에 끝나지 않았습니다. 토큰은 돌려드렸어요.` },
        { status: 504 },
      );
    }
    await refund();
    const status = err instanceof GradeError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "채점에 실패했습니다." },
      { status: status >= 400 && status < 600 ? status : 500 },
    );
  } finally {
    clearTimeout(timer);
  }
}
