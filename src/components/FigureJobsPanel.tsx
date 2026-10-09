"use client";

import { SolChat } from "@/components/SolChat";
import { ModelBadge, withModelLogo, type ModelKey } from "@/components/ModelBadge";
import { useState, useSyncExternalStore } from "react";
import { useFigureJobs, type FigureJob, type OfferDiffs } from "./FigureJobsProvider";
import {
  dismissLocalTask,
  getLocalTasks,
  getLocalTasksServer,
  subscribeLocalTasks,
  type LocalTask,
} from "@/lib/aiTask";

/**
 * **작업을 범주로 묶어 보인다**(2026-10-04, 사용자 — "지금은 작업이 다 같이 섞여 보이잖아, 범주화시켜 줘"). 누가 무엇을 하는지로
 * 가른다: 그림을 그리는 일(돈·시간이 가장 많이 든다) · 지문 글자 옮기기 · sol 이 하는 일 · Mathpix 글자 인식 · luna 가 하는 빠른 일.
 */
type Category = "draw" | "passage" | "sol" | "mathpix" | "haiku" | "luna";
const CATEGORY_ORDER: Category[] = ["draw", "passage", "sol", "mathpix", "haiku", "luna"];
/** 범주마다 일하는 모델(로고). Mathpix 는 로고가 없어 글자만. */
const CATEGORY_MODEL: Partial<Record<Category, ModelKey>> = { draw: "sunburst", passage: "sol", sol: "sol", haiku: "haiku", luna: "luna" };
const CATEGORY_LABEL: Record<Category, string> = {
  draw: "AI 그리기",
  passage: "지문 글자로 옮기기",
  sol: "sol 작업 (조판·대화·지문)",
  mathpix: "Mathpix 글자 인식",
  haiku: "자동 자르기 (사진·지면 문제 자리)",
  luna: "빠른 작업 (그림 자리·채점·제목·번호)",
};
const LUNA_TASKS = new Set(["figures", "numberBox", "title", "grade", "answerKey"]);
function categoryOf(j: FigureJob): Category {
  if (j.mode === "passage") return "passage";
  if (j.mode !== "task") return "draw";
  const t = j.stage ?? "";
  if (t === "ocr") return "mathpix";
  if (t === "detect" || t === "crop") return "haiku";
  if (LUNA_TASKS.has(t)) return "luna";
  return "sol";
}
const LOCAL_RUNNING: Record<string, string> = {
  crop: "haiku 가 문제 자리를 자르는 중",
  figures: "luna 가 그림 자리를 찾는 중",
  numberBox: "luna 가 문제 번호 자리를 찾는 중",
  detect: "haiku 가 문제 자리를 찾는 중",
  title: "luna 가 지문 제목을 짓는 중",
  grade: "luna 가 채점하는 중",
  answerKey: "luna 가 답지를 읽는 중",
};

const STATUS_TEXT = {
  pending: "차례 기다리는 중",
  running: "AI가 그리는 중",
  done: "완료",
  error: "실패",
} as const;

/**
 * 지문 작업은 그림을 그리는 게 아니라 **글자로 옮긴다**(사용자 — "지문은 글을
 * 옮겨적는중이라고"). 서버가 알려 주는 단계로 지금 무엇을 하는지 적는다.
 */
/**
 * 짧은 AI 작업(mode "task")이 지금 하는 일. `stage` 가 일의 종류다(`aiTasks.ts`).
 * 사용자가 무엇을 기다리는지 알 수 있게 **어느 모델이 무엇을 하는지** 적는다.
 */
const TASK_RUNNING: Record<string, string> = {
  ocr: "Mathpix 가 글자를 읽는 중",
  detect: "haiku 가 문제 자리를 찾는 중",
  crop: "haiku 가 문제 자리를 자르는 중",
  figures: "luna 가 그림 자리를 찾는 중",
  numberBox: "luna 가 문제 번호 자리를 찾는 중",
  title: "luna 가 지문 제목을 짓는 중",
  grade: "luna 가 채점하는 중",
  answerKey: "luna 가 답지를 읽는 중",
  passageRead: "sol 이 지문을 글자로 옮기는 중",
  passageMarks: "sol 이 서식(원문자·밑줄·네모·굵게)을 검수하는 중",
  typeset: "sol 이 문제를 글자로 옮겨 적는 중",
  chat: "sol 이 답하는 중",
};
/** 짧은 작업의 남은 시간 어림(초). */
const TASK_SECONDS: Record<string, number> = {
  ocr: 8,
  detect: 60,
  crop: 10,
  numberBox: 8,
  title: 15,
  grade: 40,
  answerKey: 30,
  passageRead: 150,
  passageMarks: 90,
  typeset: 90,
  chat: 30,
};

