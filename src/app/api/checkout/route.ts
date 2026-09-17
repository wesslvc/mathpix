import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Plan = "tokens" | "byod" | "legacy";

/**
 * `?plan=`으로 어느 그로블 상품·환경변수로 보낼지 고른다.
 *
 * **`ref`에 심는 접두사가 곧 웹훅이 얼마를 줄지 결정한다** — 그로블 결제
 * 이벤트 자체에는 "어느 옵션을 샀는지"를 우리가 아직 안정적으로 읽을 방법이
 * 없어서(옵션마다 다른 상품을 따로 만들었다), 결제로 보내기 **전에** 우리가
 * 만든 `ref` 문자열이 유일한 단서다.
 *
 * `plan=tokens`(기본, 5000토큰)의 환경변수가 아직 안 채워졌으면 옛
 * 상품(`GROBLE_PAYMENT_URL`, 1000토큰)으로 내려간다 — 이때 반드시
 * `ref`도 `legacy`로 찍어야 한다. **가격도 개수도 다른데 `tokens`로 찍으면
 * 3150원 내고 5000토큰을 받아 우리가 크게 밑진다.**
 */
function resolvePlan(requested: string | null): { plan: Plan; paymentUrl: string } | null {
  if (requested === "byod") {
    const url = process.env.GROBLE_PAYMENT_URL_BYOD;
    return url ? { plan: "byod", paymentUrl: url } : null;
  }
  const tokensUrl = process.env.GROBLE_PAYMENT_URL_TOKENS;
  if (tokensUrl) return { plan: "tokens", paymentUrl: tokensUrl };
  const legacyUrl = process.env.GROBLE_PAYMENT_URL;
  return legacyUrl ? { plan: "legacy", paymentUrl: legacyUrl } : null;
}

/**
 * 참조값(?ref=) 규칙: 영문/숫자/-_.:=~ 1~128자.
 * crypto.randomUUID()는 [0-9a-f-]만 쓰므로 규칙에 안전하다.
 *
 * **접두사(`ord_<plan>_`)를 그대로 남긴다** — 웹훅(`grantCredits`)이 이
 * 문자열만 보고 얼마를 줄지 정한다. 이 배포 전에 만들어진 옛 ref(접두사
 * 없는 `ord_<hex>`)는 여전히 legacy 로 처리된다(웹훅 쪽 기본값).
 */
function makeRef(plan: Plan): string {
  return `ord_${plan}_${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * 로그인 사용자를 위한 결제 참조값을 만들어 저장하고, 그로블 결제창으로
 * `?ref=<토큰>`을 붙여 리다이렉트한다. 결제 완료 웹훅이 이 토큰으로 사용자를 찾는다.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const resolved = resolvePlan(url.searchParams.get("plan"));
  if (!resolved) {
    return NextResponse.json(
      {
        error:
          "결제창이 아직 설정되지 않았습니다 (GROBLE_PAYMENT_URL_TOKENS / GROBLE_PAYMENT_URL_BYOD).",
      },
      { status: 503 },
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const ref = makeRef(resolved.plan);
  const { error } = await supabase
    .from("payment_refs")
    .insert({ ref, user_id: user.id });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const target = new URL(resolved.paymentUrl);
  target.searchParams.set("ref", ref);
  return NextResponse.redirect(target.toString());
}
