// 문제 통째로 다시 그리기의 **그리기 → sol 검수 → 고쳐 그리기 반복**(2026-09-30). **서버 전용.**
//
// 예전에는 sunburst 를 한 번 불러 나온 그림을 그대로 저장했다. 글자·도형이 틀려도 알 방법이
// 없었다. 비교 화면(`/admin/compare-problem`)에서 시험한 흐름을 운영으로 옮긴 것이다:
//
//   gen:0    low 로 그린다
//   verify:0 sol 이 원본과 대조한다(글자 · 깨진 글자 · 도형 · 남은 손글씨). 차이가 0곳이면 끝.
//   gen:1    차이 목록을 지시로 붙여 medium 으로 다시 그린다(입력은 늘 **원본**)
//   verify:1 …
//   (medium 검수에서도 차이가 남으면 여기서 **멈춘다** — 가장 나은 그림을 먼저 저장하고 작업을
//    `max-offer` 로 남긴다. max 는 사용자가 패널에서 확인하면 200토큰을 걷고 이어서 돈다.)
//   gen:2    맨 위 quality(기본 high, `TOP_QUALITY`)로 마지막으로 그린다(확인 뒤에만) → verify:2 → 끝
//
// 끝나면 **남은 차이가 가장 적은 그림**을 저장한다(같으면 앞의 것 — quality 가 낮아 더 싸다).
//
// **단계마다 일꾼 한 번씩** 돈다(`passageRun.ts` 와 같은 방식). max 로 그리는 데만도 몇 분
// 걸릴 수 있어 한 번에 다 하면 300초 한도를 넘는다. 단계가 끝나면 `pending` 으로 되돌려
// 다음 일꾼이 이어서 집는다. 중간 그림은 `<uid>/_jobs/<jobId>-r<i>.jpg` 에 둔다.
//
// **일이 어긋나도 이미 그린 그림이 있으면 버리지 않는다.** 첫 그림(gen:0)이 안 나오면 실패로
// 돌려 보증금을 돌려주지만, 그 뒤 단계의 실패(검수가 안 됨·다시 그리기가 시간 초과)는 지금까지
// 나온 것 중 가장 나은 그림으로 끝낸다 — 이미 돈이 나간 그림을 버릴 이유가 없다.
//
// 과금은 그대로다 — 넣을 때 고정 보증금(`FIGURE_TOKEN_DEPOSIT`)을 걸고 그것이 최종 차감액이다.
// 반복이 늘면 원가는 늘지만 사용자에게 받는 값은 안 바뀐다(차이가 없으면 low 한 번으로 끝나
// 오히려 싸다). 원가는 `usage` 에 합쳐 무제한·BYOK 계정 화면에 보인다.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FigureUsage } from "./figureImageGen";
import { loadAsDataUrl, removeStored, runFigureGeneration, splitDataUrl, storeBytes } from "./figureRun";
import {
  GradeError,
  OPENAI_TEXT_MODEL,
  deleteVisionResponse,
  pollVisionBackground,
  startVisionBackground,
  type GradeUsage,
} from "./gradeExam";
import {
  accumulatedCorrection,
  correctionInstruction,
  parsePatchPlan,
  parseVerify,
  patchPlanPrompt,
  planToChanges,
  VERIFY_PROMPT,
  type RoundDiffs,
  type TextDiff,
} from "./problemCompare";
import { gradingEstKrw } from "./tokens";
import { imageTokens, logAiCost, solTokens } from "./costLog";

/**
 * 맨 위 단계(사용자 확인 뒤에만 돈다)의 quality. **기본은 high 다** — max 는 문제 한 장에 그림 출력이
 * 7,000토큰 남짓(운영 로그 2026-09-30: 318원)이라 low(29원)·medium(41원)의 8~11배였다(사용자 —
 * "max 의 비용이 너무 과도해"). 되돌리려면 재배포 없이 `PROBLEM_MAX_QUALITY=max`.
 */
export const TOP_QUALITY = (() => {
  const v = (process.env.PROBLEM_MAX_QUALITY ?? "high").trim().toLowerCase();
  return ["medium", "high", "xhigh", "max"].includes(v) ? v : "high";
})();

/** 그리는 차례(고정 앞 둘 + 확인 뒤 맨 위). 앞에서 차이가 없어지면 거기서 멈춘다. */
export const PROBLEM_LADDER = ["low", "medium", TOP_QUALITY] as const;

/**
 * 수정 창에서 "sol 쓰기"를 골라 다시 그릴 때의 사다리 — **low 없이 medium → high**(사용자 — "수정 프로세스 중에서는
 * med → high 로, low 부터 해서 올리지 말고"). 확인 대기(max-offer) 없이 high 까지 자동으로 간다(이미 사용자가 고른 길이다).
 */
export const EDIT_LADDER = ["medium", TOP_QUALITY] as const;

function ladderOf(job: { edit?: boolean }): readonly string[] {
  return job.edit ? EDIT_LADDER : PROBLEM_LADDER;
}

