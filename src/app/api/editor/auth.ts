import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { r2Configured } from "@/lib/r2";

/** 문항 제작 도구는 **무제한 계정 전용**이다. 문항은 R2 `<uid>/_editor/` 에 JSON 으로 둔다. */
export async function requireEditor(): Promise<{ ok: true; userId: string } | { ok: false; response: NextResponse }> {
  if (!isSupabaseConfigured()) return { ok: false, response: NextResponse.json({ error: "Supabase가 설정되지 않았습니다." }, { status: 503 }) };
  if (!r2Configured()) return { ok: false, response: NextResponse.json({ error: "저장소(R2)가 설정되지 않았습니다." }, { status: 503 }) };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 }) };
  const { data: ent } = await supabase.from("entitlements").select("unlimited").eq("user_id", user.id).maybeSingle();
  if (ent?.unlimited !== true) return { ok: false, response: NextResponse.json({ error: "문항 제작 도구는 무제한 계정 전용입니다." }, { status: 403 }) };
  return { ok: true, userId: user.id };
}

export const docPath = (uid: string, id: string) => `${uid}/_editor/${id}.json`;
export const indexPath = (uid: string) => `${uid}/_editor/index.json`;
export const validId = (id: string) => /^[a-z0-9-]{8,40}$/i.test(id);
