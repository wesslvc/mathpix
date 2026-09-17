import type { SupabaseClient } from "@supabase/supabase-js";

/** 신규 사용자에게 주는 무료 토큰 수. */
export const FREE_RECOGNITION_CREDITS = 50;

/**
 * 이용권 결제 1건당 충전되는 토큰 수.
 *
 * **1000에서 5000으로 올렸다**(사용자 결정, 2026-09-17. 가격은 그대로 두고
 * 개수만 늘렸다 — 실질 단가 인하). 그로블에 새 상품("ReprintOCR 5000토큰")을
 * 만들고, 결제 링크(`GROBLE_PAYMENT_URL_TOKENS`)도 그 상품으로 새로 판다 —
 * 옛 상품("ReprintOCR 1000토큰")은 이미 판매 이력이 있어 건드리지 않고
 * 그대로 살려 둔다(옛 링크를 아직 들고 있는 사람이 있을 수 있다).
 */
export const PAID_RECOGNITION_CREDITS = 5000;

/**
 * 옛 이용권 상품("ReprintOCR 1000토큰")이 결제됐을 때 충전할 토큰 수.
 * 그 상품 자체가 사라지지 않는 한 이 값도 그대로 둬야 한다 — 옛 링크로
 * 결제한 사람에게 얼마를 줄지 결정하는 값이다.
 */
export const LEGACY_PAID_RECOGNITION_CREDITS = 1000;

export type AccessState = {
  /** 남은 사진인식권(Mathpix 인식 API 호출 가능 횟수). */
  credits: number;
  /** 인식 API를 호출할 수 있는지(크레딧이 남아있는지). */
  canRecognize: boolean;
  /** 한도 없이 쓸 수 있는 계정인지(운영자 등). 이때 credits는 의미가 없다. */
  unlimited: boolean;
};

/**
 * 현재 로그인 사용자의 남은 사진인식권을 계산한다.
 * 아직 한 번도 인식을 시도하지 않은 사용자는 entitlements 행이 없을 수 있는데,
 * 이 경우 첫 호출 시 무료 크레딧으로 초기화되므로 그 값을 미리 보여준다.
 */
export async function getAccessState(
  supabase: SupabaseClient,
): Promise<AccessState> {
  const { data } = await supabase
    .from("entitlements")
    .select("credits, unlimited")
    .maybeSingle();

  const credits =
    (data?.credits as number | undefined) ?? FREE_RECOGNITION_CREDITS;
  const unlimited = Boolean(data?.unlimited);

  return { credits, unlimited, canRecognize: unlimited || credits > 0 };
}

/**
 * 결제창(체크아웃)이 설정돼 실제로 결제로 넘어갈 수 있는지.
 * 새 5000토큰 상품 링크나 옛 1000토큰 상품 링크 둘 중 하나만 있어도 된다
 * (`/api/checkout`의 `resolvePlan`이 같은 순서로 내려간다).
 */
export function isCheckoutReady(): boolean {
  return Boolean(process.env.GROBLE_PAYMENT_URL_TOKENS || process.env.GROBLE_PAYMENT_URL);
}