/** sol 검수의 추론 강도. 재배포 없이 `OPENAI_VERIFY_EFFORT` 로 바꾼다(`default` 면 안 보낸다). */
const VERIFY_EFFORT = (() => {
  const v = (process.env.OPENAI_VERIFY_EFFORT ?? "high").trim();
  return v === "" || v === "default" ? undefined : v;
})();

/** 이 흐름을 끄는 스위치(`PROBLEM_LOOP=off`). 끄면 예전처럼 한 번 그리고 끝난다. */
export function problemLoopEnabled(): boolean {
  return (process.env.PROBLEM_LOOP ?? "on").trim().toLowerCase() !== "off";
}

/**
 * 프롬프트에서 원문자 그리는 법을 뺄지. **원문자는 sol 이 지킨다**(사용자 — "원문자 주의를
 * 선버스트에게 보내던 걸 sol 에게"). 비교 화면에서 시험한 흐름과 같다. 되돌리려면
 * `PROBLEM_LOOP_SKIP_CIRCLED=0`.
 */
const SKIP_CIRCLED = (process.env.PROBLEM_LOOP_SKIP_CIRCLED ?? "1").trim() !== "0";

type Round = {
  quality: string;
  /** 이 라운드 그림이 놓인 스토리지 경로. */
  path: string;
  /** 검수로 센 남은 차이. 아직 검수 전이면 없다. */
  diffs?: number;
};

export type ProblemLoopState = {
  rounds: Round[];
  /** 다음 그리기에 붙일 지시(앞선 **모든** 시도가 틀린 곳을 모은 것). */
  instruction?: string;
  /**
   * 사용자가 **수정**을 골랐다(`max-offer` 에서 넘어온 것) — 다시 그리지 않고 지금 저장된 그림을 입력으로 넣어
   * 적어 준 곳만 고친다(quality 미지정, sol 검수 없음). 실패하면 환불하고 offer 로 돌아간다.
   */
  patchPhase?: boolean;
  patch?: {
    instruction: string;
    includeDiffs: boolean;
    /** 사용자가 골랐다 — sol 이 위치까지 자세히 비교해 그림 모델에 **강하게** 지시하고, 고친 뒤 다시 검수한다. 안 골랐으면 글 그대로. */
    useSol?: boolean;
    /** sol 이 사용자 요청을 구체적인 편집 지시로 풀어 쓴 것(`patch-plan` 단계가 채운다). 못 풀었으면 없다. */
    plan?: string;
    /** 사용자에게 보여 줄 "이렇게 이해했어요". */
    understood?: string;
  };
  /**
   * 지금 문제에 **저장돼 있는 그림**이 어느 라운드인가. 없으면 남은 차이가 가장 적은 라운드다. 수정(patch)을 하면 그
   * 결과가 (차이가 더 많더라도) 사용자가 고른 그림이므로 이 값이 그 라운드를 가리킨다 — 다음 수정은 이 그림에서 이어 간다.
   */
  current?: number;
  /** 사용자가 max 다시 그리기를 확인해 돌고 있다(`max-offer` 에서 넘어온 것). 실패하면 환불하고 offer 로 돌아간다. */
  maxPhase?: boolean;
  /** 라운드마다 검수가 찾은 차이 목록. 다음 그리기의 지시를 만드는 재료(그림은 폐기하고 실수만 넘긴다). */
  history?: RoundDiffs[];
  /** 지금까지 그림 호출의 사용량 합. */
  usage?: FigureUsage;
  /** sol 검수 원가 합(원). */
  solKrw?: number;
};

export type ProblemLoopJob = {
  id: string;
  /** 그림 하나(figure)를 이 흐름으로 그릴 때도 있다(수정 창의 "sol 쓰기"). 없으면 문제 통째로. */
  mode?: "figure" | "problem" | "passage";
  /** 수정 창에서 sol 쓰기를 골랐다 — 사다리가 medium → high 다(low 없음, 확인 대기 없음). */
  edit?: boolean;
  user_id: string;
  korean: boolean;
  instruction: string | null;
  input_path: string;
  width: number | null;
  height: number | null;
  stage: string | null;
  state: ProblemLoopState | null;
};

export type ProblemLoopOutcome =
  | { kind: "next"; stage: string; state: ProblemLoopState; note: string }
  | {
      kind: "done";
      /** 저장할 그림. */
      dataUrl: string;
      modelId: string;
      usage?: FigureUsage;
      note: string;
      /** 지울 중간 파일. */
      cleanup: string[];
      /** 그린 라운드 수. */
      rounds: number;
      /** 맨 위 단계(확인 뒤에만 도는 것)의 그림이 실제로 나왔는가 — 안 나왔으면 걷은 토큰을 돌려준다. */
      maxDrawn: boolean;
      /**
       * 차이가 남았지만 max 는 **사용자 확인 뒤에** 돌린다 — 이 상태를 작업에 그대로 남기고(입력·중간 그림
       * 유지) 일꾼은 여기서 멈춘다.
       */
      offer?: ProblemLoopState;
    }
  | { kind: "fail"; error: string; cleanup: string[] };

