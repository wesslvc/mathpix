import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { redirectBase } from "../redirectBase";

/**
 * 이메일 가입 확인 링크(PKCE)를 세션으로 바꾼다.
 *
 * **이 경로는 가입을 시작한 그 브라우저에서만 성공한다.** PKCE 는 `signUp()`
 * 때 그 브라우저에 저장해 둔 `code_verifier` 와 짝을 맞춰야 하는데, 메일은
 * 다른 기기에서 열리는 일이 흔하다(PC 로 가입하고 폰에서 확인). 그래서
 * 기기와 무관한 `/auth/confirm`(token_hash) 를 따로 뒀고 메일 템플릿은 그쪽을
 * 가리키는 게 좋다. 이 경로는 예전 링크가 계속 동작하도록 남겨 둔다.
 *
 * **실패를 조용히 넘기지 않는다.** 예전에는 그냥 `/login` 으로 보냈는데,
 * 그러면 사용자는 링크가 만료된 것인지 다른 기기에서 열어서인지 알 수 없고
 * 우리도 로그가 없어 진단하지 못했다.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";
  const base = redirectBase(request);

  // Supabase 가 링크 자체를 거절한 경우(만료·이미 사용 등)를 그대로 전달한다.
  const linkError =
    searchParams.get("error_description") ?? searchParams.get("error");
  if (linkError) {
    console.error("[auth/callback] 링크 오류:", linkError);
    return NextResponse.redirect(
      `${base}/login?error=${encodeURIComponent(linkError)}`,
    );
  }

  if (!code) {
    return NextResponse.redirect(
      `${base}/login?error=${encodeURIComponent("확인 링크가 올바르지 않습니다. 메일의 링크를 다시 눌러주세요.")}`,
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    console.error(
      "[auth/callback] exchangeCodeForSession 실패:",
      error.message,
    );
    return NextResponse.redirect(
      `${base}/login?error=${encodeURIComponent(
        "확인 링크를 처리하지 못했습니다. 가입할 때 쓴 것과 다른 기기·브라우저에서 링크를 열면 이렇게 됩니다. 로그인 화면에서 확인 메일을 다시 보내 같은 기기에서 열어주세요.",
      )}`,
    );
  }

  return NextResponse.redirect(`${base}${next}`);
}
