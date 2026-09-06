"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Subject } from "@/lib/gradeSummary";
import { examMaxScore } from "@/lib/gradeSummary";
import {
  KOREAN_ELECTIVES,
  MATH_ELECTIVES,
  SUBJECT_LABEL,
} from "@/lib/examSubjects";
import { ElectiveSelect } from "./GradeExamFlow";

const SUBJECTS: readonly Subject[] = ["korean", "math", "english", "elective"];

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * **성적을 손으로 적어 넣는다**(사용자 요청 — "추세 볼 수 있게 성적 수동
 * 입력도 가능하게 해줘").
 *
 * 지금까지 성적 추세에 점이 찍히려면 자동채점(`/grade`)을 거쳐야 했다 — OMR
 * 카드와 답지 사진이 있어야 하고 토큰도 든다. 그런데 추세에 필요한 것은
 * **과목 · 응시일 · 점수(또는 등급)** 넷뿐이고, 이미 채점이 끝난 시험이나
 * 성적표만 들고 있는 시험은 그 넷을 그냥 적으면 된다.
 *
 * **저장하는 곳은 자동채점과 같은 표다**(`exam_scores`). 따로 두면 추세
 * 그래프·기록 목록·묶어보기가 두 벌이 되어 반드시 어긋난다 — 이 저장소가
 * 여러 번 데인 자리다(`computeSummary`·`readUsage`·`problemOrder`).
 *
 * **문항 수와 맞은 개수는 0 이다.** 지어내면(예: 1문항 중 1개 정답) 목록에
 * "전부 정답"처럼 사실이 아닌 말이 찍힌다. 화면은 `total_questions === 0` 을
 * "문항 정보 없음"으로 읽는다(마이그레이션 `0023` 이 0 을 허용하게 넓혔다).
 */
export default function ManualScoreForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState<Subject>("korean");
  const [elective, setElective] = useState("");
  const [examName, setExamName] = useState("");
  const [takenAt, setTakenAt] = useState(todayIso());
  const [score, setScore] = useState("");
  const [grade, setGrade] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const max = examMaxScore(subject);
  const scoreNum = score.trim() === "" ? null : Number(score);
  const gradeNum = grade.trim() === "" ? null : Number(grade);
  const scoreBad =
    scoreNum !== null && (!Number.isFinite(scoreNum) || scoreNum < 0 || scoreNum > max);
  /**
   * **점수도 등급도 없으면 그래프에 아무것도 안 찍힌다.** 그런 기록을
   * 저장하게 두면 "적었는데 추세에 안 나온다"가 된다.
   */
  const nothingToPlot = scoreNum === null && gradeNum === null;
  /** 탐구는 과목명이 곧 추세의 갈래다 — 안 고르면 "1선택"으로 뭉뚱그려진다. */
  const electiveMissing = subject === "elective" && !elective;
  const canSave = !saving && !scoreBad && !nothingToPlot && !electiveMissing;

  function reset() {
    setElective("");
    setExamName("");
    setTakenAt(todayIso());
    setScore("");
    setGrade("");
    setError(null);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("로그인이 필요합니다.");
      const { error: insertError } = await supabase.from("exam_scores").insert({
        user_id: user.id,
        subject,
        // 탐구 과목명이자 국어·수학의 선택과목명(자리를 넓혀 쓴다 — 자동채점과
        // 같은 컬럼이라 추세 그래프가 같은 기준으로 묶는다).
        elective_label: elective || null,
        // 1선택/2선택은 자동채점에서 OMR 한 장에 둘이 함께 있을 때 쓰는
        // 구분이다. 손으로 적을 때는 과목명만으로 갈리므로 비워 둔다.
        elective_slot: null,
        exam_name: examName.trim() || null,
        taken_at: takenAt,
        score: scoreNum,
        grade_level: gradeNum,
        // 문항 정보가 없다. 지어내지 않는다 — 위 주석 참고.
        total_questions: 0,
        correct_count: 0,
        wrong_numbers: [],
      });
      if (insertError) throw insertError;
      reset();
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="self-start rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
      >
        + 성적 직접 입력
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-slate-700">성적 직접 입력</p>
        <button
          type="button"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-500 hover:bg-slate-100"
        >
          닫기
        </button>
      </div>
      <p className="text-xs text-slate-400">
        채점을 거치지 않고 점수만 남깁니다. 추세 그래프와 채점 기록에 함께
        나와요. 문항별 오답은 남지 않습니다.
      </p>

      <div className="flex flex-wrap gap-1.5">
        {SUBJECTS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setSubject(s);
              // 과목이 바뀌면 선택과목 목록 자체가 달라진다 — 남겨 두면
              // 수학인데 "생활과 윤리"가 붙어 있는 기록이 생긴다.
              setElective("");
            }}
            className={`rounded-lg border px-3 py-1.5 text-sm ${
              subject === s
                ? "border-blue-500 bg-blue-50 font-medium text-blue-700"
                : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {SUBJECT_LABEL[s]}
          </button>
        ))}
      </div>

      {subject === "elective" && (
        <div>
          <p className="mb-1 text-xs font-medium text-slate-500">탐구 과목</p>
          <ElectiveSelect value={elective} onChange={setElective} />
          {electiveMissing && (
            <p className="text-xs text-amber-600">
              과목을 골라주세요 — 추세 그래프가 과목별로 갈립니다.
            </p>
          )}
        </div>
      )}
      {(subject === "math" || subject === "korean") && (
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
          선택과목 (선택 입력)
          <select
            value={elective}
            onChange={(e) => setElective(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-ink focus:border-blue-500 focus:outline-none"
          >
            <option value="">고르지 않음</option>
            {(subject === "math" ? MATH_ELECTIVES : KOREAN_ELECTIVES).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
        시험 이름 (선택 입력)
        <input
          value={examName}
          onChange={(e) => setExamName(e.target.value)}
          placeholder="예: 2025학년도 9월 모의평가"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-ink placeholder:text-slate-400 focus:border-blue-500 focus:outline-none"
        />
      </label>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
          응시일
          <input
            type="date"
            value={takenAt}
            onChange={(e) => setTakenAt(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-ink focus:border-blue-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
          점수 (만점 {max})
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={max}
            value={score}
            onChange={(e) => setScore(e.target.value)}
            placeholder={`0~${max}`}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-ink placeholder:text-slate-400 focus:border-blue-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
          등급 (선택 입력)
          <select
            value={grade}
            onChange={(e) => setGrade(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-ink focus:border-blue-500 focus:outline-none"
          >
            <option value="">없음</option>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((g) => (
              <option key={g} value={g}>
                {g}등급
              </option>
            ))}
          </select>
        </label>
      </div>

      {scoreBad && (
        <p className="text-xs text-amber-600">
          점수는 0~{max} 사이로 적어주세요.
        </p>
      )}
      {nothingToPlot && !scoreBad && (
        <p className="text-xs text-amber-600">
          점수나 등급 중 하나는 있어야 추세 그래프에 나옵니다.
        </p>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}

      <button
        type="button"
        onClick={() => void save()}
        disabled={!canSave}
        className="self-start rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {saving ? "저장 중..." : "저장"}
      </button>
    </div>
  );
}
