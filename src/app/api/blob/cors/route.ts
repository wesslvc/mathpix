import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { r2Configured, r2Head, r2PresignGet, r2PresignPut, r2Put } from "@/lib/r2";

/**
 * 브라우저가 R2 와 **직접**(CORS) 주고받을 수 있는지 시험할 주소 둘을 준다 — 읽기(공용 작은 파일)·쓰기(자기 `_probe/` 경로).
 * 화면(`r2Direct.ts`)이 둘 다 되면 `r2d=1` 쿠키를 심고, 그때부터 `/api/card` 는 R2 로 넘겨 주고 올리기는 R2 로 바로 간다.
 * 버킷 CORS 가 없으면 시험이 실패하고 예전처럼 우리 서버를 거친다(느려질 뿐 깨지지 않는다).
 */
export const dynamic = "force-dynamic";

const CHECK_PATH = "_meta/cors-check.txt";

export async function GET() {
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

  try {
    if ((await r2Head(CHECK_PATH)) === null) await r2Put(CHECK_PATH, new TextEncoder().encode("ok"), "text/plain");
    const probePath = `${user.id}/_probe/cors-${crypto.randomUUID()}.txt`;
    const [{ url: get }, put] = await Promise.all([r2PresignGet(CHECK_PATH, "cors"), r2PresignPut(probePath, 120)]);
    return NextResponse.json({ get, put, probePath }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[blob/cors] 시험 주소를 못 만듦:", err);
    return NextResponse.json({ error: "R2 시험 주소를 만들지 못했습니다." }, { status: 502 });
  }
}
