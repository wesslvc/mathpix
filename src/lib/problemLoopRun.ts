// 문제 통째로 다시 그리기의 **그리기 → sol 검수 → 고쳐 그리기 반복**(2026-09-30). **서버 전용.**
//
// 예전에는 sunburst 를 한 번 불러 나온 그림을 그대로 저장했다. 글자·도형이 틀려도 알 방법이
// 없었다. 비교 화면(`/admin/compare-problem`)에서 시험한 흐름을 운영으로 옮긴 것이다:
//
//   gen:0    low 로 그린다
//   verify:0 sol 이 원본과 대조한다(글자 · 깨진 글자 · 도형). 차이가 0곳이면 끝.
//   gen:1    차이 목록을 지시로 붙여 medium 으로 다시 그린다(입력은 늘 **원본**)
//   verify:1 …
//   gen:2    max 로 마지막으로 그린다 → verify:2 → 끝
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
import { OPENAI_TEXT_MODEL, pollVisionBackground, startVisionBackground } from "./gradeExam";
import { correctionInstruction, parseVerify, VERIFY_PROMPT, type TextDiff } from "./problemCompare";
import { gradingEstKrw } from "./tokens";

/** 그리는 차례(고정). 앞에서 차이가 없어지면 거기서 멈춘다. */
export const PROBLEM_LADDER = ["low", "medium", "max"] as const;

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
  /** 다음 그리기에 붙일 지시(방금 검수가 찾은 차이). */
  instruction?: string;
  /** 지금까지 그림 호출의 사용량 합. */
  usage?: FigureUsage;
  /** sol 검수 원가 합(원). */
  solKrw?: number;
};

export type ProblemLoopJob = {
  id: string;
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
    }
  | { kind: "fail"; error: string; cleanup: string[] };

type Ctx = {
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
  };
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

  const verIdx = indexOf(stage, "verify");
  if (verIdx !== null) return runVerify(admin, job, state, verIdx, ctx);

  // 모르는 단계(옛 데이터)면 처음부터.
  return runGen(admin, job, { rounds: [] }, 0, ctx);
}

async function runGen(
  admin: SupabaseClient,
  job: ProblemLoopJob,
  state: ProblemLoopState,
  i: number,
  ctx: Ctx,
): Promise<ProblemLoopOutcome> {
  const quality = PROBLEM_LADDER[Math.min(i, PROBLEM_LADDER.length - 1)];
  const original = await loadAsDataUrl(admin, job.input_path);
  if (!original) {
    return { kind: "fail", error: "올려 둔 그림을 찾지 못했어요. 다시 넣어주세요.", cleanup: pathsOf(state) };
  }

  const out = await runFigureGeneration({
    image: original,
    mode: "problem",
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

  const next: ProblemLoopState = {
    ...state,
    usage,
    rounds: [...state.rounds.slice(0, i), { quality, path }],
  };
  return {
    kind: "next",
    stage: `verify:${i}`,
    state: next,
    note: `${quality} 로 그렸어요 · sol 이 글자·도형을 검수합니다`,
  };
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
  const t0 = Date.now();
  let diffs: TextDiff[] | null = null;
  let solKrw = 0;
  let fail = "";
  try {
    const id = await startVisionBackground(VERIFY_PROMPT, [original, candidate], OPENAI_TEXT_MODEL, VERIFY_EFFORT);
    for (;;) {
      if (Date.now() - t0 > ctx.deadlineMs) {
        fail = "sol 검수가 시간 안에 끝나지 않음";
        break;
      }
      await new Promise((r) => setTimeout(r, 4000));
      const poll = await pollVisionBackground(id);
      if (poll.status === "running") continue;
      if (poll.status === "error") {
        fail = poll.message;
        break;
      }
      if (poll.usage) solKrw = gradingEstKrw(poll.usage, poll.model) ?? 0;
      diffs = parseVerify(poll.text);
      break;
    }
  } catch (err) {
    fail = err instanceof Error ? err.message : "sol 검수 실패";
  }

  const withCost: ProblemLoopState = { ...state, solKrw: (state.solKrw ?? 0) + solKrw };
  if (!diffs) {
    console.warn(`[${ctx.tag}] 검수 실패, 검수 없이 저장: ${fail.slice(0, 200)}`);
    return finalize(admin, withCost, i, ctx, "검수 실패");
  }

  const rounds = state.rounds.map((r, k) => (k === i ? { ...r, diffs: diffs!.length } : r));
  const checked: ProblemLoopState = { ...withCost, rounds };
  console.info(`[${ctx.tag}] 검수 ${round.quality} 차이 ${diffs.length}곳`);

  // 차이가 없거나 마지막 라운드면 끝.
  if (diffs.length === 0 || i >= PROBLEM_LADDER.length - 1) {
    return finalize(admin, checked, bestRound(rounds), ctx, "");
  }

  const nextQ = PROBLEM_LADDER[i + 1];
  return {
    kind: "next",
    stage: `gen:${i + 1}`,
    state: { ...checked, instruction: correctionInstruction(diffs) },
    note: `${round.quality}: 차이 ${diffs.length}곳 → ${nextQ} 로 고쳐 그립니다`,
  };
}
