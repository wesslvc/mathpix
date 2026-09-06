"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * 채점 기록(`exam_scores` 한 행)을 지운다.
 *
 * 손으로 적어 넣은 성적(`ManualScoreForm`)이 생기면서 **잘못 적은 것을 되돌릴
 * 길**이 필요해졌다(사용자 요청 — "기록 삭제도 가능하게 해"). 자동채점 기록도
 * 같은 표라 함께 지울 수 있다.
 *
 * **실모(`categories`)는 건드리지 않는다.** 채점을 실모에 연결하면
 * `categories.score` 도 함께 채워지지만, 그 값은 손으로도 고치는 실모 자신의
 * 값이다(`LinkCategoryPicker` 가 "이미 적어 둔 점수를 지울 이유가 없다"고
 * 판단한 것과 같은 자리다). 저장해 둔 오답 문제들도 그대로 남는다 — 채점
 * 기록을 지운다고 문제까지 사라지면 되돌릴 수 없는 손해가 난다.
 *
 * 대신 **이 채점에서 온 "내가 고른 답"은 사라진다** — 정답표의 `(내답 ②)` 는
 * 이 행의 `items` 에서 오기 때문이다. 그래서 물어볼 때 그 말을 함께 적는다.
 */
export default function DeleteGradeButton({
  examScoreId,
  label,
  takenAt,
}: {
  examScoreId: string;
  /** 무엇을 지우는지 확인 창에 보여줄 이름(시험 이름 또는 과목명). */
  label: string;
  takenAt: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (
      !window.confirm(
        `"${label}" (${takenAt}) 채점 기록을 삭제할까요?\n\n` +
          `성적 추세에서도 사라지고, 이 채점에서 가져오던 "내가 고른 답" 표기도 ` +
          `정답표에 더 이상 찍히지 않습니다.\n` +
          `저장해 둔 오답 문제와 실모는 그대로 남습니다.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.from("exam_scores").delete().eq("id", examScoreId);
      if (error) throw error;
      // 지워진 행의 상세 화면에 머물 수는 없다. 라우터 캐시(동적 120초)가
      // 옛 목록을 그대로 내주지 않게 옮겨간 뒤 새로 받는다.
      router.replace("/profile");
      router.refresh();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "삭제에 실패했습니다.");
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void remove()}
      disabled={busy}
      className="self-start rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-500 hover:border-red-300 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
    >
      {busy ? "삭제 중..." : "이 기록 삭제"}
    </button>
  );
}
