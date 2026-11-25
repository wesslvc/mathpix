import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import EditorApp from "@/components/editor/EditorApp";

/** 평가원 스타일 문항 제작 에디터 — 무제한 계정 전용(서버 API 도 같은 조건으로 막는다). */
export default async function EditorPage() {
  const gate = (msg: React.ReactNode) => (
    <main className="mx-auto max-w-md px-4 py-10 text-center text-sm text-slate-500">{msg}</main>
  );
  if (!isSupabaseConfigured()) return gate("Supabase 설정이 아직 완료되지 않았습니다.");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return gate(
      <>
        로그인이 필요합니다.{" "}
        <Link href="/login" className="text-blue-600 underline">
          로그인
        </Link>
      </>,
    );
  }
  const { data: ent } = await supabase.from("entitlements").select("unlimited").eq("user_id", user.id).maybeSingle();
  if (ent?.unlimited !== true) return gate("문항 제작 도구는 무제한 계정에서만 쓸 수 있어요.");
  return (
    <main className="mx-auto w-full max-w-[1500px] px-4 py-5">
      <h1 className="mb-1 text-lg font-semibold text-ink">문항 제작</h1>
      <p className="mb-4 text-sm text-slate-500">
        평가원 양식으로 문항을 만들어요. sol 이 초안·수정·검수를 돕고, 그림은 AI 가 SVG 로 그려요. PDF(평가원 틀)·한글(HWPX)로 내보낼 수 있어요.
      </p>
      <EditorApp />
    </main>
  );
}