export type Ctx = {
  byokApiKey?: string;
  modelIds: string[];
  /** 이 단계에 쓸 시간(ms). */
  deadlineMs: number;
  tag: string;
};

function addUsage(a: FigureUsage | undefined, b: FigureUsage | undefined): FigureUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    inputText: a.inputText + b.inputText,
    inputImage: a.inputImage + b.inputImage,
    output: a.output + b.output,
    cached: a.cached + b.cached,
    estUsd: a.estUsd + b.estUsd,
    estKrw: a.estKrw + b.estKrw,
    krwRate: b.krwRate || a.krwRate,
  };
}

/** 사용자가 적은 지시와 검수가 찾은 차이를 한 지시로 합친다. */
function joinInstructions(user: string | null, fix: string | undefined): string | undefined {
  const parts = [user?.trim(), fix?.trim()].filter((x): x is string => !!x);
  return parts.length ? parts.join("\n\n") : undefined;
}

function pathsOf(state: ProblemLoopState | null | undefined): string[] {
  return (state?.rounds ?? []).map((r) => r.path);
}

/**
 * 이 작업이 남긴 **중간 그림** 경로들. 작업이 도중에 사라질 때(사용자가 치웠거나, 멈춘 작업 정리가
 * 오류로 돌렸거나) 부르는 쪽이 지운다 — 안 지우면 아무도 안 가리키는 파일이 쌓인다.
 */
export function problemLoopPaths(state: unknown): string[] {
  const rounds = (state as { rounds?: unknown } | null)?.rounds;
  if (!Array.isArray(rounds)) return [];
  return rounds
    .map((r) => (r as { path?: unknown } | null)?.path)
    .filter((p): p is string => typeof p === "string" && p.length > 0);
}

/** 이미 그림을 그려(=돈이 나가) 본 작업인가. */
export function problemLoopStarted(state: unknown): boolean {
  return problemLoopPaths(state).length > 0;
}

/**
 * max(맨 위 단계) 확인 대기 중인 작업에 **지금 저장된 그림에 남은 차이**들 — 확인 창이 "이게 다릅니다"로 보여 준다.
 * 저장된 그림은 남은 차이가 가장 적은 라운드(`bestRound`)이고, 그 라운드의 차이 목록은 `history` 에 있다.
 */
export function remainingDiffs(state: unknown): { quality: string; diffs: TextDiff[]; path: string } | null {
  const st = state as ProblemLoopState | null;
  if (!st || !Array.isArray(st.rounds) || st.rounds.length === 0) return null;
  const best = st.rounds[st.current !== undefined && st.rounds[st.current] ? st.current : bestRound(st.rounds)];
  if (!best) return null;
  const hit = (st.history ?? []).find((h) => h.quality === best.quality);
  return hit ? { quality: hit.quality, diffs: hit.diffs, path: best.path } : null;
}

/** 남은 차이가 가장 적은 라운드(같으면 앞). 검수 못 한 라운드는 뒤로 미룬다. */
function bestRound(rounds: Round[]): number {
  let best = -1;
  for (let i = 0; i < rounds.length; i++) {
    const d = rounds[i].diffs;
    if (d === undefined) continue;
    if (best === -1 || d < (rounds[best].diffs ?? Infinity)) best = i;
  }
  return best === -1 ? rounds.length - 1 : best;
}

/** 단계 이름 `gen:2` → 2. */
function indexOf(stage: string | null, kind: "gen" | "verify"): number | null {
  const m = new RegExp(`^${kind}:(\\d+)$`).exec(stage ?? "");
  return m ? Number(m[1]) : null;
}

/** 지금까지의 라운드로 끝낸다. 그림이 하나도 없으면 실패다. */
async function finalize(
  admin: SupabaseClient,
  state: ProblemLoopState,
  pick: number,
  ctx: Ctx,
  why: string,
): Promise<ProblemLoopOutcome> {
  const cleanup = pathsOf(state);
  const round = state.rounds[pick];
  if (!round) return { kind: "fail", error: "그려진 그림이 없어요. 다시 시도해주세요.", cleanup };
  const dataUrl = await loadAsDataUrl(admin, round.path);
  if (!dataUrl) {
    // 방금 올린 중간 그림을 못 읽었다 — 다른 라운드로 한 번 더 시도한다.
    for (let i = state.rounds.length - 1; i >= 0; i--) {
      if (i === pick) continue;
      const alt = await loadAsDataUrl(admin, state.rounds[i].path);
      if (alt) {
        return {
          kind: "done",
          dataUrl: alt,
          modelId: ctx.modelIds[0] ?? "",
          usage: withSol(state),
          note: `${why} (그림 ${i + 1} 사용)`,
          cleanup,
          rounds: state.rounds.length,
          maxDrawn: maxRoundDrawn(state),
        };
      }
    }
    return { kind: "fail", error: "완성된 그림을 읽지 못했어요. 다시 시도해주세요.", cleanup };
  }
  const diffs = round.diffs;
  const summary =
    diffs === undefined
      ? "검수 없이 저장"
      : diffs === 0
        ? "글자·도형 차이 없음"
        : `남은 차이 ${diffs}곳`;
  return {
    kind: "done",
    dataUrl,
    modelId: ctx.modelIds[0] ?? "",
    usage: withSol(state),
    note: `${round.quality} 그림 저장 · ${summary}${why ? ` · ${why}` : ""}`,
    cleanup,
    rounds: state.rounds.length,
    maxDrawn: maxRoundDrawn(state),
  };
}

