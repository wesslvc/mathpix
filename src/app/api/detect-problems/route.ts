import { NextResponse, type NextRequest } from "next/server";
import { DetectError, detectKoreanRegions, detectProblems } from "@/lib/detectProblems";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 지면 한 장에서 문제마다의 영역을 찾아 돌려준다.
 *
 * **무제한 계정 전용이다.** 실험적인 기능이고 한 번에 열 몇 문제를 통째로 다시
 * 그리는 일로 이어지므로, 일반 사용자에게 열어 두면 요금이 순식간에 커진다.
 * 화면에서도 감추지만 막는 자리는 여기다 — 화면은 얼마든지 우회할 수 있다.
 */
export async function POST(req: NextRequest) {
  let body: { image?: string; mode?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }
  if (!body.image || typeof body.image !== "string") {
    return NextResponse.json(
      { error: "image(base64 data URL) 필드가 필요합니다." },
      { status: 400 },
    );
  }

  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase가 설정되지 않았습니다." }, { status: 503 });
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  const { data: ent } = await supabase
    .from("entitlements")
    .select("unlimited")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!ent?.unlimited) {
    return NextResponse.json(
      { error: "이 기능은 무제한 계정에서만 쓸 수 있습니다." },
      { status: 403 },
    );
  }

  try {
    // 국어는 지문과 문제를 **한 번의 호출로 함께** 잡는다 — 나누면 그만큼
    // 돈이 더 든다. 뒤처리(묶기·이어 붙이기)가 달라서 함수만 갈린다.
    if (body.mode === "korean") {
      const { regions, model } = await detectKoreanRegions(body.image);
      return NextResponse.json({ regions, model });
    }
    const { problems, model } = await detectProblems(body.image);
    return NextResponse.json({ problems, model });
  } catch (err) {
    const status = err instanceof DetectError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "문제 영역 인식에 실패했습니다." },
      { status: status >= 400 && status < 600 ? status : 500 },
    );
  }
}
