import { NextResponse } from "next/server";
import { requireFontAdmin } from "../kice-font/auth";

/**
 * **"R2에만 있는 척" 해보는 테스트 스위치 — 내 브라우저에만 켜진다.**
 *
 * `/api/card`는 평소 R2를 먼저 보고 없으면 Supabase로 조용히 내려간다
 * (`src/app/api/card/[...path]/route.ts`). 그 안전망 때문에, 이관이 실제로
 * 다 됐는지 눈으로는 확인할 수가 없다 — 옮기다 빠뜨린 그림도 Supabase가
 * 대신 채워 줘서 똑같이 멀쩡해 보인다.
 *
 * 이 쿠키(`r2only`)가 있으면 `/api/card`가 **Supabase 쪽을 아예 안 본다** —
 * R2에 없으면 그냥 404다. 그 상태로 평소처럼 앱을 써 보면, 안 옮겨진 그림만
 * 깨져 보인다(못 옮긴 것을 정확히 짚어 준다).
 *
 * **쿠키라서 이 링크를 누른 사람의 브라우저에만 걸린다** — DB나 다른
 * 사용자에게는 영향이 없다. 무제한 계정만 켤 수 있다(`requireFontAdmin`,
 * `/api/r2/selftest`와 같은 기준) — 아무나 눌러서 자기 화면을 깨뜨리는
 * 것 자체는 위험하지 않지만, 왜 그림이 깨졌는지 모른 채 당황할 사람이
 * 생기는 걸 막는다.
 *
 * `?on=1`로 켜고 `?on=0`으로 끈다. 켜져 있다는 걸 잊지 않도록 30분 뒤
 * 저절로 꺼진다.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await requireFontAdmin();
  if (!gate.ok) return gate.response;

  const url = new URL(request.url);
  const on = url.searchParams.get("on") !== "0";
  const back = request.headers.get("referer") || new URL("/", request.url).toString();

  const res = NextResponse.redirect(back);
  if (on) {
    res.cookies.set("r2only", "1", {
      maxAge: 30 * 60,
      path: "/",
      sameSite: "lax",
    });
  } else {
    res.cookies.set("r2only", "", { maxAge: 0, path: "/" });
  }
  return res;
}