/**
 * 맨 위 단계 그림이 나왔는가. 그 자리(사다리 마지막 칸)에 **수정 라운드(`patch<k>`)가 아닌** 그림이 있어야 한다 — 수정이 쌓이면
 * 라운드 수만으로는 가릴 수 없다.
 */
export function maxRoundDrawn(state: unknown): boolean {
  const rounds = (state as ProblemLoopState | null)?.rounds;
  const r = Array.isArray(rounds) ? rounds[PROBLEM_LADDER.length - 1] : undefined;
  return !!r && !String(r.quality).startsWith("patch");
}

/** 그림 사용량에 sol 검수 원가를 더해 화면에 보이는 합계로 만든다. */
function withSol(state: ProblemLoopState): FigureUsage | undefined {
  const u = state.usage;
  if (!u) return undefined;
  const sol = state.solKrw ?? 0;
  if (sol <= 0) return u;
  return {
    ...u,
    estKrw: u.estKrw + sol,
    estUsd: u.estUsd + (u.krwRate > 0 ? sol / u.krwRate : 0),
  };
}

/** 이 작업의 **한 단계**를 돌린다. */
export async function runProblemStage(
  admin: SupabaseClient,
  job: ProblemLoopJob,
  ctx: Ctx,
): Promise<ProblemLoopOutcome> {
  const state: ProblemLoopState = job.state ?? { rounds: [] };
  const stage = job.stage ?? "gen:0";

  const genIdx = indexOf(stage, "gen");
  if (genIdx !== null) return runGen(admin, job, state, genIdx, ctx);

  if (stage === "patch-plan") return runPatchPlan(admin, job, state, ctx);
  if (stage === "patch") return runPatch(admin, job, state, ctx);

  const verIdx = indexOf(stage, "verify");
  if (verIdx !== null) return runVerify(admin, job, state, verIdx, ctx);

  // 모르는 단계(옛 데이터)면 처음부터.
  return runGen(admin, job, { rounds: [] }, 0, ctx);
}

/** 수정의 바탕이 되는 그림 = 지금 저장돼 있는 라운드(`state.current`, 없으면 남은 차이가 가장 적은 것). */
function baseIndex(state: ProblemLoopState): number {
  return state.current !== undefined && state.rounds[state.current] ? state.current : bestRound(state.rounds);
}

/** 수정 대화용 그림 둘 — 원본과 지금 저장된 그림. 없으면 null. */
export async function loadPatchImages(
  admin: SupabaseClient,
  row: { input_path: string; state: unknown },
): Promise<{ original: string; current: string; findings: string } | null> {
  const state = row.state as ProblemLoopState | null;
  if (!state || !Array.isArray(state.rounds) || state.rounds.length === 0) return null;
  const base = state.rounds[baseIndex(state)];
  const [original, current] = await Promise.all([
    loadAsDataUrl(admin, row.input_path),
    base ? loadAsDataUrl(admin, base.path) : Promise.resolve(null),
  ]);
  if (!original || !current) return null;
  const rem = remainingDiffs(state);
  return { original, current, findings: rem && rem.diffs.length > 0 ? correctionInstruction(rem.diffs) : "" };
}

/** 사용자 글과(원하면) sol 이 찾은 남은 차이를 한 덩어리로. */
function patchRequestText(state: ProblemLoopState): { user: string; findings: string } {
  const user = state.patch?.instruction?.trim() ?? "";
  let findings = "";
  if (state.patch?.includeDiffs) {
    const rem = remainingDiffs(state);
    if (rem && rem.diffs.length > 0) findings = correctionInstruction(rem.diffs);
  }
  return { user, findings };
}

/**
 * **수정 1단계 — sol 이 요청을 해석한다.** 그림 편집 모델은 "B 지점을 조금 오른쪽으로" 같은 말을 못 알아듣는다(사용자 —
 * "지점 위치 같은 거 내가 계속 얘기해도 못 알아듣는데"). sol 이 원본과 지금 그림을 둘 다 보고 **어디를 어떻게**를 기준물·퍼센트
 * 좌표로 못박은 편집 지시로 풀어 쓴다. 풀어 쓰지 못하면 사용자가 쓴 글 그대로 다음 단계로 간다(수정이 막히면 안 된다).
 */
