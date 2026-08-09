import type { SupabaseClient } from "@supabase/supabase-js";

/** 신규 사용자에게 주는 무료 토큰 수. */
export const FREE_RECOGNITION_CREDITS = 50;
/** 이용권 결제 1건당 충전되는 사진인식권 수. */
export const PAID_RECOGNITION_CREDITS = 1000;

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

/** 결제창(체크아웃)이 설정돼 실제로 결제로 넘어갈 수 있는지. */
export function isCheckoutReady(): boolean {
  return Boolean(process.env.GROBLE_PAYMENT_URL);
}
