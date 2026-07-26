import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 참조값(?ref=) 규칙: 영문/숫자/-_.:=~ 1~128자.
 * crypto.randomUUID()는 [0-9a-f-]만 쓰므로 규칙에 안전하다.
 */
function makeRef(): string {
  return `ord_${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * 로그인 사용자를 위한 결제 참조값을 만들어 저장하고, 그로블 결제창으로
 * `?ref=<토큰>`을 붙여 리다이렉트한다. 결제 완료 웹훅이 이 토큰으로 사용자를 찾는다.
 */
export async function GET(request: Request) {
  const paymentUrl = process.env.GROBLE_PAYMENT_URL;
  if (!paymentUrl) {
    return NextResponse.json(
      { error: "결제창이 아직 설정되지 않았습니다 (GROBLE_PAYMENT_URL)." },
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

  const ref = makeRef();
  const { error } = await supabase
    .from("payment_refs")
    .insert({ ref, user_id: user.id });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const target = new URL(paymentUrl);
  target.searchParams.set("ref", ref);
  return NextResponse.redirect(target.toString());
}
