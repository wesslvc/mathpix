import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/supabase/env";

// `/auth` 아래는 전부 공개다 — 확인 링크(callback·confirm)는 로그인 전에
// 열리는 것이라 인증 가드에 걸리면 아예 처리되지 않는다.
const PUBLIC_PATHS = ["/login", "/auth"];

/**
 * 루트(`/`)도 공개다 — 로그아웃 상태면 소개 화면을, 로그인 상태면 대시보드를
 * 보여준다(`page.tsx` 가 가른다). 검색 엔진이 색인할 내용이 있어야 해서다.
 *
 * **`PUBLIC_PATHS` 에 `"/"` 를 넣으면 안 된다.** 아래 검사가 `startsWith` 라
 * 모든 경로가 `"/"` 로 시작하므로 **앱 전체가 공개가 된다.** 그래서 루트만
 * 따로, 정확히 같은지로 본다.
 */
function isPublic(pathname: string): boolean {
  if (pathname === "/") return true;
  return PUBLIC_PATHS.some((path) => pathname.startsWith(path));
}

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

  if (!user && !isPublic(request.nextUrl.pathname)) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: [
    // **`robots.txt` · `sitemap.xml` 은 반드시 빼야 한다.** 여기 걸리면 인증
    // 가드가 크롤러를 `/login` 으로 튕겨서 **검색 엔진이 둘 다 읽지 못한다**
    // (실제로 그랬다 — 두 주소 모두 307 로 `/login` 을 돌려주고 있었다).
    // 로그인과 무관한 공개 파일이므로 아예 미들웨어를 안 타게 둔다.
    //
    // **`.html` 도 같은 이유로 뺀다.** 구글 서치 콘솔의 소유 확인 파일
    // (`google<토큰>.html`)이 `public/` 에 놓이는데, 이게 막히면 구글이
    // 파일을 못 읽어 **소유 확인이 통째로 실패한다** — robots.txt 가 막혀
    // 있던 것과 똑같은 사고다. `public/` 에 두는 파일은 원래 공개다.
    "/((?!_next/static|_next/image|favicon.ico|robots\\.txt|sitemap\\.xml|fonts/|.*\\.(?:html|svg|png|jpg|jpeg|gif|webp|woff|woff2)$).*)",
  ],
};
