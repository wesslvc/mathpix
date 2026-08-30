"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { isHeicFile } from "@/lib/cropImage";
import { prepareGradingImage, gradingImageBudget } from "@/lib/gradeImagePrep";
import {
  computeSummary,
  examMaxScore,
  type GradedItem,
  type GradeSlot,
  type Subject,
} from "@/lib/gradeSummary";
import {
  SOCIAL_ELECTIVES,
  SCIENCE_ELECTIVES,
  MATH_ELECTIVES,
  KOREAN_ELECTIVES,
  SUBJECT_LABEL,
} from "@/lib/examSubjects";
import LinkCategoryPicker from "./LinkCategoryPicker";
import CommentBox from "./CommentBox";
import ExamNameEditor from "./ExamNameEditor";
import ExamDateEditor from "./ExamDateEditor";

function todayString(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const VALID_SUBJECTS: readonly Subject[] = ["korean", "math", "english", "elective"];

/**
 * 원점수 만점은 항상 분모로 붙인다(국어·수학 100, 탐구 50). 정답표가
 * 배점을 다 못 읽어 합이 어긋나더라도 **만점 표기는 고정**한다 — 실제 배점
 * 합계를 다시 계산해 보여주는 게 아니라 "이 과목의 만점이 몇 점인지"를
 * 알려주는 라벨이다.
 */
function scoreLabel(subject: Subject, score: number | null): string {
  if (score === null) return "";
  return `${score}/${examMaxScore(subject)}점`;
}

/** 배점 후보. 실제 수능·모의고사가 쓰는 값만 준다 — 아무 숫자나 타이핑하게
 * 두면 "채점 끝나자마자 눌러서 바로 점수"라는 목적이 흐려진다. */
function pointOptions(subject: Subject): number[] {
  return subject === "math" ? [2, 3, 4] : [2, 3];
}

type SlotDraft = {
  slot?: 1 | 2;
  label?: string;
  items: GradedItem[];
  /**
   * 탐구인데 정답표에 배점이 하나도 없을 때, 틀린 문항만 골라 배점(잃은
   * 점수)을 적어 넣는다 — 20문항 전부에 배점을 적을 필요 없이 **틀린 것만**
   * 적으면 50점에서 그만큼을 뺀 값이 점수가 된다. 문항 번호 → 배점.
   */
  deductions: Record<number, number>;
  /** 저장 뒤에만 채워진다. */
  examScoreId?: string;
  /** 실모에 연결하면 채워진다("틀린문제 오답 업로드하기"가 이걸로 이동한다). */
  categoryId?: string | null;
  /** 1~9. 저장 뒤 화면에서 바로 고르면 즉시 반영된다. */
  gradeLevel?: number | null;
  /** 국어 전용 — 시험지 전체에 대한 메모. */
  comment?: string;
  /**
   * 이 슬롯만의 시험 이름. 탐구는 설정 단계에서 1선택·2선택 이름을 따로
   * 적으므로 처음부터 슬롯마다 값이 다르고, 국어·수학은 공통 examName을
   * 보여주다가 저장 뒤 화면에서 고치면 그때부터 슬롯마다 값이 갈린다.
   */
  examName?: string;
  /**
   * 이 슬롯만의 응시일. 저장 뒤 화면에서 고치면 그 슬롯 행만 바뀌므로
   * (탐구는 1·2선택이 독립된 행이다) 공통 takenAt 과 따로 들고 있어야
   * 화면과 DB 가 어긋나지 않는다.
   */
  takenAt?: string;
};

type Step = "setup" | "uploading" | "review" | "saved";

/**
 * 배점이 하나도 없는 슬롯의 점수를 정한다. **정답률로 얼버무리지 않는다**
 * — 틀린 문항의 배점을 적어 넣은 만큼 만점(`maxScore`)에서 빼서 실제
 * 점수를 낸다. 하나도 안 적었으면(아직 모름) null — 이때만 화면이 정답률을
 * 보인다.
 */
function deductionScore(
  wrongNumbers: number[],
  deductions: Record<number, number>,
  maxScore: number,
): number | null {
  if (wrongNumbers.length === 0) return maxScore;
  const entered = wrongNumbers.filter((no) => deductions[no] != null);
  if (entered.length === 0) return null;
  const lost = wrongNumbers.reduce((sum, no) => sum + (deductions[no] ?? 0), 0);
  return maxScore - lost;
}

export default function GradeExamFlow() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("setup");
  const [subject, setSubject] = useState<Subject>("korean");
  const [takenAt, setTakenAt] = useState(todayString());
  const [examName, setExamName] = useState("");
  // 탐구는 1선택·2선택이 서로 다른 시험(과목)이라 이름도 따로 쓴다 —
  // 예: 1선택 "생활과 윤리"는 "9모", 2선택 "지구과학Ⅰ"은 "6모"일 수 있다.
  const [examName1, setExamName1] = useState("");
  const [examName2, setExamName2] = useState("");
  const [mathElective, setMathElective] = useState("");
  const [koreanElective, setKoreanElective] = useState("");
  // 실제 수능은 늘 두 과목이지만, 한 과목만 풀어보는 연습(자체 제작
  // 워크시트 등)도 흔하다 — 그때 2선택을 강제로 채우게 하면 쓸 수 없다.
  const [tamguSingle, setTamguSingle] = useState(false);
  // 수능·모의고사 당일처럼 실제 OMR 카드를 학생이 가져올 수 없는 "정식시험"은
  // 대신 시험지 여백 등에 문항 번호별로 손으로 적어 둔 가채점표로 채점한다 —
  // 마킹 격자를 찾는 OMR 인식과는 다른 프롬프트가 필요하다.
  const [formalExam, setFormalExam] = useState(false);

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

  // 프로필에서 기본 과목을 미리 정해 뒀으면 여기서 자동으로 선택된다 —
  // 시험마다 매번 같은 과목(자신의 선택과목)을 새로 고르는 게 번거롭다는
  // 요청이다. 값이 있을 때만 덮어쓰고, 이미 사용자가 화면에서 손댔더라도
  // 마운트 시 한 번만 적용되므로 어긋나지 않는다.
  useEffect(() => {
    (async () => {
      try {
        const supabase = createClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return;
        const { data } = await supabase
          .from("grading_prefs")
          .select("subject, math_elective, korean_elective, tamgu_single, elective1_label, elective2_label")
          .eq("user_id", user.id)
          .maybeSingle();
        if (!data) return;
        if (VALID_SUBJECTS.includes(data.subject as Subject)) setSubject(data.subject as Subject);
        if (data.math_elective) setMathElective(data.math_elective);
        if (data.korean_elective) setKoreanElective(data.korean_elective);
        if (typeof data.tamgu_single === "boolean") setTamguSingle(data.tamgu_single);
        if (data.elective1_label) setKey1Label(data.elective1_label);
        if (data.elective2_label) setKey2Label(data.elective2_label);
      } catch {
        // 기본값을 못 불러와도 그냥 빈 화면으로 시작하면 그만이다(예전과
        // 같은 동작) — 이것 때문에 채점 화면 진입 자체를 막을 이유가 없다.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 국어·수학·탐구 전부 선택과목에 따라 시험 자체가 다르다(미적분/확통/기하,
  // 언매/화작, 탐구 17과목) — 안 고르고 채점하면 정답표 매칭이 어긋날 수
  // 있으니 반드시 골라야 다음으로 넘어가고, 채점도 시작할 수 있다. 영어는
  // 선택과목이 없어 항상 통과한다.
  const electivePicked =
    subject === "math"
      ? Boolean(mathElective)
      : subject === "korean"
        ? Boolean(koreanElective)
        : subject === "english"
          ? true
          : tamguSingle
            ? Boolean(key1Label)
            : Boolean(key1Label && key2Label);

  const canGrade =
    electivePicked &&
    (subject === "elective"
      ? tamguSingle
        ? Boolean(omrFile && key1File)
        : Boolean(omrFile && key1File && key2File)
      : Boolean(omrFile && keyFile));

  function reset() {
    setStep("setup");
    setExamName("");
    setExamName1("");
    setExamName2("");
    setMathElective("");
    setKoreanElective("");
    setTamguSingle(false);
    setFormalExam(false);
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

  /**
   * 결과·저장 화면에 보여줄 슬롯 제목. 탐구를 한 과목만 채점하면
   * slot이 없다("1선택"이라 부를 게 없다) — 그때는 "탐구"만 쓴다.
   */
  function slotTitle(slot: SlotDraft): string {
    if (subject !== "elective") {
      return `${SUBJECT_LABEL[subject]}${slot.label ? ` · ${slot.label}` : ""}`;
    }
    const prefix = slot.slot ? `${slot.slot}선택` : "탐구";
    return `${prefix}${slot.label ? ` · ${slot.label}` : ""}`;
  }

  /** 이 채점의 선택과목 라벨(탐구=1/2선택 과목명, 수학·국어=선택과목). */
  function electiveLabelFor(slot: 1 | 2 | undefined): string | undefined {
    if (subject === "elective") {
      return slot === 1 ? key1Label || undefined : slot === 2 ? key2Label || undefined : undefined;
    }
    if (subject === "math") return mathElective || undefined;
    if (subject === "korean") return koreanElective || undefined;
    return undefined;
  }

  async function grade() {
    if (!canGrade) return;
    setStep("uploading");
    setError(null);
    setBusyMessage("사진을 준비하는 중...");
    try {
      // 아이폰 카메라 기본 포맷(HEIC)은 브라우저가 못 연다. 미리 걸러내지
      // 않으면 loadImage가 실패하고 그 자리에서 "채점에 실패했습니다"라는
      // 뜻 없는 문구만 뜬다 — 사진 업로드(ImageUploader)·지면 통째로
      // 넣기(BatchSplitPanel)에는 이미 있는 안내를 여기도 넣는다.
      const filesToCheck = [omrFile, keyFile, key1File, key2File].filter(
        (f): f is File => f != null,
      );
      const heicFile = filesToCheck.find(isHeicFile);
      if (heicFile) {
        throw new Error(
          "HEIC/HEIF 형식은 브라우저에서 열 수 없습니다. 아이폰 설정 > 카메라 > 포맷을 '호환 우선'으로 바꾼 뒤 다시 찍거나, JPG로 바꿔서 올려주세요.",
        );
      }

      const imageCount = subject === "elective" ? (tamguSingle ? 2 : 3) : 2;
      const budget = gradingImageBudget(imageCount);

      const omr = await prepareGradingImage(omrFile as File, budget);
      const keys: { slot?: 1 | 2; label?: string; image: string }[] = [];
      if (subject === "elective") {
        keys.push({
          // 한 과목만 채점할 때는 "1선택"이라는 구분 자체가 없다 — slot을
          // 아예 안 매겨서 저장 때도 elective_slot이 null로 남게 한다.
          slot: tamguSingle ? undefined : 1,
          label: key1Label || undefined,
          image: await prepareGradingImage(key1File as File, budget),
        });
        if (!tamguSingle) {
          keys.push({ slot: 2, label: key2Label || undefined, image: await prepareGradingImage(key2File as File, budget) });
        }
      } else {
        keys.push({ image: await prepareGradingImage(keyFile as File, budget) });
      }

      setBusyMessage("채점하는 중... (최대 1~2분)");
      const res = await fetch("/api/grade-exam", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, omr, keys, method: formalExam ? "handwritten" : "omr" }),
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
          label: s.label ?? electiveLabelFor(s.slot),
          items: s.items,
          deductions: {},
          // 탐구는 슬롯마다 설정 단계에서 따로 적은 이름을 그대로 심어 둔다
          // — 아래에서 전부 `slot.examName ?? examName`(공통 이름)으로
          // 읽으므로, 여기서 채워두면 국어·수학과 같은 코드로 처리된다.
          examName: subject === "elective"
            ? tamguSingle
              ? examName1
              : s.slot === 1
                ? examName1
                : s.slot === 2
                  ? examName2
                  : undefined
            : undefined,
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

  function updateDeduction(slotIndex: number, no: number, points: number | undefined) {
    setSlots((prev) => {
      const next = [...prev];
      const deductions = { ...next[slotIndex].deductions };
      if (points === undefined) delete deductions[no];
      else deductions[no] = points;
      next[slotIndex] = { ...next[slotIndex], deductions };
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
        const finalScore =
          summary.score === null
            ? deductionScore(summary.wrongNumbers, slot.deductions, examMaxScore(subject))
            : summary.score;
        // 틀린 문항에 적어 넣은 배점을 items에도 남겨 둔다 — 세부오답
        // 보기에서 "이 문항 배점"이 계속 보이게 하려는 것이다.
        const itemsToSave = slot.items.map((it) =>
          slot.deductions[it.no] != null ? { ...it, points: slot.deductions[it.no] } : it,
        );

        const { data, error: insErr } = await supabase
          .from("exam_scores")
          .insert({
            user_id: user.id,
            subject,
            elective_slot: subject === "elective" ? (slot.slot ?? null) : null,
            elective_label: slot.label ?? null,
            exam_name: (slot.examName ?? examName).trim() || null,
            total_questions: summary.totalQuestions,
            correct_count: summary.correctCount,
            wrong_numbers: summary.wrongNumbers,
            score: finalScore,
            items: itemsToSave,
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

  async function setGradeLevel(slotIndex: number, examScoreId: string, level: number | null) {
    setSlots((prev) => {
      const next = [...prev];
      next[slotIndex] = { ...next[slotIndex], gradeLevel: level };
      return next;
    });
    const supabase = createClient();
    await supabase.from("exam_scores").update({ grade_level: level }).eq("id", examScoreId);
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

          {subject === "math" && (
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                선택과목 <span className="text-red-500">*</span>
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
              {!mathElective && (
                <p className="text-xs text-amber-600">
                  선택과목(미적분·확률과 통계·기하)에 따라 정답표가 다르니 꼭
                  골라주세요 — 안 고르면 다음으로 넘어갈 수 없어요.
                </p>
              )}
            </div>
          )}

          {subject === "korean" && (
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                선택과목 <span className="text-red-500">*</span>
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
              {!koreanElective && (
                <p className="text-xs text-amber-600">
                  선택과목(언어와 매체·화법과 작문)에 따라 정답표가 다르니 꼭
                  골라주세요 — 안 고르면 다음으로 넘어갈 수 없어요.
                </p>
              )}
            </div>
          )}

          {subject === "elective" && (
            <div className="flex flex-col gap-3">
              {/* 실제 수능은 1선택+2선택 둘 다지만, 한 과목만 풀어본
                  연습(자체 제작 워크시트 등)도 있다 — 그때 2선택을
                  강제로 채우게 하면 못 쓴다. */}
              <div>
                <p className="mb-1 text-sm font-medium text-slate-700">몇 과목</p>
                <div className="flex gap-1.5">
                  {([
                    { value: false, label: "1선택+2선택" },
                    { value: true, label: "1과목만" },
                  ] as const).map((opt) => (
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

              <div className="flex flex-col gap-1">
                <p className="text-sm text-slate-700">
                  선택과목 <span className="text-red-500">*</span>
                </p>
                {tamguSingle ? (
                  <ElectiveSelect value={key1Label} onChange={setKey1Label} />
                ) : (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <p className="mb-1 text-xs font-medium text-slate-500">1선택</p>
                      <ElectiveSelect value={key1Label} onChange={setKey1Label} />
                    </div>
                    <div>
                      <p className="mb-1 text-xs font-medium text-slate-500">2선택</p>
                      <ElectiveSelect value={key2Label} onChange={setKey2Label} />
                    </div>
                  </div>
                )}
                {!electivePicked && (
                  <p className="text-xs text-amber-600">
                    {tamguSingle
                      ? "과목을 17과목 중에서 골라주세요 — 안 고르면 다음으로 넘어갈 수 없어요."
                      : "1선택·2선택 과목을 17과목 중에서 각각 골라주세요 — 안 고르면 다음으로 넘어갈 수 없어요."}
                  </p>
                )}
              </div>
            </div>
          )}

          {subject === "elective" ? (
            tamguSingle ? (
              <label className="flex items-center gap-2 text-sm text-slate-700">
                시험 이름
                <input
                  value={examName1}
                  onChange={(e) => setExamName1(e.target.value)}
                  placeholder="예: 2025학년도 9월 모의평가 — 선택 입력"
                  className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                />
              </label>
            ) : (
              // 탐구는 1선택·2선택이 서로 다른 시험일 수 있다(예: 1선택은
              // 9월 모의평가, 2선택은 6월 모의평가) — 이름 하나로는 못
              // 담으므로 선택과목 select와 같은 자리에 나란히 둘을 둔다.
              <div className="flex flex-col gap-1">
                <p className="text-sm text-slate-700">시험 이름 (선택 입력)</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-xs text-slate-500">
                    1선택
                    <input
                      value={examName1}
                      onChange={(e) => setExamName1(e.target.value)}
                      placeholder="예: 2025학년도 9월 모의평가"
                      className="rounded-lg border border-slate-300 px-2 py-1 text-sm text-ink focus:border-blue-500 focus:outline-none"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-slate-500">
                    2선택
                    <input
                      value={examName2}
                      onChange={(e) => setExamName2(e.target.value)}
                      placeholder="예: 2025학년도 9월 모의평가"
                      className="rounded-lg border border-slate-300 px-2 py-1 text-sm text-ink focus:border-blue-500 focus:outline-none"
                    />
                  </label>
                </div>
              </div>
            )
          ) : (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              시험 이름
              <input
                value={examName}
                onChange={(e) => setExamName(e.target.value)}
                placeholder="예: 2025학년도 9월 모의평가 — 선택 입력"
                className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
              />
            </label>
          )}

          <label className="flex items-center gap-2 text-sm text-slate-700">
            시행일
            <input
              type="date"
              value={takenAt}
              onChange={(e) => setTakenAt(e.target.value)}
              className="rounded-lg border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
            />
          </label>

          {/* 수능·모의고사 당일처럼 실제 OMR 카드를 학생이 가져올 수 없는
              "정식시험"은 대신 시험지 여백 등에 손으로 적어 둔 가채점표로
              채점한다 — 마킹 격자를 찾는 것과는 다른 인식 방식이 필요하다. */}
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={formalExam}
              onChange={(e) => setFormalExam(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              정식시험 (OMR 카드를 못 가져와서 가채점표로 채점)
              <span className="block text-xs text-slate-400">
                체크하면 마킹된 OMR 대신, 손으로 문항 번호 옆에 적은 답을 읽어요.
              </span>
            </span>
          </label>

          <button
            type="button"
            onClick={() => setStep("uploading")}
            disabled={!electivePicked}
            title={electivePicked ? undefined : "선택과목을 먼저 골라주세요"}
            className="self-start rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            다음
          </button>
        </div>
      )}

      {step === "uploading" && (
        <div className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-sm text-slate-500">
            {SUBJECT_LABEL[subject]}
            {electiveLabelFor(undefined) && ` · ${electiveLabelFor(undefined)}`}
            {examName && ` · ${examName}`} · {takenAt}
          </p>

          <FileField label={formalExam ? "가채점표" : "OMR 카드"} file={omrFile} onChange={setOmrFile} />

          {subject === "elective" ? (
            tamguSingle ? (
              <div className="rounded-lg border border-slate-200 p-3">
                <p className="mb-2 text-sm font-medium text-slate-700">
                  {key1Label}
                  {examName1 && ` · ${examName1}`}
                </p>
                <FileField label="정답표" file={key1File} onChange={setKey1File} />
              </div>
            ) : (
              <>
                <div className="rounded-lg border border-slate-200 p-3">
                  <p className="mb-2 text-sm font-medium text-slate-700">
                    1선택 · {key1Label}
                    {examName1 && ` · ${examName1}`}
                  </p>
                  <FileField label="1선택 정답표" file={key1File} onChange={setKey1File} />
                </div>
                <div className="rounded-lg border border-slate-200 p-3">
                  <p className="mb-2 text-sm font-medium text-slate-700">
                    2선택 · {key2Label}
                    {examName2 && ` · ${examName2}`}
                  </p>
                  <FileField label="2선택 정답표" file={key2File} onChange={setKey2File} />
                </div>
              </>
            )
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
            const needsDeduction = summary.score === null;
            const maxScore = examMaxScore(subject);
            const dScore = needsDeduction
              ? deductionScore(summary.wrongNumbers, slot.deductions, maxScore)
              : null;
            const missing = needsDeduction
              ? summary.wrongNumbers.filter((no) => slot.deductions[no] == null)
              : [];
            return (
              <div key={si} className="rounded-xl border border-slate-200 bg-white p-4">
                <p className="mb-2 text-sm font-semibold text-ink">
                  {slotTitle(slot)}
                  {" — "}
                  {needsDeduction
                    ? dScore !== null
                      ? scoreLabel(subject, dScore)
                      : "배점을 입력해주세요"
                    : summary.score !== null
                      ? scoreLabel(subject, summary.score)
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

                {/* 정답표에 배점이 하나도 없을 때 — 틀린 문항만 골라 배점을
                    고르면 만점에서 그만큼을 뺀다. 정답률로 얼버무리지 않는다.
                    타이핑 대신 버튼으로 고르게 한 것은 "채점 끝나자마자 눌러서
                    바로 점수가 나오게" 하려는 것 — 실제 시험 배점은 국어·탐구
                    2·3점, 수학 2·3·4점 몇 가지뿐이라 버튼이면 충분하다. */}
                {needsDeduction && summary.wrongNumbers.length > 0 && (
                  <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                    <p className="mb-2 text-xs font-medium text-amber-900">
                      정답표에 배점이 없어요. 틀린 문항의 배점을 고르면 {maxScore}점
                      만점에서 계산해드려요.
                    </p>
                    <div className="flex flex-col gap-1.5">
                      {summary.wrongNumbers.map((no) => (
                        <div key={no} className="flex items-center gap-2 text-xs text-amber-900">
                          <span className="w-10 shrink-0">{no}번</span>
                          <div className="flex gap-1">
                            {pointOptions(subject).map((p) => {
                              const active = slot.deductions[no] === p;
                              return (
                                <button
                                  key={p}
                                  type="button"
                                  aria-pressed={active}
                                  onClick={() => updateDeduction(si, no, active ? undefined : p)}
                                  className={`rounded border px-2 py-0.5 transition-colors ${
                                    active
                                      ? "border-amber-600 bg-amber-600 text-white"
                                      : "border-amber-300 bg-white text-amber-800 hover:bg-amber-100"
                                  }`}
                                >
                                  {p}점
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                    {missing.length > 0 && (
                      <p className="mt-2 text-xs text-amber-700">
                        {missing.length}개 문항 배점 미입력 — 지금 점수는
                        입력한 것만 반영한 값이라 정확하지 않을 수 있어요.
                      </p>
                    )}
                  </div>
                )}
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
            const finalScore =
              summary.score === null
                ? deductionScore(summary.wrongNumbers, slot.deductions, examMaxScore(subject))
                : summary.score;
            const title = slotTitle(slot);
            return (
              <div key={si} className="rounded-xl border border-slate-200 bg-white p-4">
                {slot.examScoreId && (
                  <div className="flex flex-col gap-0.5">
                    <ExamNameEditor
                      examScoreId={slot.examScoreId}
                      value={slot.examName ?? examName}
                      categoryId={slot.categoryId ?? null}
                      onSaved={(name) =>
                        setSlots((prev) => {
                          const next = [...prev];
                          next[si] = { ...next[si], examName: name };
                          return next;
                        })
                      }
                    />
                    {/* 채점할 때 고른 시행일이 실제 응시일과 다를 수 있다
                        (기본값이 "오늘"이라 며칠 지나 채점하면 어긋난다).
                        추세 그래프의 가로축이라 여기서 바로 고칠 수 있게 한다. */}
                    <ExamDateEditor
                      examScoreId={slot.examScoreId}
                      value={slot.takenAt ?? takenAt}
                      categoryId={slot.categoryId ?? null}
                      onSaved={(date) =>
                        setSlots((prev) => {
                          const next = [...prev];
                          next[si] = { ...next[si], takenAt: date };
                          return next;
                        })
                      }
                    />
                  </div>
                )}
                <p className="text-base font-semibold text-ink">{title}</p>
                <p className="mt-1 text-sm text-slate-600">
                  {finalScore !== null
                    ? scoreLabel(subject, finalScore)
                    : `${summary.correctCount}/${summary.totalQuestions} 정답`}
                  {summary.wrongNumbers.length > 0 && (
                    <> · 틀린 번호: {summary.wrongNumbers.join(", ")}</>
                  )}
                </p>

                <label className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                  등급
                  <select
                    value={slot.gradeLevel ?? ""}
                    disabled={!slot.examScoreId}
                    onChange={(e) =>
                      slot.examScoreId &&
                      void setGradeLevel(
                        si,
                        slot.examScoreId,
                        e.target.value === "" ? null : Number(e.target.value),
                      )
                    }
                    className="rounded border border-slate-300 px-2 py-0.5 text-xs focus:border-blue-500 focus:outline-none"
                  >
                    <option value="">미입력</option>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((g) => (
                      <option key={g} value={g}>
                        {g}등급
                      </option>
                    ))}
                  </select>
                </label>

                {/* 실모 연결은 모든 과목에서 보여준다 — 만점을 받아 틀린
                    문제가 없어도(국어는 애초에 오답추가가 없어도) 적어도
                    이름은 붙여 저장할 수 있어야 한다는 요청이다. */}
                {slot.examScoreId && (
                  <div className="mt-3 flex flex-col gap-2 border-t border-slate-100 pt-3">
                    <LinkCategoryPicker
                      examScoreId={slot.examScoreId}
                      score={finalScore}
                      suggestedSource={
                        (slot.examName ?? examName).trim() ||
                        (subject === "elective" && slot.label
                          ? slot.label
                          : `${SUBJECT_LABEL[subject]} ${takenAt}`)
                      }
                      takenAt={takenAt}
                      onExamNameSynced={(name) =>
                        setSlots((prev) => {
                          const next = [...prev];
                          next[si] = { ...next[si], examName: name };
                          return next;
                        })
                      }
                      onLinked={(categoryId) => {
                        setSlots((prev) => {
                          const next = [...prev];
                          next[si] = { ...next[si], categoryId };
                          return next;
                        });
                      }}
                    />

                    {subject === "korean" ? (
                      // 국어는 문항 단위 오답추가가 없다(지문이 여러 문항에
                      // 걸쳐 있어 "문제 하나 사진"이라는 단위와 안 맞는다).
                      // 대신 시험지 전체에 대한 메모를 남긴다.
                      <CommentBox
                        examScoreId={slot.examScoreId}
                        value={slot.comment ?? ""}
                        onSaved={(comment) =>
                          setSlots((prev) => {
                            const next = [...prev];
                            next[si] = { ...next[si], comment };
                            return next;
                          })
                        }
                      />
                    ) : summary.wrongNumbers.length === 0 ? (
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

          <div className="flex gap-2">
            <button
              type="button"
              onClick={reset}
              className="self-start rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
            >
              다른 시험 채점하기
            </button>
            <button
              type="button"
              onClick={() => router.push("/profile")}
              className="self-start rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
            >
              채점 기록 보기
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 프로필의 기본 과목 설정(GradingPrefsForm)도 같은 17과목 select를 쓴다. */
export function ElectiveSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="mb-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
    >
      <option value="">과목 선택</option>
      <optgroup label="사회탐구">
        {SOCIAL_ELECTIVES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </optgroup>
      <optgroup label="과학탐구">
        {SCIENCE_ELECTIVES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </optgroup>
    </select>
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
