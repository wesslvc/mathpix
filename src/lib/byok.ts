import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * BYOK(Bring Your Own [OpenAI] Key) 패스 사용자의 과금 컨텍스트.
 *
 * `unlimited`와 나란히 두는 두 번째 "차감 건너뛰기" 상태다 — 다만
 * `unlimited`는 우리 API 키로 우리가 비용을 대신 내고 사용자에게 안 받는
 * 것이고, `byok`는 **사용자 본인의 OpenAI 키로 본인이 직접 낸다**(그래서
 * 우리 쪽 토큰 차감이 아예 없다). Mathpix는 OpenAI와 무관한 별도 제공자라
 * BYOK라도 우리 Mathpix 키를 그대로 쓰되 토큰만 안 받는다("무제한 무료
 * 제공"의 뜻이 그것이다).
 */
export type BillingContext = {
  unlimited: boolean;
  byok: boolean;
  /**
   * byok가 true인데 이 값이 null이면 **아직 키를 등록하지 않은 것**이다.
   * 이때는 절대 공유 OPENAI_API_KEY로 대신 진행하면 안 된다(item 5 —
   * "BYOK 유저는 공유 키를 절대 못 건드린다") — 호출부가 402로 막고
   * 등록을 안내해야 한다.
   */
  byokApiKey: string | null;
  byokModel: string | null;
};

/**
 * 로그인한 사용자의 unlimited/BYOK 상태와, BYOK면 본인 키를 함께 읽는다.
 *
 * **키는 service_role로만 읽을 수 있다**(`get_byok_openai_key` RPC가
 * anon/authenticated 권한을 아예 안 받는다) — 그래서 사용자 세션
 * `supabase` 클라이언트가 아니라 별도 관리자 클라이언트를 연다. 사용자
 * 세션 클라이언트는 `entitlements.unlimited/byok` 두 플래그만 읽는 데
 * 쓴다(그건 RLS로 본인 행만 보이므로 안전하다).
 */
export async function getBillingContext(
  supabase: SupabaseClient,
  userId: string,
): Promise<BillingContext> {
  const { data: ent } = await supabase
    .from("entitlements")
    .select("unlimited, byok")
    .eq("user_id", userId)
    .maybeSingle();
  const unlimited = ent?.unlimited === true;
  const byok = ent?.byok === true;

  if (!byok) return { unlimited, byok: false, byokApiKey: null, byokModel: null };

  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .rpc("get_byok_openai_key", { p_user_id: userId })
      .maybeSingle();
    if (error) throw error;
    // Database 타입을 생성해 두지 않아 rpc()가 이 함수의 반환 모양을 모른다
    // — 여기서 한 번만 모양을 확정한다.
    const row = data as { api_key: string | null; model: string | null } | null;
    const apiKey =
      typeof row?.api_key === "string" && row.api_key.length > 0 ? row.api_key : null;
    const model =
      typeof row?.model === "string" && row.model.length > 0 ? row.model : null;
    return { unlimited, byok: true, byokApiKey: apiKey, byokModel: model };
  } catch (err) {
    console.error("[byok] 키 조회 실패:", err);
    return { unlimited, byok: true, byokApiKey: null, byokModel: null };
  }
}
