import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { getAccessState, isByokCheckoutReady, isCheckoutReady } from "@/lib/billing";
import type { Subject } from "@/lib/gradeSummary";
import BillingStatus from "@/components/BillingStatus";
import ByokSettingsForm from "@/components/ByokSettingsForm";
import Logo from "@/components/Logo";
import GradingPrefsForm, { type GradingPrefsValue } from "@/components/GradingPrefsForm";
import CropShapeSetting from "@/components/CropShapeSetting";
import LinkedAccounts from "@/components/LinkedAccounts";
import AiCostPanel from "@/components/AiCostPanel";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const VALID_SUBJECTS: readonly Subject[] = ["korean", "math", "english", "elective"];

function asSubject(v: unknown): Subject | null {
  return typeof v === "string" && (VALID_SUBJECTS as readonly string[]).includes(v)
    ? (v as Subject)
    : null;
}

export default async function ProfilePage({
  searchParams,
}: {
  searchParams?: { tab?: string };
}) {
  if (!isSupabaseConfigured()) {
    return (
      <main className="mx-auto flex max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
        <Logo size={40} />
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Supabase 설정이 아직 완료되지 않았습니다.
        </p>
      </main>
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return (
      <main className="mx-auto flex max-w-md flex-col items-center justify-center px-4 text-center">
        <p className="text-sm text-slate-500">
          로그인이 필요합니다.{" "}
          <Link href="/login" className="text-blue-600 underline">
            로그인 페이지로 이동
          </Link>
        </p>
      </main>
    );
  }

  // 셋이 서로 필요로 하는 게 없다 — 차례로 기다리면 왕복 세 번이 그대로
  // 화면 뜨는 시간이 된다(대시보드·실모 화면과 같은 이유).
  const [access, { data: prefs }] = await Promise.all([
    getAccessState(supabase),
    supabase
      .from("grading_prefs")
      .select(
        "subject, math_elective, korean_elective, tamgu_single, elective1_label, elective2_label",
      )
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);
  const gradingPrefs: GradingPrefsValue = {
    subject: asSubject(prefs?.subject),
    mathElective: prefs?.math_elective ?? "",
    koreanElective: prefs?.korean_elective ?? "",
    tamguSingle: prefs?.tamgu_single ?? false,
    elective1Label: prefs?.elective1_label ?? "",
    elective2Label: prefs?.elective2_label ?? "",
  };

  const costTab = access.unlimited && searchParams?.tab === "cost";
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 pb-10 pt-6">
      <header>
        <h1 className="mt-2 text-xl font-semibold text-ink">내 프로필</h1>
        <p className="mt-1 text-sm text-slate-500">{user.email}</p>
      </header>

      <BillingStatus
        credits={access.credits}
        unlimited={access.unlimited}
        byok={access.byok}
        checkoutReady={isCheckoutReady()}
        byokCheckoutReady={isByokCheckoutReady()}
 />

      {/* 비용은 무제한 계정에게만 — 서버(/api/admin/ai-cost)도 같은 조건으로 막는다.
          프로필 설정과 섞이면 길어져서 따로 탭으로 뺐다(?tab=cost). */}
      {access.unlimited && (
        <nav className="flex gap-1 text-sm" aria-label="프로필 탭">
          <Link
            href="/profile"
            aria-current={!costTab ? "page" : undefined}
            className={cn(buttonVariants({ variant: costTab ? "ghost" : "soft", size: "sm" }))}
          >
            프로필
          </Link>
          <Link
            href="/profile?tab=cost"
            aria-current={costTab ? "page" : undefined}
            className={cn(buttonVariants({ variant: costTab ? "soft" : "ghost", size: "sm" }))}
          >
            AI 비용
          </Link>
        </nav>
      )}

      {costTab ? (
        <AiCostPanel />
      ) : (
        <>
      <LinkedAccounts initialIdentities={user.identities ?? []} />

      {/* BYOK 패스를 산 사람에게만 보인다 — 안 산 사람에게 키 입력칸을
          보여줘 봐야 서버가 어차피 entitlements.byok로 다시 막는다. */}
      {access.byok && <ByokSettingsForm />}

      <GradingPrefsForm initial={gradingPrefs} />

      <CropShapeSetting />

        </>
      )}
    </main>
  );
}