async function runPatchPlan(
  admin: SupabaseClient,
  job: ProblemLoopJob,
  state: ProblemLoopState,
  ctx: Ctx,
): Promise<ProblemLoopOutcome> {
  const baseIdx = baseIndex(state);
  const base = state.rounds[baseIdx];
  const [original, current] = await Promise.all([
    loadAsDataUrl(admin, job.input_path),
    base ? loadAsDataUrl(admin, base.path) : Promise.resolve(null),
  ]);
  if (!original || !current) return { kind: "fail", error: "고칠 그림을 찾지 못했어요.", cleanup: [] };

  const { user, findings } = patchRequestText(state);
  if (!user && !findings) return { kind: "fail", error: "고칠 내용이 없어요.", cleanup: [] };

  const ask = await askSol(patchPlanPrompt(user, findings), [original, current], ctx, "수정 해석", {
    cacheKey: "reprint-patch-plan",
  });
  if (ask.krw > 0 && !ctx.byokApiKey) {
    await logAiCost(admin, { userId: job.user_id, jobId: job.id, kind: job.mode === "figure" ? "figure" : "problem", what: "sol 수정 해석", krw: ask.krw, tokens: solTokens(ask.usage) });
  }
  let plan: string | undefined;
  let understood: string | undefined;
  let note = "sol 이 요청을 해석하지 못해 적어 주신 글 그대로 그려요";
  if (ask.text !== null) {
    try {
      const parsed = parsePatchPlan(ask.text);
      plan = planToChanges(parsed);
      understood = parsed.understood || undefined;
      note = `sol 이 이렇게 이해했어요: ${parsed.understood || `${parsed.edits.length}곳 수정`}`;
    } catch (err) {
      console.warn(`[${ctx.tag}] 수정 해석 결과를 못 읽음: ${err instanceof Error ? err.message : err}`);
    }
  } else {
    console.warn(`[${ctx.tag}] 수정 해석 실패, 사용자 글 그대로 진행: ${ask.fail.slice(0, 200)}`);
  }
  return {
    kind: "next",
    stage: "patch",
    state: {
      ...state,
      solKrw: (state.solKrw ?? 0) + ask.krw,
      patch: { instruction: user, includeDiffs: state.patch?.includeDiffs ?? false, useSol: true, plan, understood },
    },
    note,
  };
}

/**
 * **수정 2단계 — 그리고 검수한다.** 지금 저장된 그림을 입력으로 넣고 sol 이 풀어 쓴 지시대로 그 곳만 고친다(quality 는 안 보낸다,
 * 미지정). 그린 뒤 sol 이 원본과 다시 견줘 **남은 차이**를 새로 찾는다 — 사용자가 결과를 보고 또 고칠 수 있게 작업은 확인 대기
 * (`max-offer`)로 돌아가고, 바탕 그림은 방금 고친 것이 된다(`current`). 검수가 안 돼도 고친 그림은 저장한다.
 */
