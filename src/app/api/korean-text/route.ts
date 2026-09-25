import { NextRequest, NextResponse } from "next/server";
import { GradeError, readKoreanMarks, readKoreanRichText } from "@/lib/gradeExam";
import { gradingEstKrw } from "@/lib/tokens";
import { startGradingBilling } from "@/lib/gradingBilling";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { getBillingContext } from "@/lib/byok";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 지문 한 편을 통째로 옮겨 적는 일이라 채점보다 출력이 길다.
// sol medium 으로 지문 한 편의 글자와 모양을 한 번에 읽는다 — 오래 걸릴 수 있다.
export const maxDuration = 300;

/**
 * 지문 인식(국어) 1회의 **고정 차감액**.
 *
 * **실사용량 정산이 아니라 고정 차감이다**(사용자 결정, 2026-09-17). 원가가
 * 얼마든 항상 100토큰을 뗀다 — `startGradingBilling`에 `flat: true`를 넘겨
 * 정산 단계를 건너뛴다.
 */
const DEPOSIT = 100;

/**
 * 서식 검수(`task: "marks"`, 두 번째 호출)의 보증금. **실사용량으로 정산**한다 —
 * 글자는 이미 읽었고 서식만 다시 보는 일이라 지문 인식보다 훨씬 싸다(띠 사진
 * 몇 장 + 짧은 JSON). 남으면 돌려주고 모자라면 더 받는다.
 */
const MARKS_DEPOSIT = 30;

/** 한 지문에 붙여 보낼 그림 수 상한. */
const MAX_FIGURES = 8;

/**
 * 국어 지문 사진을 **구조화된 글자**로 옮긴다.
 *
 * 모델이 문단·상자·서식 구간을 구분해 주면 **우리가 평가원 글꼴로 조판**한다
 * (`textFlow.ts`). 글자와 모양을 **한 번의 호출로** 읽는다(`readKoreanRichText`,
 * 2026-09-25) — 예전의 "글자 먼저 읽고 참고 글로 넘기기"는 걷어냈다.
 */
export async function POST(req: NextRequest) {
  let body: {
    image?: unknown;
    figures?: unknown;
    task?: unknown;
    strips?: unknown;
    paragraphs?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }
  const image = typeof body.image === "string" ? body.image : "";
  if (!image) {
    return NextResponse.json({ error: "지문 사진이 필요합니다." }, { status: 400 });
  }
  const marks = body.task === "marks";
  // 서식 검수: 확대한 가로 띠들과 첫 번째 호출이 읽은 문단 글.
  const strips = Array.isArray(body.strips)
    ? body.strips
        .filter((f): f is string => typeof f === "string" && f.startsWith("data:image/"))
        .slice(0, 8)
    : [];
  const paragraphs = Array.isArray(body.paragraphs)
    ? body.paragraphs
        .filter((t): t is string => typeof t === "string")
        .slice(0, 300)
        .map((t) => t.slice(0, 4000))
    : [];
  if (marks && paragraphs.length === 0) {
    return NextResponse.json({ error: "검수할 문단이 없습니다." }, { status: 400 });
  }
  // luna 가 찾은 지문 안 그림들(잘라 낸 것). sol 이 그 자리를 짚는다.
  const figures = Array.isArray(body.figures)
    ? body.figures
        .filter((f): f is string => typeof f === "string" && f.startsWith("data:image/"))
        .slice(0, MAX_FIGURES)
    : [];

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
  const { unlimited, byok, byokApiKey } = await getBillingContext(supabase, user.id);

  if (byok && !byokApiKey) {
    return NextResponse.json(
      {
        error:
          "BYOK 패스 계정인데 아직 OpenAI 키를 등록하지 않았어요. /profile 에서 먼저 등록해주세요.",
      },
      { status: 402 },
    );
  }
  if (!process.env.OPENAI_API_KEY && !byokApiKey) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY 가 설정되지 않아 지문 인식을 쓸 수 없습니다." },
      { status: 500 },
    );
  }

  let billing;
  try {
    billing = await startGradingBilling(supabase, {
      unlimited,
      byok,
      deposit: marks ? MARKS_DEPOSIT : DEPOSIT,
      label: marks ? "api/korean-text:marks" : "api/korean-text",
      flat: !marks,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "과금 처리에 실패했습니다." },
      { status: 500 },
    );
  }
  if (!billing) {
    return NextResponse.json(
      {
        error: `토큰이 부족해요. ${marks ? "서식 검수" : "지문 인식"}에는 최소 ${marks ? MARKS_DEPOSIT : DEPOSIT}토큰이 필요합니다.`,
      },
      { status: 402 },
    );
  }

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), (maxDuration - 15) * 1000);
  try {
    if (marks) {
      const { review, usage, model } = await readKoreanMarks(
        [image, ...strips],
        paragraphs,
        deadline.signal,
        byokApiKey ?? undefined,
      );
      const estKrw = usage ? gradingEstKrw(usage, model) : undefined;
      const chargedTokens = await billing.settle(estKrw);
      console.info(
        `[korean-text] marks model=${model} 띠=${strips.length} 문단=${paragraphs.length} ` +
          `in=${usage?.inputTokens ?? "?"} out=${usage?.outputTokens ?? "?"} ` +
          `est=${estKrw != null ? `${Math.round(estKrw)}원` : "단가미설정"} ` +
          `차감=${chargedTokens == null ? "없음(무제한)" : `${chargedTokens}토큰`}`,
      );
      return NextResponse.json({
        review,
        usage: (unlimited || byok) && usage ? { ...usage, estKrw } : undefined,
        chargedTokens,
        model,
      });
    }
    const { blocks, usage, model } = await readKoreanRichText(
      image,
      deadline.signal,
      byokApiKey ?? undefined,
      figures,
    );
    // **모델을 함께 넘긴다** — 단가가 모델마다 열 배까지 다르다.
    const estKrw = usage ? gradingEstKrw(usage, model) : undefined;
    const chargedTokens = await billing.settle(estKrw);

    // **요청마다 usage 를 찍는다**(`figureImageGen` 과 같은 이유 — 청구서만으로는
    // 무엇이 비용을 끌어올리는지 알 수 없다). 입력·출력을 갈라 찍는다.
    console.info(
      `[korean-text] usage model=${model} 그림=${figures.length} ` +
        `in=${usage?.inputTokens ?? "?"} out=${usage?.outputTokens ?? "?"} ` +
        `est=${estKrw != null ? `${Math.round(estKrw)}원` : "단가미설정"} ` +
        // 무제한 계정은 차감 자체가 없어 null 이 온다 — 그대로 찍으면
        // "차감=null토큰" 이라 마치 실패한 것처럼 보인다.
        `차감=${chargedTokens == null ? "없음(무제한)" : `${chargedTokens}토큰`}`,
    );
    return NextResponse.json({
      blocks,
      // 금액은 무제한 계정에만 보여준다(막는 자리는 서버다).
      usage: (unlimited || byok) && usage ? { ...usage, estKrw } : undefined,
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
