"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { computeSummary, type GradedItem } from "@/lib/gradeSummary";

/**
 * 채점 기록의 **문항별 상세**를 그 자리에서 고친다(채점이 잘못 나왔을 때). 학생답·정답·배점을 고치거나 정오 칸을 눌러 맞음/틀림을
 * 뒤집으면(맞음 = 내 답을 정답과 같게, 틀림 = 내 답 비움) 저장할 때 점수·틀린 번호·맞은 개수를 같은 함수(`computeSummary`)로
 * 다시 센다. 배점이 하나도 없는 기록은 점수를 새로 못 구하므로 예전 점수를 그대로 둔다.
 */
export default function GradeItemsEditor({
  examScoreId,
  items: initial,
  score: initialScore,
}: {
  examScoreId: string;
  items: GradedItem[];
  score: number | null;
}) {
  const router = useRouter();
  const [items, setItems] = useState<GradedItem[]>(initial);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const norm = (v: string | null | undefined) => (v ?? "").trim().replace(/\s+/g, "");
  const isCorrect = (it: GradedItem) => norm(it.studentAnswer) !== "" && norm(it.studentAnswer) === norm(it.correctAnswer);
  const summary = computeSummary(items);

  function patch(i: number, p: Partial<GradedItem>) {
    setItems((prev) => prev.map((it, k) => (k === i ? { ...it, ...p } : it)));
    setDirty(true);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const { error: err } = await supabase
        .from("exam_scores")
        .update({
          items,
          total_questions: summary.totalQuestions,
          correct_count: summary.correctCount,
          wrong_numbers: summary.wrongNumbers,
          score: summary.score ?? initialScore,
        })
        .eq("id", examScoreId);
      if (err) throw err;
      setDirty(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  const cell = "w-full rounded border border-slate-200 px-1.5 py-0.5 text-sm";
  return (
    <div className="flex flex-col gap-2">
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
              <th className="px-3 py-2">번호</th>
              <th className="px-3 py-2">학생답</th>
              <th className="px-3 py-2">정답</th>
              <th className="px-3 py-2">배점</th>
              <th className="px-3 py-2">정오 (눌러서 바꾸기)</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, i) => {
              const ok = isCorrect(item);
              return (
                <tr key={item.no} className={`border-b border-slate-100 last:border-0 ${ok ? "" : "bg-red-50"}`}>
                  <td className="px-3 py-1.5">{item.no}</td>
                  <td className="px-2 py-1">
                    <input
                      className={cell}
                      value={item.studentAnswer ?? ""}
                      onChange={(e) => patch(i, { studentAnswer: e.target.value === "" ? null : e.target.value })}
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input className={cell} value={item.correctAnswer} onChange={(e) => patch(i, { correctAnswer: e.target.value })} />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      className={`${cell} w-16`}
                      inputMode="numeric"
                      value={item.points ?? ""}
                      onChange={(e) => {
                        const n = e.target.value.trim() === "" ? undefined : Number(e.target.value);
                        patch(i, { points: n !== undefined && Number.isFinite(n) ? n : undefined });
                      }}
                    />
                  </td>
                  <td className="px-2 py-1">
                    <button
                      type="button"
                      onClick={() => patch(i, { studentAnswer: ok ? null : item.correctAnswer })}
                      className={`rounded px-2 py-0.5 text-sm font-medium ${ok ? "bg-emerald-50 text-emerald-700" : "bg-red-100 text-red-600"}`}
                    >
                      {ok ? "O 맞음" : "X 틀림"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-slate-600">
          {summary.score != null ? `${summary.score}점` : "점수 계산 불가(배점 없음)"} · 틀린 번호: {summary.wrongNumbers.join(", ") || "없음"}
        </span>
        <Button type="button" variant="primary" disabled={!dirty || busy} onClick={save}>
          {busy ? "저장 중..." : "수정 저장"}
        </Button>
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
