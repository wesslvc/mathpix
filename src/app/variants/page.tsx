import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import VariantPanel from "@/components/VariantPanel";

/** 변형문제 생성 — 시험 중이라 무제한 계정에만 보인다(서버 API 도 같은 조건으로 막는다). */
export default async function VariantsPage() {
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
  if (ent?.unlimited !== true) return gate("변형문제 생성은 아직 시험 중이라 무제한 계정에서만 쓸 수 있어요.");
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6">
      <h1 className="mb-1 text-lg font-semibold text-ink">변형문제 생성</h1>
      <p className="mb-4 text-sm text-slate-500">
        문제를 고르면 sol 이 핵심 논리·계산은 두고 숫자만 바꾼 변형을 설계하고, sunburst 가 원본 이미지(그림 포함)를 고쳐 그려요.
      </p>
      <VariantPanel />
    </main>
  );
}
