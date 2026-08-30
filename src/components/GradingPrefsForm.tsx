"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Subject } from "@/lib/gradeSummary";
import { MATH_ELECTIVES, KOREAN_ELECTIVES, SUBJECT_LABEL } from "@/lib/examSubjects";
import { ElectiveSelect } from "./GradeExamFlow";

export type GradingPrefsValue = {
  subject: Subject | null;
  mathElective: string;
  koreanElective: string;
  tamguSingle: boolean;
  elective1Label: string;
  elective2Label: string;
};

/**
 * 자동채점(`/grade`)을 시작할 때마다 과목·선택과목을 새로 고르지 않도록,
 * 여기서 미리 정해 두면 시작 화면이 이 값으로 자동 선택된다. 실제 시험은
 * 대개 매번 같은 과목(자신의 선택과목)이라 반복 입력이 낭비라는 요청이다.
 *
 * **여기서 정한다고 강제되지 않는다.** 시험마다 다르면 시작 화면에서
 * 그때그때 바꿀 수 있다 — 이건 어디까지나 "보통 이 과목을 본다"는 기본값이다.
 */
export default function GradingPrefsForm({ initial }: { initial: GradingPrefsValue }) {
  const [subject, setSubject] = useState<Subject | null>(initial.subject);
  const [mathElective, setMathElective] = useState(initial.mathElective);
  const [koreanElective, setKoreanElective] = useState(initial.koreanElective);
  const [tamguSingle, setTamguSingle] = useState(initial.tamguSingle);
  const [elective1Label, setElective1Label] = useState(initial.elective1Label);
  const [elective2Label, setElective2Label] = useState(initial.elective2Label);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("로그인이 필요합니다.");
      const { error: upsertError } = await supabase.from("grading_prefs").upsert({
        user_id: user.id,
        subject,
        math_elective: mathElective || null,
        korean_elective: koreanElective || null,
        tamgu_single: tamguSingle,
        elective1_label: elective1Label || null,
        elective2_label: elective2Label || null,
        updated_at: new Date().toISOString(),
      });
      if (upsertError) throw upsertError;
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-sm font-medium text-slate-700">기본 과목 설정</p>
      <p className="text-xs text-slate-400">
        자동채점을 시작할 때 아래 값으로 미리 선택돼 있어요. 시험마다 다르면
        시작 화면에서 그때그때 바꿀 수 있습니다.
      </p>

      <div className="flex gap-1.5">
        {(Object.keys(SUBJECT_LABEL) as Subject[]).map((s) => {
          const active = subject === s;
          return (
            <button
              key={s}
              type="button"
              aria-pressed={active}
              // 다시 누르면 해제 — "기본값 없음"으로 되돌릴 방법이 있어야 한다.
              onClick={() => setSubject(active ? null : s)}
              className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                active
                  ? "border-blue-600 bg-blue-600 text-white"
                  : "border-slate-300 bg-white text-slate-600 hover:bg-slate-100"
              }`}
            >
              {SUBJECT_LABEL[s]}
            </button>
          );
        })}
      </div>

      {subject === "math" && (
        <label className="flex items-center gap-2 text-sm text-slate-700">
          선택과목
          <select
            value={mathElective}
            onChange={(e) => setMathElective(e.target.value)}
            className="rounded-lg border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
          >
            <option value="">고르지 않음</option>
            {MATH_ELECTIVES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      )}

      {subject === "korean" && (
        <label className="flex items-center gap-2 text-sm text-slate-700">
          선택과목
          <select
            value={koreanElective}
            onChange={(e) => setKoreanElective(e.target.value)}
            className="rounded-lg border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
          >
            <option value="">고르지 않음</option>
            {KOREAN_ELECTIVES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      )}

      {subject === "elective" && (
        <div className="flex flex-col gap-3">
          <div>
            <p className="mb-1 text-xs font-medium text-slate-500">몇 과목</p>
            <div className="flex gap-1.5">
              {(
                [
                  { value: false, label: "1선택+2선택" },
                  { value: true, label: "1과목만" },
                ] as const
              ).map((opt) => (
                <button
                  key={String(opt.value)}
                  type="button"
                  aria-pressed={tamguSingle === opt.value}
                  onClick={() => setTamguSingle(opt.value)}
                  className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                    tamguSingle === opt.value
                      ? "border-blue-600 bg-blue-600 text-white"
                      : "border-slate-300 bg-white text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {tamguSingle ? (
            <ElectiveSelect value={elective1Label} onChange={setElective1Label} />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-xs font-medium text-slate-500">1선택</p>
                <ElectiveSelect value={elective1Label} onChange={setElective1Label} />
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-slate-500">2선택</p>
                <ElectiveSelect value={elective2Label} onChange={setElective2Label} />
              </div>
            </div>
          )}
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="self-start rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "저장 중..." : "저장"}
        </button>
        {saved && <span className="text-xs text-emerald-600">저장됐어요</span>}
      </div>
    </div>
  );
}
