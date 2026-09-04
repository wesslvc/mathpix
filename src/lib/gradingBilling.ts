import type { SupabaseClient } from "@supabase/supabase-js";
import { GRADING_TOKEN_DEPOSIT, gradingTokenCharge } from "./tokens";

/**
 * vision 을 쓰는 라우트의 **보증금 → 정산** 과금.
 *
 * 선차감이 있어야 잔액 없는 사람이 시작하지 못한다. 끝나고 실제 사용량을
 * 알면 남으면 환불, 모자라면 추가 차감한다(`/api/figure` 와 같은 모양).
 *
 * **무제한 계정은 차감도 정산도 건너뛴다.** 예전에 이 검사가 빠진 라우트가
 * 있어서, 무제한인데 잔액이 0 이면 402 로 막혔다.
 *
 * 채점(`/api/grade-exam`)·답지(`/api/answer-key`)는 아직 각자 같은 코드를
 * 들고 있다. 잘 돌고 있는 과금 경로라 이번에 건드리지 않았을 뿐이고,
 * 다음에 그쪽을 고칠 일이 있으면 이리로 모을 것.
 */
export type GradingBilling = {
  charged: boolean;
  /** 실패했을 때. 보증금을 통째로 돌려준다. */
  refund(): Promise<void>;
  /** 끝났을 때. 실제 값을 알면 그만큼 맞추고, 최종 차감 토큰 수를 돌려준다. */
  settle(estKrw: number | undefined): Promise<number | null>;
};

/** 잔액이 모자라면 `null`. 그때는 402 로 돌려보내면 된다. */
export async function startGradingBilling(
  supabase: SupabaseClient,
  opts: { unlimited: boolean; deposit?: number; label: string },
): Promise<GradingBilling | null> {
  const deposit = opts.deposit ?? GRADING_TOKEN_DEPOSIT;
  if (opts.unlimited) {
    return {
      charged: false,
      async refund() {},
      async settle() {
        return null;
      },
    };
  }

  const { data, error } = await supabase.rpc("consume_recognition_credit", {
    p_amount: deposit,
  });
  if (error) throw error;
  if (data === null) return null;

  return {
    charged: true,
    async refund() {
      try {
        await supabase.rpc("refund_recognition_credit", { p_amount: deposit });
      } catch {
        // 환불 실패는 삼킨다 — 사용자에게는 원래 오류를 보여주는 게 맞다.
      }
    },
    async settle(estKrw) {
      const want = gradingTokenCharge(estKrw);
      const diff = want - deposit;
      try {
        if (diff < 0) {
          await supabase.rpc("refund_recognition_credit", { p_amount: -diff });
        } else if (diff > 0) {
          const { data: ok } = await supabase.rpc("consume_recognition_credit", {
            p_amount: diff,
          });
          // 못 받아도 결과는 준다 — 이미 만든 것을 버릴 이유가 없다.
          if (ok === null) {
            console.warn(`[${opts.label}] 잔액 부족으로 ${diff}토큰을 못 받았습니다.`);
          }
        }
      } catch (err) {
        console.error(`[${opts.label}] 정산 실패:`, err);
      }
      return want;
    },
  };
}