async function runPatch(
  admin: SupabaseClient,
  job: ProblemLoopJob,
  state: ProblemLoopState,
  ctx: Ctx,
): Promise<ProblemLoopOutcome> {
  const baseIdx = baseIndex(state);
  const base = state.rounds[baseIdx];
  const image = base ? await loadAsDataUrl(admin, base.path) : null;
  if (!image) return { kind: "fail", error: "고칠 그림을 찾지 못했어요.", cleanup: [] };

  // sol 이 풀어 쓴 지시가 있으면 그걸, 없으면 사용자 글(+ 남은 차이)을 그대로.
  const { user, findings } = patchRequestText(state);
  const changes =
    state.patch?.plan ??
    [user && `user's requested fixes (Korean):\n${user}`, findings].filter(Boolean).join("\n\n");
  if (!changes) return { kind: "fail", error: "고칠 내용이 없어요.", cleanup: [] };

  const out = await runFigureGeneration({
    image,
    mode: "problem",
    korean: job.korean,
    inputSize: job.width && job.height ? { width: job.width, height: job.height } : undefined,
    modelIds: ctx.modelIds,
    byokApiKey: ctx.byokApiKey,
    deadlineMs: ctx.deadlineMs,
    tag: `${ctx.tag} 수정`,
    patchNote: changes,
    patchStrong: !!state.patch?.plan,
  });
  if (!out.ok) return { kind: "fail", error: out.error, cleanup: [] };

  if (out.usage && !ctx.byokApiKey) {
    await logAiCost(admin, {
      userId: job.user_id,
      jobId: job.id,
      kind: job.mode === "figure" ? "figure" : "problem",
      what: "그림 수정(quality 미지정)",
      krw: out.usage.estKrw,
      usd: out.usage.estUsd,
      tokens: imageTokens(out.usage),
    });
  }
  const usage = addUsage(state.usage, out.usage);

  // 고친 그림을 새 라운드로 남긴다. 파일 이름은 `-p<k>` — 다시 그리기 라운드(`-r<i>`)와 겹치지 않는다.
  const k = state.rounds.filter((r) => r.quality.startsWith("patch")).length + 1;
  const quality = `patch${k}`;
  const parts = splitDataUrl(out.dataUrl);
  const path = parts ? `${job.user_id}/_jobs/${job.id}-p${k}.${parts.ext}` : "";
  const stored = parts ? await storeBytes(admin, path, parts.bytes, parts.mime) : false;
  if (!parts || !stored) return { kind: "fail", error: "고친 그림을 저장하지 못했어요.", cleanup: [] };

  // 같은 시간 안에서 sol 이 원본과 다시 견줘 남은 차이를 새로 찾는다(실패해도 고친 그림은 그대로 둔다).
  let diffs: TextDiff[] | null = null;
  let solKrw = 0;
  // sol 을 고른 경우에만 다시 검수한다(안 골랐으면 sol 을 안 부른다).
  const original = state.patch?.useSol ? await loadAsDataUrl(admin, job.input_path) : null;
  if (original) {
    const ask = await askSol(VERIFY_PROMPT, [original, out.dataUrl], ctx, "검수", { cacheKey: VERIFY_CACHE_KEY });
    solKrw = ask.krw;
    if (ask.text !== null) {
      try {
        diffs = parseVerify(ask.text);
      } catch {
        diffs = null;
      }
    }
    if (solKrw > 0 && !ctx.byokApiKey) {
      await logAiCost(admin, { userId: job.user_id, jobId: job.id, kind: job.mode === "figure" ? "figure" : "problem", what: "sol 검수", krw: solKrw, tokens: solTokens(ask.usage) });
    }
  }

  const rounds = [...state.rounds, { quality, path, ...(diffs ? { diffs: diffs.length } : {}) }];
  const history: RoundDiffs[] = diffs
    ? [...(state.history ?? []).filter((h) => h.quality !== quality), { quality, diffs: diffs.slice(0, 20) }]
    : (state.history ?? []);
  const next: ProblemLoopState = {
    ...state,
    rounds,
    history,
    current: rounds.length - 1,
    usage,
    solKrw: (state.solKrw ?? 0) + solKrw,
    patchPhase: false,
    patch: undefined,
    instruction: history.length ? accumulatedCorrection(history) : state.instruction,
  };
  const summary = !state.patch?.useSol ? "sol 검수 없이 저장" : diffs === null ? "검수는 못 했어요" : diffs.length === 0 ? "글자·도형 차이 없음" : `남은 차이 ${diffs.length}곳`;
  const understood = state.patch?.understood;
  return {
    kind: "done",
    dataUrl: out.dataUrl,
    modelId: ctx.modelIds[0] ?? "",
    usage: withSol(next),
    note: `수정 ${k}차 반영 · ${summary}${understood ? ` · 이해한 내용: ${understood}` : ""} · 또 고치거나 다시 그릴 수 있어요`,
    cleanup: [],
    rounds: rounds.length,
    maxDrawn: false,
    offer: next,
  };
}

async function runGen(
  admin: SupabaseClient,
  job: ProblemLoopJob,
  state: ProblemLoopState,
  i: number,
  ctx: Ctx,
): Promise<ProblemLoopOutcome> {
  const ladder = ladderOf(job);
  const quality = ladder[Math.min(i, ladder.length - 1)];
  const original = await loadAsDataUrl(admin, job.input_path);
  if (!original) {
    return { kind: "fail", error: "올려 둔 그림을 찾지 못했어요. 다시 넣어주세요.", cleanup: pathsOf(state) };
  }

  const out = await runFigureGeneration({
    image: original,
    mode: job.mode === "figure" ? "figure" : "problem",
    korean: job.korean,
    instruction: joinInstructions(job.instruction, i === 0 ? undefined : state.instruction),
    inputSize: job.width && job.height ? { width: job.width, height: job.height } : undefined,
    modelIds: ctx.modelIds,
    byokApiKey: ctx.byokApiKey,
    deadlineMs: ctx.deadlineMs,
    tag: `${ctx.tag} 그리기 ${quality}`,
    quality,
    skipCircled: SKIP_CIRCLED,
  });

  if (!out.ok) {
    // 첫 그림이 안 나왔으면 실패. 그 뒤라면 있는 것으로 끝낸다.
    if (state.rounds.length === 0) return { kind: "fail", error: out.error, cleanup: [] };
    return finalize(admin, state, bestRound(state.rounds), ctx, `${quality} 다시 그리기 실패`);
  }

  // 원가 장부(작업을 치워도 남는다). BYOK 는 본인 키라 우리 원가가 아니다.
  if (out.usage && !ctx.byokApiKey) {
    await logAiCost(admin, {
      userId: job.user_id,
      jobId: job.id,
      kind: job.mode === "figure" ? "figure" : "problem",
      what: `그림 ${quality}`,
      krw: out.usage.estKrw,
      usd: out.usage.estUsd,
      tokens: imageTokens(out.usage),
    });
  }

  const parts = splitDataUrl(out.dataUrl);
  const path = parts ? `${job.user_id}/_jobs/${job.id}-r${i}.${parts.ext}` : "";
  const stored = parts ? await storeBytes(admin, path, parts.bytes, parts.mime) : false;
  const usage = addUsage(state.usage, out.usage);
  if (!parts || !stored) {
    if (state.rounds.length === 0) {
      return { kind: "fail", error: "완성된 그림을 저장하지 못했어요. 다시 시도해주세요.", cleanup: [] };
    }
    return finalize(admin, { ...state, usage }, bestRound(state.rounds), ctx, "중간 그림 저장 실패");
  }

  // 다시 그리기는 앞 라운드 뒤를 새로 쓴다 — 수정(`-p<k>`)으로 쌓인 라운드가 잘려 나가면 그 파일도 지운다.
  const dropped = state.rounds.slice(i).map((r) => r.path).filter((pth) => pth !== path);
  if (dropped.length) await removeStored(admin, dropped);
  const next: ProblemLoopState = {
    ...state,
    usage,
    rounds: [...state.rounds.slice(0, i), { quality, path }],
    current: undefined,
  };
  return {
    kind: "next",
    stage: `verify:${i}`,
    state: next,
    note: `${quality} 로 그렸어요 · sol 이 글자·도형을 검수합니다`,
  };
}

