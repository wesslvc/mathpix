import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

/**
 * 글꼴 업로드는 아무나 못 한다 — 잘못 올리면 문제지 전체가 깨진다.
 *
 * 이미 있는 `entitlements.unlimited` 를 그대로 쓴다. 새 역할·테이블을
 * 만들면 마이그레이션이 필요한데, 이 값은 이미 "믿을 수 있는 계정"이라는
 * 뜻으로 다른 곳(문제 영역 자동 찾기)에서도 쓰고 있다.
 */
export async function requireFontAdmin(): Promise<
  { ok: true } | { ok: false; response: NextResponse }
> {
  if (!isSupabaseConfigured()) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Supabase가 설정되지 않았습니다." }, { status: 503 }),
    };
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 }),
    };
  }
  const { data: ent } = await supabase
    .from("entitlements")
    .select("unlimited")
    .eq("user_id", user.id)
    .maybeSingle();
  if (ent?.unlimited !== true) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "이 계정은 글꼴을 올릴 수 없습니다." },
        { status: 403 },
      ),
    };
  }
  return { ok: true };
}
