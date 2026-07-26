import type { SupabaseClient } from "@supabase/supabase-js";

/** 무료 체험으로 저장 가능한 오답 개수. 이 수를 넘기면 결제해야 계속 쓸 수 있다. */
export const FREE_PROBLEM_LIMIT = 5;

export type AccessState = {
  /** 이용권을 결제해 활성 상태인지. */
  paid: boolean;
  /** 지금까지 저장한 오답 수. */
  problemCount: number;
  /** 무료 체험 한도. */
  limit: number;
  /** 남은 무료 저장 수(결제했으면 무제한이라 의미 없음). */
  remaining: number;
  /** 결제했거나 아직 체험 한도 안이면 true. */
  canUse: boolean;
};

type EntitlementRow = {
  active: boolean;
  expires_at: string | null;
};

/** 이용권이 지금 유효한지(활성 + 만료 전) 판단한다. */
export function isEntitlementActive(e: EntitlementRow | null): boolean {
  if (!e || !e.active) return false;
  if (e.expires_at && new Date(e.expires_at).getTime() <= Date.now()) {
    return false;
  }
  return true;
}

/**
 * 현재 로그인 사용자의 이용 가능 상태(결제/체험)를 계산한다.
 * RLS 기반 SSR 클라이언트로 호출하면 본인 데이터만 집계된다.
 */
export async function getAccessState(
  supabase: SupabaseClient,
): Promise<AccessState> {
  const [entRes, countRes] = await Promise.all([
    supabase.from("entitlements").select("active, expires_at").maybeSingle(),
    supabase.from("problems").select("id", { count: "exact", head: true }),
  ]);

  const paid = isEntitlementActive(
    (entRes.data as EntitlementRow | null) ?? null,
  );
  const problemCount = countRes.count ?? 0;
  const remaining = Math.max(0, FREE_PROBLEM_LIMIT - problemCount);
  const canUse = paid || problemCount < FREE_PROBLEM_LIMIT;

  return { paid, problemCount, limit: FREE_PROBLEM_LIMIT, remaining, canUse };
}

/** 결제창(체크아웃)이 설정돼 실제로 결제로 넘어갈 수 있는지. */
export function isCheckoutReady(): boolean {
  return Boolean(process.env.GROBLE_PAYMENT_URL);
}