/**
 * 검수 호출의 프롬프트 캐시 키. 검수는 매번 **같은 지시문(VERIFY_PROMPT, 2천 토큰쯤) + 원본 사진**으로 시작해서
 * 앞부분이 캐시에 맞는다 — 지시문은 모든 검수가, 원본 사진은 같은 문제의 다음 라운드가 같이 쓴다.
 */
const VERIFY_CACHE_KEY = "reprint-verify";

/**
 * sol(`OPENAI_TEXT_MODEL`)에게 사진들과 프롬프트를 보내 글을 받는다 — 백그라운드로 걸고 묻는다(강도를 올리면 오래
 * 걸린다). 분당 한도(429)는 6·12초 뒤 두 번까지 다시 걸고, **응답은 받자마자(실패·시간 초과면 취소 뒤) 지운다.**
 * BYOK 계정은 본인 키로만 부른다. 실패는 던지지 않고 `fail` 로 돌려준다(부르는 쪽이 정한다).
 */
export async function askSol(
  prompt: string,
  images: string[],
  ctx: Ctx,
  label: string,
  opts?: {
    /** 추론 강도를 아예 보내지 않는다(수정 대화 — 사용자 지시). 기본은 검수 강도. */
    noEffort?: boolean;
    /** 검수 강도 대신 쓸 추론 강도(수정 창의 조판용 옮겨 적기는 지문 인식과 같은 강도). */
    effort?: string;
    /** 프롬프트 캐시 키(같은 일끼리 같은 값 — `postResponses` 주석). */
    cacheKey?: string;
    /** 사진들 뒤에 붙일 글(매번 바뀌는 부분 — 앞쪽이 캐시에 맞게). */
    tail?: string;
  },
): Promise<{ text: string | null; krw: number; fail: string; usage?: GradeUsage }> {
  const t0 = Date.now();
  let text: string | null = null;
  let krw = 0;
  let fail = "";
  let usage: GradeUsage | undefined;
  let respId: string | null = null;
  try {
    let id = "";
    for (let attempt = 0; ; attempt++) {
      try {
        id = await startVisionBackground(prompt, images, OPENAI_TEXT_MODEL, opts?.noEffort ? undefined : (opts?.effort ?? VERIFY_EFFORT), ctx.byokApiKey, {
          cacheKey: opts?.cacheKey,
          tail: opts?.tail,
        });
        break;
      } catch (err) {
        const limited = err instanceof GradeError && err.status === 429 && !/quota|billing|balance/i.test(err.message);
        if (!limited || attempt >= 2 || Date.now() - t0 > ctx.deadlineMs / 2) throw err;
        await new Promise((r) => setTimeout(r, 6000 * (attempt + 1)));
      }
    }
    respId = id;
    for (;;) {
      if (Date.now() - t0 > ctx.deadlineMs) {
        fail = `sol ${label}가 시간 안에 끝나지 않음`;
        break;
      }
      await new Promise((r) => setTimeout(r, 4000));
      const poll = await pollVisionBackground(id, ctx.byokApiKey);
      if (poll.status === "running") continue;
      if (poll.status === "error") {
        fail = poll.message;
        break;
      }
      if (poll.usage) {
        usage = poll.usage;
        krw = gradingEstKrw(poll.usage, poll.model) ?? 0;
        console.info(
          `[${ctx.tag}] sol ${label} usage model=${poll.model} in=${poll.usage.inputTokens} cached=${poll.usage.cachedInputTokens ?? 0} out=${poll.usage.outputTokens} est=${krw.toFixed(1)}원`,
        );
      }
      text = poll.text;
      break;
    }
  } catch (err) {
    fail = err instanceof Error ? err.message : `sol ${label} 실패`;
  } finally {
    if (respId) await deleteVisionResponse(respId, ctx.byokApiKey, fail !== "");
  }
  return { text, krw, fail, usage };
}

