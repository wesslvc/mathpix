import { NextRequest, NextResponse } from "next/server";
import { GradeError, readKoreanRichText } from "@/lib/gradeExam";
import { gradingEstKrw } from "@/lib/tokens";
import { startGradingBilling } from "@/lib/gradingBilling";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 지문 한 편을 통째로 옮겨 적는 일이라 채점보다 출력이 길다.
export const maxDuration = 180;

/** 이 일에 걸어 두는 보증금. 끝나면 실사용량으로 정산한다. */
const DEPOSIT = 5;

/**
 * 국어 지문 사진을 **구조화된 글자**로 옮긴다.
 *
 * 지금까지 지문은 오려낸 사진 한 장이었다. 그러면 확대하면 흐려지고, 단을
 * 따라 흘릴 수도 없고, 평가원 판형의 글꼴과 어긋난다. 모델이 문단·상자·강조를
 * 구분해 주면 **우리가 평가원 글꼴로 조판**한다(`textFlow.ts`).
 *
 * **Mathpix 가 읽은 글을 함께 준다.** 글자를 정확히 읽는 일은 Mathpix 가 낫고,
 * 무엇이 문단이고 무엇이 상자인지 가리는 일은 vision 모델이 낫다 — 둘의
 * 잘하는 것을 겹쳐 쓴다(문제 전체 다시 그리기에서 쓰던 방식과 같다).
 */
export async function POST(req: NextRequest) {
  let body: { image?: unknown; reference?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }
  const image = typeof body.image === "string" ? body.image : "";
  if (!image) {
    return NextResponse.json({ error: "지문 사진이 필요합니다." }, { status: 400 });
  }
  const reference = typeof body.reference === "string" ? body.reference.slice(0, 12000) : "";

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY가 설정되지 않아 지문 인식을 쓸 수 없습니다." },
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
  const { data: ent } = await supabase
    .from("entitlements")
    .select("unlimited")
    .eq("user_id", user.id)
    .maybeSingle();
  const unlimited = ent?.unlimited === true;

  let billing;
  try {
    billing = await startGradingBilling(supabase, {
      unlimited,
      deposit: DEPOSIT,
      label: "api/korean-text",
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "과금 처리에 실패했습니다." },
      { status: 500 },
    );
  }
  if (!billing) {
    return NextResponse.json(
      { error: `토큰이 부족해요. 지문 인식에는 최소 ${DEPOSIT}토큰이 필요합니다.` },
      { status: 402 },
    );
  }

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), (maxDuration - 15) * 1000);
  try {
    const { blocks, usage, model } = await readKoreanRichText(
      image,
      reference,
      deadline.signal,
    );
    const estKrw = usage ? gradingEstKrw(usage) : undefined;
    const chargedTokens = await billing.settle(estKrw);
    return NextResponse.json({
      blocks,
      // 금액은 무제한 계정에만 보여준다(막는 자리는 서버다).
      usage: unlimited && usage ? { ...usage, estKrw } : undefined,
      chargedTokens,
      model,
    });
  } catch (err) {
    await billing.refund();
    if (deadline.signal.aborted) {
      return NextResponse.json(
        { error: "지문 인식이 제때 끝나지 않았습니다. 토큰은 돌려드렸어요." },
        { status: 504 },
      );
    }
    const status = err instanceof GradeError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "지문 인식에 실패했습니다." },
      { status: status >= 400 && status < 600 ? status : 500 },
    );
  } finally {
    clearTimeout(timer);
  }
}
