import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/supabase/env";

// `/auth` 아래는 전부 공개다 — 확인 링크(callback·confirm)는 로그인 전에
// 열리는 것이라 인증 가드에 걸리면 아예 처리되지 않는다.
const PUBLIC_PATHS = ["/login", "/auth"];

/**
 * 확인 링크가 엉뚱한 자리에 떨어져도 살려낸다.
 *
 * Supabase 는 메일 링크의 `redirect_to` 가 허용목록(Authentication > URL
 * Configuration)에 없으면 **거절하지 않고 조용히 Site URL 로 떨어뜨린다.**
 * 그러면 `?code=` 를 든 채 `/` 에 도착하는데 거기엔 그걸 받을 코드가 없어서
 * 아무 일도 일어나지 않는다 — 사용자 눈에는 "이메일 인증이 안 된다"로 보이고,
 * 계정은 확인은 됐는데 로그인은 안 된 상태로 남는다.
 *
 * 실제로 그랬다. 운영 로그를 보니 확인 링크의 절반 이상이 `/auth/callback` 이
 * 아니라 Site URL 로 갔고, 코드 교환(`grant_type=pkce`)은 **한 번도** 일어나지
 * 않았다. `auth.flow_state` 에 쓰이지 않은 코드가 그대로 쌓여 있었다.
 *
 * 허용목록은 대시보드에서만 고칠 수 있어 코드가 손댈 수 없다. 그래서 **어디에
 * 떨어지든 우리가 알맞은 경로로 넘긴다.** 설정이 틀려 있어도 확인이 된다.
 */
function rescueAuthLink(request: NextRequest): NextResponse | null {
  const { pathname, searchParams } = request.nextUrl;
  // 확인 링크가 떨어질 수 있는 자리만 본다. `/auth/*` 는 이미 제 경로이고,
  // `code` 처럼 흔한 이름을 쓰는 다른 화면까지 휩쓸면 안 된다.
  if (pathname !== "/" && pathname !== "/login") return null;

  const target = request.nextUrl.clone();

  if (searchParams.get("token_hash") && searchParams.get("type")) {
    target.pathname = "/auth/confirm";
    return NextResponse.redirect(target);
  }
  if (searchParams.get("code")) {
    target.pathname = "/auth/callback";
    return NextResponse.redirect(target);
  }
  // Supabase 가 링크 자체를 거절한 경우(만료·이미 사용)도 Site URL 로 떨어진다.
  // 조용히 삼키면 사용자는 이유를 모른다 — 로그인 화면이 보여주게 넘긴다.
  const linkError =
    searchParams.get("error_description") ?? searchParams.get("error");
  if (pathname === "/" && linkError) {
    target.pathname = "/login";
    target.search = "";
    target.searchParams.set("error", linkError);
    return NextResponse.redirect(target);
  }
  return null;
}

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const rescued = rescueAuthLink(request);
  if (rescued) return rescued;

  // 그로블 웹훅은 로그인 없이 외부에서 POST로 들어온다. 인증 리다이렉트(3xx)를
  // 하면 그로블이 최종 실패로 처리하므로, 인증 체크 전에 그대로 통과시킨다.
  if (request.nextUrl.pathname.startsWith("/api/groble/webhook")) {
    return response;
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    // Supabase가 아직 설정되지 않았다면 인증 체크 없이 통과시키고,
    // 각 페이지에서 안내 메시지를 보여준다.
    return response;
  }

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isPublicPath = PUBLIC_PATHS.some((path) =>
    request.nextUrl.pathname.startsWith(path),
  );

  if (!user && !isPublicPath) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|fonts/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff|woff2)$).*)",
  ],
};