async function runVerify(
  admin: SupabaseClient,
  job: ProblemLoopJob,
  state: ProblemLoopState,
  i: number,
  ctx: Ctx,
): Promise<ProblemLoopOutcome> {
  const round = state.rounds[i];
  if (!round) return runGen(admin, job, { ...state, rounds: state.rounds.slice(0, i) }, i, ctx);

  const [original, candidate] = await Promise.all([
    loadAsDataUrl(admin, job.input_path),
    loadAsDataUrl(admin, round.path),
  ]);
  // 검수 재료를 못 읽었으면 검수 없이 이 그림으로 끝낸다.
  if (!original || !candidate) return finalize(admin, state, i, ctx, "검수 재료를 못 읽음");

  // sol 은 백그라운드로 걸고 묻는다(강도를 올리면 오래 걸린다). 시간이 다 되면 검수를 포기한다.
  const ask = await askSol(VERIFY_PROMPT, [original, candidate], ctx, "검수", { cacheKey: VERIFY_CACHE_KEY });
  let diffs: TextDiff[] | null = null;
  let fail = ask.fail;
  const solKrw = ask.krw;
  if (ask.text !== null) {
    try {
      diffs = parseVerify(ask.text);
    } catch (err) {
      fail = err instanceof Error ? err.message : "sol 검수 결과를 읽지 못함";
    }
  }

  if (solKrw > 0 && !ctx.byokApiKey) {
    await logAiCost(admin, {
      userId: job.user_id,
      jobId: job.id,
      kind: job.mode === "figure" ? "figure" : "problem",
      what: "sol 검수",
      krw: solKrw,
      tokens: solTokens(ask.usage),
    });
  }
  const withCost: ProblemLoopState = { ...state, solKrw: (state.solKrw ?? 0) + solKrw };
  if (!diffs) {
    console.warn(`[${ctx.tag}] 검수 실패, 검수 없이 저장: ${fail.slice(0, 200)}`);
    return finalize(admin, withCost, i, ctx, "검수 실패");
  }

  const rounds = state.rounds.map((r, k) => (k === i ? { ...r, diffs: diffs!.length } : r));
  const checked: ProblemLoopState = { ...withCost, rounds };
  console.info(`[${ctx.tag}] 검수 ${round.quality} 차이 ${diffs.length}곳`);

  // 차이가 없거나 마지막 라운드면 끝. 그림 하나(figure)는 low → medium 까지만 돌고 맨 위 단계·확인 대기는 없다.
  const ladder = ladderOf(job);
  const lastAuto = job.edit ? ladder.length - 1 : job.mode === "figure" ? ladder.length - 2 : ladder.length - 1;
  if (diffs.length === 0 || i >= lastAuto) {
    return finalize(admin, checked, bestRound(rounds), ctx, "");
  }

  // 다음 라운드는 **원본만 보고** 새로 그린다 — 앞 라운드 그림은 입력으로 안 넣는다(고친 그림을 또
  // 베끼면 흐려진다). 대신 low·medium 이 틀린 곳을 전부 모아 주의사항으로 넘긴다.
  const history: RoundDiffs[] = [
    ...(state.history ?? []).filter((h) => h.quality !== round.quality),
    { quality: round.quality, diffs: diffs.slice(0, 20) },
  ];
  const withHistory: ProblemLoopState = { ...checked, history, instruction: accumulatedCorrection(history) };

  // **max 는 바로 돌리지 않는다**(사용자 — "딴 거 먼저 한 다음에 마지막에 최종 컨펌받고 돌려").
  // medium 까지 해도 차이가 남으면 지금까지 나온 것 중 가장 나은 그림을 **먼저 저장**하고, 입력·중간
  // 그림·지시를 작업에 남겨 둔 채 멈춘다. 사용자가 패널에서 확인하면 그때 200토큰을 걷고 이어 돌린다.
  if (!job.edit && i === ladder.length - 2 && !state.maxPhase) {
    const saved = await finalize(admin, withHistory, bestRound(rounds), ctx, "");
    if (saved.kind === "done") {
      return {
        ...saved,
        note: `${saved.note} · ${TOP_QUALITY} 로 고쳐 그리려면 확인이 필요해요`,
        cleanup: [],
        offer: withHistory,
      };
    }
    return saved;
  }

  const nextQ = ladder[i + 1];
  return {
    kind: "next",
    stage: `gen:${i + 1}`,
    state: withHistory,
    note: `${round.quality}: 차이 ${diffs.length}곳 → ${nextQ} 로 고쳐 그립니다`,
  };
}
