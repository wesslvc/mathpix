"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { prepareGradingImage, gradingImageBudget } from "@/lib/gradeImagePrep";
import {
  computeSummary,
  type GradedItem,
  type GradeSlot,
  type Subject,
} from "@/lib/gradeSummary";
import LinkCategoryPicker from "./LinkCategoryPicker";

function todayString(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const SUBJECT_LABEL: Record<Subject, string> = {
  korean: "국어",
  math: "수학",
  elective: "탐구",
};

type SlotDraft = {
  slot?: 1 | 2;
  label?: string;
  items: GradedItem[];
  /** 저장 뒤에만 채워진다. */
  examScoreId?: string;
  /** 실모에 연결하면 채워진다("틀린문제 오답 업로드하기"가 이걸로 이동한다). */
  categoryId?: string | null;
};

type Step = "setup" | "uploading" | "review" | "saved";

export default function GradeExamFlow() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("setup");
  const [subject, setSubject] = useState<Subject>("korean");
  const [takenAt, setTakenAt] = useState(todayString());

  const [omrFile, setOmrFile] = useState<File | null>(null);
  const [keyFile, setKeyFile] = useState<File | null>(null);
  const [key1File, setKey1File] = useState<File | null>(null);
  const [key1Label, setKey1Label] = useState("");
  const [key2File, setKey2File] = useState<File | null>(null);
  const [key2Label, setKey2Label] = useState("");

  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slots, setSlots] = useState<SlotDraft[]>([]);
  const [tokenNote, setTokenNote] = useState<string | null>(null);

  const canGrade =
    subject === "elective"
      ? Boolean(omrFile && key1File && key2File)
      : Boolean(omrFile && keyFile);

  function reset() {
    setStep("setup");
    setOmrFile(null);
    setKeyFile(null);
    setKey1File(null);
    setKey1Label("");
    setKey2File(null);
    setKey2Label("");
    setSlots([]);
    setError(null);
    setTokenNote(null);
  }

  async function grade() {
    if (!canGrade) return;
    setStep("uploading");
    setError(null);
    setBusyMessage("사진을 준비하는 중...");
    try {
      const imageCount = subject === "elective" ? 3 : 2;
      const budget = gradingImageBudget(imageCount);

      const omr = await prepareGradingImage(omrFile as File, budget);
      const keys: { slot?: 1 | 2; label?: string; image: string }[] = [];
      if (subject === "elective") {
        keys.push({ slot: 1, label: key1Label.trim() || undefined, image: await prepareGradingImage(key1File as File, budget) });
        keys.push({ slot: 2, label: key2Label.trim() || undefined, image: await prepareGradingImage(key2File as File, budget) });
      } else {
        keys.push({ image: await prepareGradingImage(keyFile as File, budget) });
      }

      setBusyMessage("채점하는 중... (최대 1~2분)");
      const res = await fetch("/api/grade-exam", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, omr, keys }),
      });
      const json: {
        slots?: GradeSlot[];
        chargedTokens?: number | null;
        usage?: { estKrw?: number; estUsd?: number };
        error?: string;
      } = await res.json();
      if (!res.ok) throw new Error(json.error ?? "채점에 실패했습니다.");

      const gotSlots = json.slots ?? [];
      setSlots(
        gotSlots.map((s) => ({
          slot: s.slot,
          label: s.label ?? (s.slot === 1 ? key1Label.trim() || undefined : s.slot === 2 ? key2Label.trim() || undefined : undefined),
          items: s.items,
        })),
      );
      if (typeof json.chargedTokens === "number") {
        setTokenNote(
          json.usage?.estKrw
            ? `${json.chargedTokens}토큰 사용 (약 ${Math.round(json.usage.estKrw)}원)`
            : `${json.chargedTokens}토큰 사용`,
        );
      }
      setStep("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "채점에 실패했습니다.");
      setStep("uploading");
    } finally {
      setBusyMessage(null);
    }
  }

  function updateItem(slotIndex: number, itemIndex: number, patch: Partial<GradedItem>) {
    setSlots((prev) => {
      const next = [...prev];
      const items = [...next[slotIndex].items];
      items[itemIndex] = { ...items[itemIndex], ...patch };
      next[slotIndex] = { ...next[slotIndex], items };
      return next;
    });
  }

  async function saveAll() {
    setBusyMessage("저장하는 중...");
    setError(null);
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("로그인이 필요합니다.");

      const saved: SlotDraft[] = [];
      for (const slot of slots) {
        const summary = computeSummary(slot.items);
        const { data, error: insErr } = await supabase
          .from("exam_scores")
          .insert({
            user_id: user.id,
            subject,
            elective_slot: subject === "elective" ? (slot.slot ?? null) : null,
            elective_label: subject === "elective" ? slot.label ?? null : null,
            total_questions: summary.totalQuestions,
            correct_count: summary.correctCount,
            wrong_numbers: summary.wrongNumbers,
            score: summary.score,
            taken_at: takenAt,
          })
          .select("id")
          .single();
        if (insErr || !data) throw insErr ?? new Error("저장에 실패했습니다.");
        saved.push({ ...slot, examScoreId: data.id });
      }
      setSlots(saved);
      setStep("saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장에 실패했습니다.");
    } finally {
      setBusyMessage(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {step === "setup" && (
        <div className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4">
          <div>
            <p className="mb-2 text-sm font-medium text-slate-700">과목</p>
            <div className="flex gap-1.5">
              {(Object.keys(SUBJECT_LABEL) as Subject[]).map((s) => {
                const active = subject === s;
                return (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setSubject(s)}
                    className={`rounded-lg border px-4 py-2 text-sm transition-colors ${
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
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            시행일
            <input
              type="date"
              value={takenAt}
              onChange={(e) => setTakenAt(e.target.value)}
              className="rounded-lg border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
            />
          </label>

          <button
            type="button"
            onClick={() => setStep("uploading")}
            className="self-start rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            다음
          </button>
        </div>
      )}

      {step === "uploading" && (
        <div className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-sm text-slate-500">
            {SUBJECT_LABEL[subject]} · {takenAt}
          </p>

          <FileField label="OMR 카드" file={omrFile} onChange={setOmrFile} />

          {subject === "elective" ? (
            <>
              <div className="rounded-lg border border-slate-200 p-3">
                <p className="mb-2 text-sm font-medium text-slate-700">1선택</p>
                <input
                  value={key1Label}
                  onChange={(e) => setKey1Label(e.target.value)}
                  placeholder="과목명 (예: 생활과 윤리) — 선택 입력"
                  className="mb-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
                <FileField label="1선택 정답표" file={key1File} onChange={setKey1File} />
              </div>
              <div className="rounded-lg border border-slate-200 p-3">
                <p className="mb-2 text-sm font-medium text-slate-700">2선택</p>
                <input
                  value={key2Label}
                  onChange={(e) => setKey2Label(e.target.value)}
                  placeholder="과목명 (예: 사회·문화) — 선택 입력"
                  className="mb-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
                <FileField label="2선택 정답표" file={key2File} onChange={setKey2File} />
              </div>
            </>
          ) : (
            <FileField label="정답표" file={keyFile} onChange={setKeyFile} />
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}
          {busyMessage && <p className="text-sm text-slate-500">{busyMessage}</p>}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setStep("setup")}
              disabled={Boolean(busyMessage)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-40"
            >
              이전
            </button>
            <button
              type="button"
              onClick={() => void grade()}
              disabled={!canGrade || Boolean(busyMessage)}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              채점하기
            </button>
          </div>
        </div>
      )}

      {step === "review" && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-slate-500">
            아래 인식 결과를 확인하고, 틀리게 읽은 곳이 있으면 고친 뒤 저장하세요.
          </p>
          {slots.map((slot, si) => {
            const summary = computeSummary(slot.items);
            return (
              <div key={si} className="rounded-xl border border-slate-200 bg-white p-4">
                <p className="mb-2 text-sm font-semibold text-ink">
                  {subject === "elective" ? `${slot.slot}선택${slot.label ? ` · ${slot.label}` : ""}` : SUBJECT_LABEL[subject]}
                  {" — "}
                  {summary.score !== null
                    ? `${summary.score}점`
                    : `${summary.correctCount}/${summary.totalQuestions} 정답`}
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[420px] text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500">
                        <th className="w-12 py-1 text-left">번호</th>
                        <th className="py-1 text-left">학생답</th>
                        <th className="py-1 text-left">정답</th>
                        <th className="w-16 py-1 text-left">배점</th>
                        <th className="w-10 py-1 text-left">정오</th>
                      </tr>
                    </thead>
                    <tbody>
                      {slot.items.map((item, ii) => {
                        const isCorrect =
                          (item.studentAnswer ?? "").trim() !== "" &&
                          item.studentAnswer?.trim() === item.correctAnswer.trim();
                        return (
                          <tr key={ii} className="border-b border-slate-100">
                            <td className="py-1">{item.no}</td>
                            <td className="py-1">
                              <input
                                value={item.studentAnswer ?? ""}
                                onChange={(e) =>
                                  updateItem(si, ii, {
                                    studentAnswer: e.target.value === "" ? null : e.target.value,
                                  })
                                }
                                className="w-16 rounded border border-slate-300 px-1.5 py-0.5 focus:border-blue-500 focus:outline-none"
                              />
                            </td>
                            <td className="py-1">
                              <input
                                value={item.correctAnswer}
                                onChange={(e) => updateItem(si, ii, { correctAnswer: e.target.value })}
                                className="w-16 rounded border border-slate-300 px-1.5 py-0.5 focus:border-blue-500 focus:outline-none"
                              />
                            </td>
                            <td className="py-1">
                              <input
                                value={item.points ?? ""}
                                onChange={(e) => {
                                  const n = Number(e.target.value);
                                  updateItem(si, ii, {
                                    points: e.target.value === "" || Number.isNaN(n) ? undefined : n,
                                  });
                                }}
                                className="w-12 rounded border border-slate-300 px-1.5 py-0.5 focus:border-blue-500 focus:outline-none"
                              />
                            </td>
                            <td className={`py-1 ${isCorrect ? "text-emerald-600" : "text-red-500"}`}>
                              {isCorrect ? "O" : "X"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}

          {tokenNote && <p className="text-xs text-slate-400">{tokenNote}</p>}
          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={reset}
              disabled={Boolean(busyMessage)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-40"
            >
              처음부터
            </button>
            <button
              type="button"
              onClick={() => void saveAll()}
              disabled={Boolean(busyMessage)}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busyMessage ?? "저장"}
            </button>
          </div>
        </div>
      )}

      {step === "saved" && (
        <div className="flex flex-col gap-4">
          {slots.map((slot, si) => {
            const summary = computeSummary(slot.items);
            const title =
              subject === "elective"
                ? `${slot.slot}선택${slot.label ? ` · ${slot.label}` : ""}`
                : SUBJECT_LABEL[subject];
            return (
              <div key={si} className="rounded-xl border border-slate-200 bg-white p-4">
                <p className="text-base font-semibold text-ink">{title}</p>
                <p className="mt-1 text-sm text-slate-600">
                  {summary.score !== null
                    ? `${summary.score}점`
                    : `${summary.correctCount}/${summary.totalQuestions} 정답`}
                  {summary.wrongNumbers.length > 0 && (
                    <> · 틀린 번호: {summary.wrongNumbers.join(", ")}</>
                  )}
                </p>

                {subject !== "korean" && slot.examScoreId && (
                  <div className="mt-3 flex flex-col gap-2 border-t border-slate-100 pt-3">
                    <LinkCategoryPicker
                      examScoreId={slot.examScoreId}
                      score={summary.score}
                      suggestedSource={
                        subject === "elective" && slot.label
                          ? slot.label
                          : `${SUBJECT_LABEL[subject]} ${takenAt}`
                      }
                      takenAt={takenAt}
                      onLinked={(categoryId) => {
                        setSlots((prev) => {
                          const next = [...prev];
                          next[si] = { ...next[si], categoryId };
                          return next;
                        });
                      }}
                    />
                    {summary.wrongNumbers.length === 0 ? (
                      <p className="text-xs text-slate-400">틀린 문제가 없어 오답 업로드가 필요 없어요.</p>
                    ) : (
                      <button
                        type="button"
                        disabled={!slot.categoryId}
                        title={slot.categoryId ? undefined : "먼저 실모를 선택하거나 만들어주세요"}
                        onClick={() =>
                          slot.categoryId &&
                          router.push(`/categories/${slot.categoryId}?gradeId=${slot.examScoreId}`)
                        }
                        className="self-start rounded-lg border border-blue-600 px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400"
                      >
                        틀린문제 오답 업로드하기
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          <button
            type="button"
            onClick={reset}
            className="self-start rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
          >
            다른 시험 채점하기
          </button>
        </div>
      )}
    </div>
  );
}

function FileField({
  label,
  file,
  onChange,
}: {
  label: string;
  file: File | null;
  onChange: (f: File | null) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm text-slate-700">
      {label}
      <input
        type="file"
        accept="image/*"
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
        className="text-sm"
      />
      {file && <span className="text-xs text-slate-400">{file.name}</span>}
    </label>
  );
}