function statusText(j: FigureJob, top: string): string {
  if (j.status === "done" && j.stage === "max-offer") return "완료 · 글자·도형 차이가 남았어요";
  if (j.status !== "running" && j.status !== "pending") return STATUS_TEXT[j.status];
  if (j.mode === "task") {
    return j.status === "pending" ? "차례 기다리는 중" : (TASK_RUNNING[j.stage ?? ""] ?? "AI 가 처리하는 중");
  }
  // 문제 통째로 그리기는 그리기 → sol 검수 → 고쳐 그리기를 단계로 돈다(`gen:N` / `verify:N`).
  if (j.mode !== "passage" && j.stage) {
    if (j.stage === "patch-plan") return `${j.status === "pending" ? "차례 기다리는 중 · " : ""}sol 이 수정 요청을 해석하는 중`;
    if (j.stage === "patch") return `${j.status === "pending" ? "차례 기다리는 중 · " : ""}수정하는 중`;
    if (j.stage === "assess") return `${j.status === "pending" ? "차례 기다리는 중 · " : ""}luna 가 그리기 난이도를 보는 중`;
    const gen = /^gen:(\d+)$/.exec(j.stage);
    const ver = /^verify:(\d+)$/.exec(j.stage);
    const q = ["low", "medium", top];
    if (gen) {
      const n = Number(gen[1]);
      // luna 가 고른 시작 칸이면(메모가 "luna:" 로 시작) 첫 그리기다 — "고쳐" 를 붙이지 않는다.
      const first = n === 0 || (j.note ?? "").startsWith("luna:");
      return `${j.status === "pending" ? "차례 기다리는 중 · " : ""}${first ? "" : "고쳐 "}그리는 중 (${q[Math.min(n, 2)]})`;
    }
    if (ver) return `${j.status === "pending" ? "차례 기다리는 중 · " : ""}sol 이 글자·도형 검수 중`;
    return STATUS_TEXT[j.status];
  }
  if (j.mode !== "passage") return STATUS_TEXT[j.status];
  const stage = j.stage ?? "read";
  const fig = /^figure:(\d+)$/.exec(stage);
  const what =
    stage === "read"
      ? "지문을 글자로 옮기는 중 (지문 안 그림도 함께 그려요)"
      : stage === "marks"
        ? "서식(원문자·밑줄·네모·굵게) 검수 중"
        : fig
          ? `지문 안 그림 다시 그리는 중 (${Number(fig[1]) + 1}번째)`
          : "지문 처리 중";
  return j.status === "pending" && stage === "read" ? "차례 기다리는 중 · 지문 글자로 옮기기" : what;
}


/**
 * 남은 시간 어림(초). 운영 로그로 잰 값이다 — 문제 통째로 그리기: low 그리기 ~35초 · medium ~45초 ·
 * sol 검수 ~15초, 열 문제 중 일곱쯤은 low 한 번에 끝난다. 지문은 읽기·서식 검수·그림. 어림일 뿐이라
 * 화면에는 "약 N분"으로만 적는다(정확한 시간인 척하지 않는다).
 */
function remainingSeconds(j: FigureJob): number {
  if (j.status !== "running" && j.status !== "pending") return 0;
  if (j.mode === "task") return TASK_SECONDS[j.stage ?? ""] ?? 30;
  if (j.mode === "problem" || (j.mode !== "passage" && j.stage)) {
    // 전 단계 기대값: 그리기 low + 검수, 30% 는 medium 으로 한 번 더. max 는 사용자 확인 뒤에만 돈다.
    const stage = j.stage ?? "gen:0";
    if (stage === "patch-plan") return 90;
    if (stage === "patch") return 120;
    if (stage === "assess") return 10 + 35 + 15 + 0.3 * (45 + 15);
    const gen = /^gen:(\d+)$/.exec(stage);
    const ver = /^verify:(\d+)$/.exec(stage);
    const n = gen ? Number(gen[1]) : ver ? Number(ver[1]) : 0;
    const left = [35 + 15 + 0.3 * (45 + 15), 45 + 15, 90 + 15][Math.min(n, 2)];
    return Math.round(ver ? left - (n === 0 ? 35 : n === 1 ? 45 : 90) : left);
  }
  if (j.mode === "passage") {
    const stage = j.stage ?? "read";
    // 그림은 읽기와 함께 그려지므로(2026-10-09) 읽기 뒤에는 서식 검수만 남는다.
    return stage === "read" ? 150 + 90 : stage === "marks" ? 90 : 60;
  }
  return 45; // 그림 하나
}

function formatWait(sec: number): string {
  if (sec < 60) return "1분 안팎";
  const m = Math.round(sec / 60);
  return `약 ${m}분`;
}

const KIND_LABEL = { text: "글자", glyph: "깨진 글자", figure: "도형", handwriting: "손글씨" } as const;
const KIND_STYLE = {
  text: "bg-blue-50 text-blue-700",
  glyph: "bg-purple-50 text-purple-700",
  figure: "bg-emerald-50 text-emerald-700",
  handwriting: "bg-amber-50 text-amber-800",
} as const;

/**
 * AI 그림 작업 현황을 화면 구석에 띄우는 패널.
 *
 * 작업이 도는 동안 사용자는 다음 문제로 넘어가 계속 작업한다. 그래서 진행
 * 상황은 문제 화면이 아니라 **화면 전체에 떠 있는 이 패널**에서 본다.
 * 작업이 하나도 없으면 아예 나타나지 않는다.
 */
