"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { GradedItemRow } from "@/lib/supabase/types";

type Props = {
  /** 이 채점 기록(exam_scores.id). */
  gradeId: string;
  /** 어느 시험의 채점인지(연결된 채점이 여럿일 수 있어 구분이 필요하다). */
  title: string;
  /** 자동채점이 틀렸다고 한 번호 전부. */
  wrongNumbers: number[];
  /** 채점 때 읽어 둔 문항별 정답·배점. 옛 기록에는 없을 수 있다. */
  items?: GradedItemRow[] | null;
  /** 이 실모에 저장된 문제들(번호가 붙은 것만 뜻이 있다). */
  problems: { id: string; number: number | null; hasAnswer: boolean }[];
};

/**
 * 채점 기록과 저장된 오답을 **번호로 이어 준다.**
 *
 * **예전에는 번호를 하나 고르고 사진 한 장 올리기를 반복했다**
 * (`GradeProblemUploader`). 번호를 정확히 붙이려면 그 순서를 강제하는 수밖에
 * 없었기 때문이다. 그런데 지금은 **번호를 한꺼번에 붙이는 길**이 따로 있고
 * (`ProblemNumberScanner`), 문제를 넣는 길도 지면 통째로·여러 장 등 여럿이다.
 * 그래서 사용자가 그 하나씩 흐름을 없애자고 했다 — 넣는 것은 편한 길로
 * 넣고, **연결만 여기서 한꺼번에** 하면 된다.
 *
 * 여기서 하는 일은 **정답 붙이기 하나**다. 나머지는 이미 번호로 이어진다:
 * - **"내가 고른 답"은 저절로 붙는다.** 내보내기가 `gradeId` 가 없으면
 *   `실모 + 번호`로도 찾게 돼 있다(`studentByCategoryNo`) — 번호만 맞으면
 *   정답표에 `④ (내답 ②)` 가 그대로 찍힌다.
 * - **정답은 저절로 안 붙는다.** 그건 문제 행의 `answer` 칸이라 누가 써 넣어야
 *   한다. 답지 사진을 읽는 길(`AnswerKeyPanel`)이 있지만, **채점 기록에는 이미
 *   정답이 들어 있으므로**(`items[].correctAnswer`) 사진도 토큰도 필요 없다.
 *
 * **이미 정답이 적힌 문제는 건드리지 않는다.** 손으로 고쳐 둔 값을 덮어쓰면
 * 안 된다 — 서버 함수(`apply_answer_key`)도 빈 값은 무시하지만, 여기서도
 * 아예 보내지 않아 "몇 개를 붙였는지" 가 정확해진다.
 */
export default function GradeLinkPanel({
  gradeId,
  title,
  wrongNumbers,
  items,
  problems,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 번호 → 그 문항의 정답·배점. 옛 기록(items 없음)이면 비어 있다. */
  const byNumber = useMemo(() => {
    const map = new Map<number, GradedItemRow>();
    for (const it of items ?? []) map.set(it.no, it);
    return map;
  }, [items]);

  /** 정답을 붙일 수 있는 문제들(번호가 있고, 아직 정답이 비어 있다). */
  const targets = useMemo(
    () =>
      problems
        .filter((p) => p.number != null && !p.hasAnswer)
        .map((p) => ({ id: p.id, item: byNumber.get(p.number!) }))
        .filter(
          (t): t is { id: string; item: GradedItemRow } =>
            !!t.item && (t.item.correctAnswer ?? "").trim() !== "",
        ),
    [problems, byNumber],
  );

  const numbered = problems.filter((p) => p.number != null).length;
  const wrongSet = useMemo(() => new Set(wrongNumbers), [wrongNumbers]);
  /** 틀린 번호 중 아직 이 실모에 없는 것 — 무엇을 더 넣어야 하는지 알려 준다. */
  const missing = useMemo(() => {
    const have = new Set(problems.map((p) => p.number).filter((n) => n != null));
    return wrongNumbers.filter((n) => !have.has(n));
  }, [wrongNumbers, problems]);
  const linked = problems.filter(
    (p) => p.number != null && wrongSet.has(p.number),
  ).length;

  async function apply() {
    if (targets.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      // 배점도 함께 넣는다 — box_range jsonb 안이라 서버에서 합쳐야 한다
      // (화면에서 하려면 그림이 든 box_range 를 통째로 내려받아야 한다).
      const updates = targets.map((t) => ({
        id: t.id,
        answer: (t.item.correctAnswer ?? "").trim(),
        ...(t.item.points != null ? { points: t.item.points } : {}),
      }));
      const { data: n, error: rpcErr } = await supabase.rpc("apply_answer_key", {
        p_updates: updates,
      });
      if (rpcErr) throw rpcErr;
      setDone(typeof n === "number" ? n : updates.length);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "정답을 붙이지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">
          채점 연동 · <span className="font-normal text-slate-600">{title}</span>
        </h2>
        <span className="text-xs text-slate-400">
          틀린 문항 {wrongNumbers.length}개 중 {linked}개 저장됨
        </span>
      </div>

      <p className="text-xs text-slate-500">
        번호만 맞으면 정답표에 <b>내가 고른 답</b>이 함께 찍힙니다. 번호가 없는
        문제는 아래 <b>전체 번호 인식</b>으로 먼저 붙여주세요.
        {numbered === 0 && " (지금은 번호가 붙은 문제가 없습니다.)"}
      </p>

      {missing.length > 0 && (
        <p className="text-xs text-amber-700">
          아직 안 올린 틀린 번호: {missing.join(", ")}
        </p>
      )}

      {items && items.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void apply()}
            disabled={busy || targets.length === 0}
            className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
          >
            {busy
              ? "붙이는 중..."
              : `채점 기록의 정답 붙이기${targets.length ? ` (${targets.length}문제)` : ""}`}
          </button>
          <span className="text-xs text-slate-400">
            채점할 때 읽어 둔 정답을 씁니다 — 사진도 토큰도 들지 않아요.
          </span>
        </div>
      ) : (
        <p className="text-xs text-slate-400">
          이 채점 기록에는 문항별 정답이 없어요(예전 기록). 정답은 답지
          사진으로 붙이거나 문제마다 직접 적어주세요.
        </p>
      )}

      {done !== null && (
        <p className="text-xs text-emerald-700">{done}개 문제에 정답을 붙였어요.</p>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </section>
  );
}
