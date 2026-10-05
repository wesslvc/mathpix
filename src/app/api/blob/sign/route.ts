import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { r2Configured, r2PresignPut } from "@/lib/r2";

/**
 * 브라우저가 **R2 로 직접** 올릴 서명 주소를 준다(2026-10-05). 예전에는 그림 바이트가 `/api/blob` 을 지나며 Vercel 함수
 * 전송량(Fast Origin Transfer, 무료 10GB)으로 셌다. 여기서는 로그인·임자만 확인하고 주소만 주므로 오가는 것은 몇 백 바이트다.
 * 규칙은 `/api/blob` 과 같다 — 경로 첫 조각이 그 사용자 id 여야 한다. 주소는 10분짜리다.
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!r2Configured()) return NextResponse.json({ error: "R2가 설정되어 있지 않습니다." }, { status: 501 });
  let supabase;
  try {
    supabase = await createClient();
  } catch {
    return NextResponse.json({ error: "저장소가 설정되어 있지 않습니다." }, { status: 503 });
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { paths?: unknown };
  const paths = Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === "string") : [];
  if (paths.length === 0 || paths.length > 20) {
    return NextResponse.json({ error: "경로가 없거나 너무 많습니다." }, { status: 400 });
  }
  if (paths.some((p) => p.split("/")[0] !== user.id || p.includes(".."))) {
    return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });
  }
  const urls = await Promise.all(paths.map((p) => r2PresignPut(p)));
  return NextResponse.json({ urls });
}