export default function FigureJobsPanel() {
  const {
    jobs,
    activeCount,
    submitting,
    serverActive,
    calls,
    spentUsd,
    spentKrw,
    krwRate,
    spentTokens,
    retry,
    dismiss,
    topQuality,
    concurrency,
    maxTokens,
    patchTokens,
    confirmPatch,
    loadOfferDiffs,
    confirmMax,
    skipMax,
  } = useFigureJobs();
  const [open, setOpen] = useState(false);
  const [maxBusy, setMaxBusy] = useState(false);
  const [maxError, setMaxError] = useState<string | null>(null);
  // "이게 다릅니다, 진행하시겠어요?" 확인 창.
  const [confirming, setConfirming] = useState<FigureJob[] | null>(null);
  // 여러 문제를 한꺼번에 볼 때 **진행할 것만 골라** 돌린다(나머지는 확인 대기로 남는다).
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Record<string, OfferDiffs> | null>(null);
  // 한 문제만 볼 때는 두 길을 고른다: 수정(저장된 그림에서 적은 곳만 고침) / 맨 위 화질로 처음부터 다시 그리기.
  const [choice, setChoice] = useState<"patch" | "redraw">("patch");
  const [patchText, setPatchText] = useState("");
  const [patchDiffs, setPatchDiffs] = useState(true);
  // sol 이 지점 위치 등을 원본과 자세히 비교해 그림 모델에 강하게 지시할지(사용자가 고른다).
  // 수정은 기본이 **sol 과 대화**다(사용자 — "수정모드 때는 sol 과 LLM 형태로 대화해서 최종 확정"). 글로만 적어 바로 고치는 길도 남겨 둔다.
  const [patchMode, setPatchMode] = useState<"chat" | "text">("chat");

  // 대기열을 안 타고 곧바로 부른 luna 일들(화면 안에서만 산다).
  const localTasks = useSyncExternalStore(subscribeLocalTasks, getLocalTasks, getLocalTasksServer);
  // 범주마다 접기. luna 는 많고 금방 끝나서 처음엔 접어 둔다.
  const [collapsed, setCollapsed] = useState<Set<Category>>(() => new Set<Category>(["luna"]));

  if (jobs.length === 0 && localTasks.length === 0) return null;
  const localRunning = localTasks.filter((t) => t.status === "running").length;
  const localFailed = localTasks.filter((t) => t.status === "error").length;

  // medium 까지 해도 차이가 남아 **max 확인을 기다리는** 문제들. max 는 사용자가 확인해야만 돈다.
  const offers = jobs.filter((j) => j.status === "done" && j.stage === "max-offer");
  const idle = activeCount === 0 && submitting === 0;

  /** 누르면 바로 걷지 않고 **무엇이 다른지 먼저 보여 준다.** */
  async function openConfirm(list: FigureJob[]) {
    setMaxError(null);
    setDetails(null);
    setChoice(list.length === 1 ? "patch" : "redraw");
    setPicked(new Set(list.map((j) => j.id)));
    setPatchText("");
    setPatchDiffs(true);
    setPatchMode("chat");
    setConfirming(list);
    setDetails(await loadOfferDiffs());
  }
  async function runMax(list: FigureJob[]) {
    setMaxBusy(true);
    setMaxError(null);
    let ok = true;
    for (const j of list) {
      const err = await confirmMax(j.id);
      if (err) {
        setMaxError(err);
        ok = false;
        break;
      }
    }
    setMaxBusy(false);
    if (ok) setConfirming(null);
  }
  async function runPatch(j: FigureJob, chat?: { text: string; understood: string }) {
    setMaxBusy(true);
    setMaxError(null);
    const err = await confirmPatch(j.id, chat ? "" : patchText, chat ? false : patchDiffs, !!chat, chat);
    setMaxBusy(false);
    if (err) setMaxError(err);
    else setConfirming(null);
  }
  async function closeOffers(list: FigureJob[]) {
    setMaxBusy(true);
    for (const j of list) await skipMax(j.id);
    setMaxBusy(false);
  }
  /**
   * **패스** — 이 문제들은 더 고쳐 그리지 않고 지금 저장된 그림 그대로 쓴다(사용자 — "그냥 쓸 것도 일부만 선택해서
   * 배제시킬 수 있게"). 확인 창에서 빼고, 남은 게 없으면 창을 닫는다.
   */
  async function passOffers(list: FigureJob[]) {
    if (list.length === 0) return;
    setMaxError(null);
    await closeOffers(list);
    const gone = new Set(list.map((j) => j.id));
    setPicked((prev) => new Set([...prev].filter((id) => !gone.has(id))));
    setConfirming((prev) => {
      const rest = (prev ?? []).filter((j) => !gone.has(j.id));
      return rest.length ? rest : null;
    });
  }
  /** 확인하면 그릴 다음 단계와 걷을 토큰. 차이 목록을 아직 못 받았으면 맨 위 단계(유료)로 친다. */
  function targetOf(j: FigureJob): { quality: string; tokens: number } {
    const d = details?.[j.id];
    return { quality: d?.target ?? topQuality, tokens: typeof d?.tokens === "number" ? d.tokens : maxTokens };
  }
  function tokenText(n: number): string {
    return n > 0 ? `${n.toLocaleString()}토큰` : "추가 토큰 없음";
  }

  const failed = jobs.filter((j) => j.status === "error").length + localFailed;
  const busyCount = activeCount + localRunning;
  const activeJobs = jobs.filter((j) => j.status === "pending" || j.status === "running");
  // 줄 전체가 끝나기까지 어림(일반 계정은 한 번에 하나씩, 무제한 계정은 여러 개가 동시에).
  // 무제한 계정은 여러 개를 동시에 돌리므로 그만큼 나눈다(가장 긴 한 개보다 짧아질 수는 없다).
  const remaining = jobs.map(remainingSeconds).filter((n) => n > 0);
  const waitSec =
    remaining.length === 0
      ? 0
      : Math.max(Math.max(...remaining), remaining.reduce((a, b) => a + b, 0) / Math.min(concurrency, remaining.length));

  return (
    <div className="fixed bottom-4 right-4 z-40 w-[min(20rem,calc(100vw-2rem))]">
      <div className="animate-fade-in overflow-hidden rounded-xl border border-slate-300 bg-white shadow-lg">
        {/* 나가도 되는지 안 되는지를 늘 보이게 한다. 서버에 넣는 몇 초 동안만 나가면 안 된다 —
            그 뒤로는 서버가 그리므로 창을 닫아도 · 오프라인이어도 계속된다. */}
        {submitting > 0 ? (
          <p className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-snug text-amber-800">
            ⚠ 서버로 보내는 중이에요 ({submitting}개). 다 보낼 때까지 이 창을 닫거나 나가지 마세요.
          </p>
        ) : serverActive && activeJobs.every((j) => j.mode === "task") ? (
          // 짧은 작업(글자 인식·채점·대화 …)은 결과를 **이 화면이** 받아 간다 — 창을 닫으면 서버는 끝까지 돌아도
          // 결과를 받을 곳이 없다. 그림 작업과 달리 "닫아도 된다"고 하면 안 된다.
          <p className="border-b border-sky-200 bg-sky-50 px-3 py-2 text-[11px] leading-snug text-sky-800">
            서버에서 AI 가 처리하는 중이에요. 결과는 이 화면으로 돌아와요 — 끝날 때까지 이 화면을 열어 두세요.
          </p>
        ) : serverActive ? (
          <p className="border-b border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] leading-snug text-emerald-800">
            ✓ 서버로 다 보냈어요. 이제 서버에서 처리하니까 창을 닫거나 오프라인이어도 계속돼요.
            {activeCount > 0 && (
              <>
                {" "}
                <b>예상 {formatWait(waitSec)}</b> 걸려요 — 기다리지 말고 다른 문제를 넣거나 잠깐 쉬다 오세요. 나중에 다시
                들어오면 결과가 저장돼 있어요.
              </>
            )}
          </p>
        ) : null}
        {/* **max 는 마지막에 사용자 확인을 받고 돌린다.** 다른 작업이 다 끝나 줄이 비었을 때 한 번에 묻는다. */}
        {idle && offers.length > 0 && (
          <div className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-snug text-amber-900">
            <p>
              <b>글자·도형 차이가 남은 문제 {offers.length}개</b>가 있어요. 가장 나은 그림은 이미 저장돼 있어요. 화질을 올려 한 번 더
              고쳐 그리는 건 <b>확인한 것만</b> 돌아요 — 차이를 보고 문제마다 진행하거나 그대로 쓰기(패스)를 고르세요.
            </p>
            {maxError && <p className="mt-1 text-red-700">{maxError}</p>}
            <div className="mt-1.5 flex gap-1.5">
              <button
                type="button"
                disabled={maxBusy}
                onClick={() => void openConfirm(offers)}
                className="rounded bg-amber-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {maxBusy ? "처리 중…" : "차이 보고 고르기"}
              </button>
              <button
                type="button"
                disabled={maxBusy}
                onClick={() => void closeOffers(offers)}
                className="rounded border border-amber-300 bg-white px-2 py-1 text-[11px] text-amber-800 hover:bg-amber-100 disabled:opacity-50"
              >
                모두 그대로 쓰기 (패스)
              </button>
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
        >
          {busyCount > 0 ? (
            <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
          ) : failed > 0 ? (
            <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" />
          ) : offers.length > 0 ? (
            <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
          ) : (
            <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
          )}
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-700">
            {busyCount > 0
              ? `AI 작업 ${busyCount}개 진행 중`
              : failed > 0
                ? `${failed}개 실패`
                : offers.length > 0
                  ? `AI 작업 완료 · 확인 대기 ${offers.length}개`
                  : "AI 작업 완료"}
          </span>
          {/* 실제로 나간 유료 호출 수. 문제 수보다 많아지면(재시도가 쌓이면)
              그만큼 요금이 더 나간 것인데 지금까지 아무 단서가 없었다.
              캐시에 걸린 것은 세지 않는다 — 그건 돈이 안 나갔다. */}
          {calls > 0 && (
            <span className="shrink-0 text-[11px] text-slate-400">
              생성 {calls}회
              {/* 금액은 무제한 계정에만 온다(서버가 가린다). 일반 사용자에게는
                  토큰이 곧 비용이므로 그쪽을 보여준다. */}
              {spentUsd > 0
                ? ` · 약 ${spentKrw.toLocaleString()}원`
                : spentTokens > 0 && ` · ${spentTokens.toLocaleString()}토큰`}
            </span>
          )}
          <span className="shrink-0 text-[11px] text-slate-400">
            {open ? "닫기 ▾" : "보기 ▴"}
          </span>
        </button>

        {open && activeCount > 0 && (
          // 큐가 서버에 있다는 것을 알려 둔다 — 모르면 예전처럼 창을 붙들고 기다린다.
          <p className="border-t border-slate-200 bg-slate-50 px-3 py-1.5 text-[11px] text-slate-500">
            서버에서 해요. 창을 닫아도 계속되고, 끝나면 문제에 저장돼요.
          </p>
        )}
        {open && (
          <ul className="max-h-80 overflow-auto border-t border-slate-200">
            {CATEGORY_ORDER.map((cat) => {
              const list = jobs.filter((j) => categoryOf(j) === cat);
              const locals = localTasks.filter((t) => (t.task === "detect" || t.task === "crop" ? "haiku" : "luna") === cat);
              const n = list.length + locals.length;
              if (n === 0) return null;
              const running =
                list.filter((j) => j.status === "running" || j.status === "pending").length +
                locals.filter((t) => t.status === "running").length;
              const errs = list.filter((j) => j.status === "error").length + locals.filter((t) => t.status === "error").length;
              const isCollapsed = collapsed.has(cat);
              return (
                <li key={cat} className="border-b border-slate-200 last:border-b-0">
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsed((prev) => {
                        const next = new Set(prev);
                        if (next.has(cat)) next.delete(cat);
                        else next.add(cat);
                        return next;
                      })
                    }
                    className="sticky top-0 z-10 flex w-full items-center gap-2 bg-slate-50 px-3 py-1.5 text-left"
                  >
                    {running > 0 ? (
                      <span className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
                    ) : errs > 0 ? (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
                    ) : (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                    )}
                    <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-[11px] font-semibold text-slate-600">
                      {CATEGORY_MODEL[cat] && <ModelBadge model={CATEGORY_MODEL[cat]!} />}
                      <span className="truncate">{CATEGORY_LABEL[cat]}</span>
                    </span>
                    <span className="shrink-0 text-[10px] text-slate-400">
                      {running > 0 ? `${running}개 진행 · ` : ""}
                      {errs > 0 ? `실패 ${errs} · ` : ""}
                      {n}개 {isCollapsed ? "▸" : "▾"}
                    </span>
                  </button>
                  {!isCollapsed && (
                    <ul>
                      {list.map((j) => (
                  <li
                    key={j.id}
                    className="flex items-start gap-2 border-b border-slate-100 px-3 py-2 last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[11px] font-medium text-slate-700">
                        {j.label}
                      </p>
                      <p
                        className={`text-[11px] ${
                          j.status === "error"
                            ? "text-red-600"
                            : j.status === "done"
                              ? "text-emerald-700"
                              : "text-slate-500"
                        } ${j.status === "running" ? "animate-soft-pulse" : ""}`}
                      >
                        {withModelLogo(statusText(j, topQuality))}
                        {(j.status === "running" || j.status === "pending") && (
                          <span className="text-slate-400"> · 예상 {formatWait(remainingSeconds(j))}</span>
                        )}
                      </p>
                      {j.note && (
                        <p className="mt-0.5 text-[10px] leading-snug text-slate-500">{j.note}</p>
                      )}
                      {/* 어느 문제가 비쌌는지 보이게 한다. 캐시에 걸린 작업에는
                          값이 없다 — 그때는 돈이 안 나갔다. */}
                      {(typeof j.costUsd === "number" ||
                        typeof j.chargedTokens === "number") && (
                        <p className="mt-0.5 text-[10px] text-slate-400">
                          {typeof j.chargedTokens === "number" &&
                            `${j.chargedTokens}토큰`}
                          {typeof j.costUsd === "number" && (
                            <>
                              {typeof j.chargedTokens === "number" && " · "}약 $
                              {j.costUsd.toFixed(3)}
                              {typeof j.costKrw === "number" &&
                                ` (${j.costKrw.toLocaleString()}원)`}
                            </>
                          )}
                        </p>
                      )}
                      {j.error && (
                        <p className="mt-0.5 text-[10px] leading-snug text-slate-400">
                          {j.error}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {j.status === "done" && j.stage === "max-offer" && (
                        <button
                          type="button"
                          disabled={maxBusy}
                          title="무엇이 다른지 보고 진행 여부를 정해요"
                          onClick={() => void openConfirm([j])}
                          className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                        >
                          확인
                        </button>
                      )}
                      {j.status === "done" && j.stage === "max-offer" && (
                        <button
                          type="button"
                          disabled={maxBusy}
                          title="더 고쳐 그리지 않고 지금 그림 그대로 써요"
                          onClick={() => void closeOffers([j])}
                          className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                        >
                          패스
                        </button>
                      )}
                      {/* 짧은 작업은 결과를 기다리던 화면이 이미 실패를 받았다 — 그 화면에서 다시 한다. */}
                      {j.status === "error" && j.mode !== "task" && (
                        <button
                          type="button"
                          onClick={() => retry(j.id)}
                          className="rounded border border-blue-300 bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700 hover:bg-blue-100"
                        >
                          다시
                        </button>
                      )}
                      {(j.status === "done" || j.status === "error") && (
                        <button
                          type="button"
                          onClick={() => dismiss(j.id)}
                          className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-slate-100"
                        >
                          지우기
                        </button>
                      )}
                    </div>
                  </li>
                          ))}
                      {locals.map((t) => (
                        <LocalRow key={t.id} t={t} />
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
            {/* 이 금액은 청구서가 아니라 우리가 역산한 단가로 계산한 값이다.
                화면에서 분명히 해 두지 않으면 청구액으로 오해한다. */}
            {(spentUsd > 0 || spentTokens > 0) && (
              <li className="px-3 py-2 text-[10px] leading-snug text-slate-400">
                {spentUsd > 0 ? (
                  <>
                    합계 약 ${spentUsd.toFixed(2)} ({spentKrw.toLocaleString()}
                    원). 금액은 공표된 토큰 요금으로 계산한 값입니다
                    {krwRate &&
                      ` (원화는 1달러=${krwRate.toLocaleString()}원 기준)`}
                    . 최종 청구액은 OpenAI 대시보드를 보세요.
                  </>
                ) : (
                  <>
                    이번에 {spentTokens.toLocaleString()}토큰이 차감됐습니다. 쓴
                    만큼 정산되므로 문제마다 다를 수 있어요.
                  </>
                )}
              </li>
            )}
          </ul>
        )}

        {activeCount > 0 && (
          <p className="border-t border-slate-100 px-3 py-1.5 text-[10px] leading-snug text-slate-400">
            도는 동안 다음 문제를 계속 넣어도 됩니다. 끝나면 저장된 문제에
            자동으로 반영돼요.
          </p>
        )}
      </div>

      {/* **누르면 바로 걷지 않는다** — 무엇이 다른지 먼저 보여 주고 확인을 받는다. */}
      {confirming && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center"
          onClick={() => !maxBusy && setConfirming(null)}
        >
          <div
            className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-slate-200 px-4 py-3">
              <h3 className="text-sm font-semibold text-slate-900">
                이게 다릅니다 — 어떻게 할까요?
              </h3>
              <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
                지금 저장된 그림은 원본과 아래가 달라요.
                {confirming.length === 1
                  ? " 저장된 그림에서 일부만 고치거나, 화질을 올려 처음부터 다시 그리거나, 그대로 쓸(패스) 수 있어요."
                  : " 고른 것은 화질을 올려 이 부분을 고치도록 다시 그리고(더 나은 쪽을 저장), 패스한 것은 지금 그림 그대로 써요."}
              </p>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-4 py-2">
              {details === null ? (
                <p className="py-4 text-center text-xs text-slate-400">불러오는 중…</p>
              ) : (
                confirming.map((j) => {
                  const d = details[j.id];
                  return (
                    <div key={j.id} className="border-b border-slate-100 py-2 last:border-b-0">
                      <div className="flex items-center gap-2">
                        {confirming.length > 1 && (
                          <input
                            type="checkbox"
                            aria-label={`${j.label} 진행`}
                            checked={picked.has(j.id)}
                            disabled={maxBusy}
                            onChange={(e) =>
                              setPicked((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(j.id);
                                else next.delete(j.id);
                                return next;
                              })
                            }
                            className="h-4 w-4 shrink-0"
                          />
                        )}
                        <p className="min-w-0 flex-1 truncate text-xs font-medium text-slate-800">
                          {j.label}
                          {d && <span className="ml-1 font-normal text-slate-400">· 차이 {d.diffs.length}곳</span>}
                          {d && (
                            <span className="ml-1 font-normal text-amber-700">
                              · 다음 {targetOf(j).quality} ({tokenText(targetOf(j).tokens)})
                            </span>
                          )}
                        </p>
                        {confirming.length > 1 && (
                          <button
                            type="button"
                            disabled={maxBusy}
                            onClick={() => void passOffers([j])}
                            title="더 고쳐 그리지 않고 지금 그림 그대로 써요"
                            className="shrink-0 rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                          >
                            패스
                          </button>
                        )}
                        {confirming.length > 1 && (
                          <button
                            type="button"
                            disabled={maxBusy}
                            onClick={() => void openConfirm([j])}
                            title="이 문제만 열어서 수정하거나 다시 그려요"
                            className="shrink-0 rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                          >
                            이것만 (수정 가능)
                          </button>
                        )}
                      </div>
                      {d && (d.originalUrl || d.generatedUrl) && (
                        // 원본과 지금 저장된 생성 그림을 **나란히** — 차이를 눈으로 대 볼 수 있게. 누르면 크게 열린다.
                        <div className="mt-1.5 grid grid-cols-2 gap-2">
                          {(
                            [
                              ["원본", d.originalUrl],
                              [`생성${d.quality ? ` (${d.quality})` : ""}`, d.generatedUrl],
                            ] as const
                          ).map(([cap, url]) => (
                            <figure key={cap} className="min-w-0">
                              <figcaption className="mb-0.5 text-[10px] font-medium text-slate-500">{cap}</figcaption>
                              {url ? (
                                <a href={url} target="_blank" rel="noreferrer" title="누르면 크게 열려요">
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    src={url}
                                    alt={cap}
                                    className="max-h-64 w-full rounded border border-slate-200 bg-white object-contain"
                                  />
                                </a>
                              ) : (
                                <p className="rounded border border-dashed border-slate-200 px-2 py-6 text-center text-[10px] text-slate-400">
                                  그림을 불러오지 못했어요
                                </p>
                              )}
                            </figure>
                          ))}
                        </div>
                      )}
                      {!d || d.diffs.length === 0 ? (
                        <p className="mt-0.5 text-[11px] text-slate-400">
                          {d ? "차이 목록이 남아 있지 않아요." : "차이 목록을 불러오지 못했어요."}
                        </p>
                      ) : (
                        <ul className="mt-1 flex flex-col gap-1">
                          {d.diffs.map((x, i) => (
                            <li key={i} className="text-[11px] leading-snug text-slate-700">
                              <span className={`mr-1 rounded px-1 py-px text-[10px] ${KIND_STYLE[x.kind ?? "text"]}`}>
                                {KIND_LABEL[x.kind ?? "text"]}
                              </span>
                              {x.where && <span className="text-slate-400">[{x.where}] </span>}
                              {x.kind === "handwriting" ? (
                                <>
                                  손글씨가 남았어요: <b>{x.recreated || "(필기)"}</b>
                                  {x.original && x.original !== "빈 자리" && (
                                    <> → 그 밑의 인쇄 &quot;{x.original}&quot; 이 보여야 해요</>
                                  )}
                                </>
                              ) : (
                                <>
                                  원본 <b>&quot;{x.original}&quot;</b> → 그림 <b>{x.recreated ? `"${x.recreated}"` : "(빠짐)"}</b>
                                </>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })
              )}
            </div>
            {confirming.length === 1 && (
              <div className="border-t border-slate-200 px-4 py-2">
                <div className="grid grid-cols-2 gap-1.5">
                  {(
                    [
                      ["patch", "수정 (일부만)", `${patchTokens.toLocaleString()}토큰 · 화질 지정 없음`],
                      ["redraw", `${targetOf(confirming[0]).quality} 로 다시 그리기`, `${tokenText(targetOf(confirming[0]).tokens)} · 처음부터`],
                    ] as const
                  ).map(([k, title, sub]) => (
                    <button
                      key={k}
                      type="button"
                      disabled={maxBusy}
                      onClick={() => setChoice(k)}
                      className={`rounded-lg border px-2 py-1.5 text-left ${
                        choice === k ? "border-amber-500 bg-amber-50" : "border-slate-200 hover:bg-slate-50"
                      }`}
                    >
                      <span className="block text-xs font-medium text-slate-800">{title}</span>
                      <span className="block text-[10px] text-slate-500">{sub}</span>
                    </button>
                  ))}
                </div>
                {choice === "patch" && patchMode === "chat" && (
                  <div className="mt-2">
                    <p className="mb-1 text-[11px] text-slate-500">
                      지금 저장된 그림을 <b>다시 그리지 않고</b> 고쳐요. sol 과 대화로 고칠 곳을 정하고 <b>확정</b>하면 그대로 그림 모델에 가요. 마음에 안 들면 또
                      수정할 수 있어요.
                    </p>
                    <SolChat
                      goal="patch"
                      jobId={confirming[0].serverId}
                      confirmLabel="이 내용으로 확정"
                      busy={maxBusy}
                      onConfirm={(plan) => void runPatch(confirming[0], { text: plan.text, understood: plan.understood })}
                    />
                    <button
                      type="button"
                      disabled={maxBusy}
                      onClick={() => setPatchMode("text")}
                      className="mt-1 text-[11px] text-slate-500 underline hover:text-slate-700"
                    >
                      대화 없이 글로만 적어 바로 고치기
                    </button>
                  </div>
                )}
                {choice === "patch" && patchMode === "text" && (
                  <div className="mt-2">
                    <p className="mb-1 text-[11px] text-slate-500">
                      지금 저장된 그림을 <b>다시 그리지 않고</b> 적은 곳만 고쳐요(sol 도움 없이 적은 글 그대로).
                    </p>
                    <textarea
                      value={patchText}
                      onChange={(e) => setPatchText(e.target.value.slice(0, 1000))}
                      rows={3}
                      placeholder="고칠 곳을 적어 주세요. 예) 3번 선지의 ㉡ 을 ㉢ 으로 · 지도 A 옆 손글씨 지우기"
                      className="w-full resize-none rounded border border-slate-300 px-2 py-1.5 text-xs text-slate-800 placeholder:text-slate-400 focus:border-amber-500 focus:outline-none"
                    />
                    <label className="mt-1 flex items-start gap-1.5 text-[11px] text-slate-600">
                      <input
                        type="checkbox"
                        checked={patchDiffs}
                        onChange={(e) => setPatchDiffs(e.target.checked)}
                        className="mt-0.5"
                      />
                      <span>위에 나온 차이도 함께 고치기</span>
                    </label>
                    <button
                      type="button"
                      disabled={maxBusy}
                      onClick={() => setPatchMode("chat")}
                      className="mt-1 text-[11px] text-slate-500 underline hover:text-slate-700"
                    >
                      sol 과 대화로 정하기
                    </button>
                  </div>
                )}
              </div>
            )}
            {maxError && <p className="border-t border-red-100 bg-red-50 px-4 py-1.5 text-[11px] text-red-700">{maxError}</p>}
            {confirming.length > 1 && (
              <div className="flex items-center gap-2 border-t border-slate-200 px-4 py-1.5 text-[11px] text-slate-500">
                <button
                  type="button"
                  disabled={maxBusy}
                  onClick={() => setPicked(new Set(confirming.map((j) => j.id)))}
                  className="underline hover:text-slate-700"
                >
                  전체 선택
                </button>
                <button
                  type="button"
                  disabled={maxBusy}
                  onClick={() => setPicked(new Set())}
                  className="underline hover:text-slate-700"
                >
                  전체 해제
                </button>
                <span className="text-slate-400">고른 것을 진행하거나 패스해요. 안 고른 것은 확인 대기로 남아요.</span>
              </div>
            )}
            <div className="flex items-center justify-between gap-2 border-t border-slate-200 px-4 py-3">
              <span className="text-[11px] text-slate-500">
                {confirming.length === 1 && choice === "patch"
                  ? `${patchTokens.toLocaleString()}토큰${patchMode === "chat" ? " · 대화는 쓴 만큼 따로" : ""}`
                  : confirming.length > 1
                    ? `${picked.size}개 선택 · 진행하면 ${tokenText(confirming.filter((j) => picked.has(j.id)).reduce((a, j) => a + targetOf(j).tokens, 0))}`
                    : tokenText(targetOf(confirming[0]).tokens)}
              </span>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  disabled={maxBusy}
                  onClick={() => setConfirming(null)}
                  className="rounded border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                >
                  취소
                </button>
                <button
                  type="button"
                  disabled={maxBusy || (confirming.length > 1 && picked.size === 0)}
                  onClick={() =>
                    void passOffers(confirming.length === 1 ? confirming : confirming.filter((j) => picked.has(j.id)))
                  }
                  title="더 고쳐 그리지 않고 지금 저장된 그림 그대로 써요"
                  className="rounded border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                >
                  {confirming.length === 1 ? "패스 (그대로 쓰기)" : "선택한 것 패스"}
                </button>
                <button
                  type="button"
                  disabled={
                    maxBusy ||
                    details === null ||
                    (confirming.length === 1 && choice === "patch" && patchMode === "chat") ||
                    (confirming.length === 1 && choice === "patch" && patchMode === "text" && !patchText.trim() && !patchDiffs) ||
                    (confirming.length > 1 && picked.size === 0)
                  }
                  onClick={() =>
                    confirming.length === 1 && choice === "patch" ? void runPatch(confirming[0]) : void runMax(confirming.filter((j) => picked.has(j.id)))
                  }
                  className="rounded bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  {maxBusy ? "처리 중…" : confirming.length > 1 ? "선택한 것 진행" : "진행"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 곧바로 부른 luna 일 한 줄(대기열을 안 탔다 — 다시 하기는 그 화면에서). */
function LocalRow({ t }: { t: LocalTask }) {
  const secs = Math.round(((t.finishedAt ?? Date.now()) - t.startedAt) / 1000);
  return (
    <li className="flex items-start gap-2 border-b border-slate-100 px-3 py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] font-medium text-slate-700">{t.label}</p>
        <p
          className={`text-[11px] ${
            t.status === "error" ? "text-red-600" : t.status === "done" ? "text-emerald-700" : "text-slate-500 animate-soft-pulse"
          }`}
        >
          {t.status === "running"
            ? withModelLogo(LOCAL_RUNNING[t.task] ?? "luna 가 처리하는 중")
            : t.status === "done"
              ? `완료 · ${secs}초${typeof t.chargedTokens === "number" ? ` · ${t.chargedTokens}토큰` : ""}`
              : "실패"}
        </p>
        {t.note && <p className="mt-0.5 text-[10px] leading-snug text-slate-500">{t.note}</p>}
        {t.error && <p className="mt-0.5 text-[10px] leading-snug text-slate-400">{t.error}</p>}
      </div>
      {t.status !== "running" && (
        <button
          type="button"
          onClick={() => dismissLocalTask(t.id)}
          className="shrink-0 rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-slate-100"
        >
          지우기
        </button>
      )}
    </li>
  );
}
