import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/supabase/env";

// `/auth` 아래는 전부 공개다 — 확인 링크(callback·confirm)는 로그인 전에
// 열리는 것이라 인증 가드에 걸리면 아예 처리되지 않는다.
const PUBLIC_PATHS = ["/login", "/auth"];

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

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
