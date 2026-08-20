import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { redirectBase } from "../redirectBase";

/**
 * 이메일 확인 링크를 **기기와 상관없이** 처리하는 경로.
 *
 * `/auth/callback`(PKCE, `?code=`)만으로는 모자란다. PKCE 는 가입을 시작한
 * 브라우저에 `code_verifier` 를 저장해 두고 그것과 짝을 맞춰야 세션이 되는데,
 * **메일은 다른 기기에서 열리는 일이 아주 흔하다**(PC 에서 가입하고 폰에서
 * 메일 확인). 그러면 교환이 실패하고 사용자는 이유도 모른 채 로그인 화면으로
 * 돌아온다.
 *
 * `token_hash` 는 그 짝이 필요 없다(상태가 없다). 그래서 어느 기기에서 열어도
 * 확인이 된다. Supabase 메일 템플릿을 이렇게 바꿔 두면 이 경로로 들어온다:
 *
 *   {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=signup
 *
 * 템플릿을 아직 안 바꿨더라도 `/auth/callback` 이 그대로 살아 있으므로
 * 예전 링크도 계속 동작한다.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = searchParams.get("next") ?? "/";
  const base = redirectBase(request);

  if (!tokenHash || !type) {
    return NextResponse.redirect(
      `${base}/login?error=${encodeURIComponent("확인 링크가 올바르지 않습니다. 메일의 링크를 다시 눌러주세요.")}`,
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({
    token_hash: tokenHash,
    type,
  });
  if (error) {
    // **무엇이 잘못됐는지 그대로 알린다.** 조용히 로그인 화면으로 보내면
    // 사용자는 링크가 만료된 것인지 이미 쓴 것인지 알 수 없다.
    console.error("[auth/confirm] verifyOtp 실패:", error.message);
    return NextResponse.redirect(
      `${base}/login?error=${encodeURIComponent(error.message)}`,
    );
  }

  return NextResponse.redirect(`${base}${next}`);
}
