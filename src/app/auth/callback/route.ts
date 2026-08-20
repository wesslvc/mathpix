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
    // **여기까지 왔으면 이메일 확인 자체는 이미 끝났다.** Supabase 의
    // `/verify` 가 `email_confirmed_at` 을 먼저 찍고 나서 이쪽으로 코드를
    // 넘겨주기 때문이다(운영 데이터로 확인 — 확인 시각이 `/verify` 시각과
    // 같고, 교환은 한 번도 일어나지 않았는데도 계정은 확인 상태였다).
    // 실패한 것은 **자동 로그인**뿐이다. 그런데 예전 문구는 "확인 링크를
    // 처리하지 못했다, 메일을 다시 받아라"라고 해서 이미 끝난 일을 다시
    // 하게 만들었다 — 그래 봐야 같은 자리에서 또 막힌다.
    return NextResponse.redirect(
      `${base}/login?error=${encodeURIComponent(
        "이메일 확인은 끝났습니다. 다만 자동 로그인은 되지 않았어요(가입할 때와 다른 기기·브라우저에서 링크를 열면 이렇게 됩니다). 아래에 가입한 이메일과 비밀번호로 로그인해주세요.",
      )}&confirmed=1`,
    );
  }

  return NextResponse.redirect(`${base}${next}`);
}
