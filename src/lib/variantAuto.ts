/**
 * **변형문제 자동 검수·수정 흐름** (2026-10-19, 사용자 — "기획-제작-검수 → 오류(사용자 확인) → 수정 → 재검수").
 *
 * 문제마다 `box_range.variantAuto` 에 상태를 둔다:
 *   checking        재검수 중
 *   needs_approval  오류가 잡혀 사용자 승인을 기다림 (notes 에 지적과 그림 편집 행동)
 *   fixing          승인받아 수정 중 (끝나면 저절로 재검수 → 통과면 확정, 오류면 다시 승인 대기)
 *   passed          통과 · 확정됨 (보관하던 이전 그림은 지운다)
 *   error           작업이 실패함 (message)
 *
 * 바퀴 수는 정하지 않는다 — 오류가 나올 때마다 사용자가 승인해야 다음 수정이 돈다.
 * 수정 한 번 = 그림 부분 수정(편집 행동이 있으면) **또는** 설계 고치기(설계 문제만 남았으면). 반영 검사에서 안 됐거나 엉뚱한 곳이
 * 망가졌으면 **아무것도 저장하지 않고** 그 사실을 다음 재검수 지적에 덧붙인다.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { askSol } from "./problemLoopRun";
import { GradeError, OPENAI_TEXT_MODEL, deleteVisionResponse, pollVisionBackground, startVisionBackground } from "./gradeExam";
import { gradingEstKrw } from "./tokens";
import { loadAsDataUrl, removeStored, runFigureGeneration, splitDataUrl, storeBytes } from "./figureRun";
import { figureImageModelIds } from "./figureImageGen";
import { compositePatch } from "./patchComposite";
import { cardUrl } from "./cardUrl";
import { imageTokens, logAiCost, solTokens } from "./costLog";
import { TYPESET_PROMPT, parseJsonObject } from "./problemCompare";
import { VARIANT_PROMPT, answerOf, parseVariantPlan, settingsTail } from "./variantPlan";

export type AutoNote = { problem: string; fix: string };
export type VariantAutoState = {
  status: "checking" | "needs_approval" | "fixing" | "rendering" | "rendered" | "passed" | "error";
  round: number;
  notes?: AutoNote[];
  message?: string;
  /** 직전 수정이 반영되지 않았을 때 그 이유(다음 수정 지시에 함께 넣는다). */
  lastFail?: string;
  solved?: string;
  at: string;
  /** 처음 상태(되돌리기용) — 통과하면 지운다. */
  baseImagePath?: string;
  /** 조판 고치기: 걸어 둔 sol 백그라운드 응답(작업 한도 300초를 넘겨도 다음 작업이 이어 묻는다). */
  typesetResp?: { id: string; at: string };
};

/** 조판 sol 응답을 기다리는 최대 시간 — 넘으면 취소하고 승인 대기로 되돌린다. */
const TYPESET_MAX_MS = 30 * 60_000;
const TYPESET_EFFORT = process.env.VARIANT_TYPESET_EFFORT?.trim() || "high";

type Ctx = {
  admin: SupabaseClient;
  userId: string;
  jobId: string;
  byok: boolean;
  byokApiKey?: string;
  deadlineMs: number;
  tag: string;
};

const s = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

export const RECHECK_PROMPT = (hasOrig: boolean) =>
  `task: re-check a GENERATED VARIANT of a Korean exam question picture. ${hasOrig ? "image 1 = the ORIGINAL question, image 2 = the VARIANT." : "the only image = the VARIANT."} after the images you get the variant's registered answer and its solution. check, reading character by character: (1) broken, misspelled or missing glyphs/words/numbers/units in the stem, the <보기> box, the table and the labels; (2) all five choices ①–⑤ present, none left over from the original that contradicts the new problem, and exactly the registered answer is correct (solve the variant yourself and compare with the solution); (3) values/figure/table in the picture agree with the solution's numbers (a figure still showing the original's values is a defect); (4) leftover original wording that no longer fits; (5) choices ①–⑤ laid out abnormally (overlapping, wrapped mid-choice, misaligned or not in the original's arrangement) and a stem written clumsily or unlike an official KICE (평가원) question. report only real, clearly visible defects — when in doubt, say nothing. for EACH problem give a concrete image-editor action. reply ONLY JSON: {"notes":[{"problem":"문제점(한국어, 어디가 어떻게)","fix":"그림 편집기에게 줄 구체적 행동 한 문장(한국어) — 반드시 '위치(예: <보기> ㄱ 둘째 줄) + 현재 글/값 → 바꿀 글/값' 꼴. 글자·숫자·기호·이름표 수정, 깨진 글자 고치기, 선지 배치 바로잡기는 물론 점·선·띠·곡선·도형을 옮기거나 다시 그리는 것도 적는다(옮길 때는 기준이 될 눈금·해안선·이웃 표지와 목표 위치를 수치로: 예 '점 B: 현재 37°N 선 위 → 원래보다 그림 폭의 6% 왼쪽, 해안선과 만나는 곳'). 문제 설계 자체(난이도·함정·정답/선지 모순)가 틀려 그림 편집으로 못 고치는 것만 빈 문자열"}],"solved_answer":"푼 정답"}. never describe your reasoning in fix; empty notes if nothing is wrong.`;

export const FIXCHECK_PROMPT = `task: check a PARTIAL EDIT of a Korean exam question picture. image 1 = BEFORE, image 2 = AFTER. the edit instruction is given after the images. for EACH numbered item decide whether image 2 now matches the instruction (read the text carefully, character by character). STRICT RULES to avoid false alarms: mark done:false ONLY when you can SEE in image 2 that the requested change is clearly not there or is wrong; if an item cannot be verified from the picture at all treat it as done:true. list a collateral change ONLY when something clearly visible in image 1 (text, numbers, choices, figure parts, labels) is clearly missing, garbled or altered in image 2 and was NOT named in the instruction; tiny pixel differences, slight shifts and equivalent re-typesetting are NOT changes. when in doubt, say nothing. reply ONLY JSON: {"items":[{"item":"짧은 한국어 설명","done":true|false,"note":"안 됐으면 무엇이 어떻게 다른지(한국어)"}],"collateral":["의도하지 않은 변경(한국어)"]}`;

/** **그림 기준으로 다시 풀기**: 그림을 정답으로 보고 그려진 그대로 풀어 정답·해설을 맞춘다(그림 모델은 위치를 정확히 못 옮긴다). */
export const ALIGN_PROMPT = (hasOrig: boolean) =>
  `task: you are a Korean exam writer fixing a GENERATED VARIANT question. ${hasOrig ? "image 1 = the ORIGINAL question (reference only), image 2 = the VARIANT picture." : "the image = the VARIANT picture."} a checker listed problems (after the images); most are mismatches between the drawn figure and the registered solution. RULE: THE VARIANT PICTURE IS THE TRUTH — an image editor cannot move points, lines, bands or curves precisely, so we change the answer and the solution to fit what is drawn. read every value, label, scale tick and position from the variant picture carefully (estimate positions from the axes/grid), then SOLVE the variant exactly as drawn. decide: sound = the drawn problem is well-defined and EXACTLY ONE choice ①–⑤ is correct. only small TEXT defects may be fixed in the picture (broken/missing glyphs, a wrong number or label text that makes the problem unsound); never ask to move or redraw graphics. reply ONLY JSON: {"sound":true|false,"reason":"한국어 한 문장","new_answer":"①~⑤ 한 개 또는 숫자","solution":"그림대로 푼 새 해설(Mathpix 마크다운, 한국어 문장 + $수식$, 분수는 \\frac, 소수 지양, 6~14문단, 그림에서 읽은 값을 그대로 쓰고 끝줄 정답)","text_edits":["위치 + 현재 글 → 바꿀 글 (글자만, 꼭 필요할 때만)"]}. if not sound, still fill reason.`;

export const REDESIGN_PROMPT = (hasOrig: boolean) =>
  `task: you are a Korean exam writer. ${hasOrig ? "image 1 = the ORIGINAL question, image 2 = a VARIANT of it" : "the image = a VARIANT question"}. the variant has DESIGN problems listed after the images (things a picture edit alone cannot fix: the intended trap/difficulty/novelty is missing, the answer or choices are inconsistent, etc.). REVISE THE VARIANT so every listed problem is solved, changing as LITTLE as possible: keep the unit/course, the solution logic type, layout and numbering; you may change values, conditions, statements (<보기> ㄱㄴㄷ) and choices. SOLVE the revised problem yourself, make exactly one choice ①–⑤ correct, recompute ALL five choices. then write "edits": a numbered list of concrete actions for an image editor that sees only the current variant picture — each item = location (e.g. '<보기> ㄴ 줄', '표 (가) B행 연령 칸', '선지 ③') + the exact current text/value → the exact new text/value; include every changed statement, value, figure/table cell and ALL changed choices; no reasoning, no vague wishes. reply ONLY JSON: {"summary":"한국어 1~2문장: 무엇을 어떻게 고쳤나","new_answer":"새 정답(①~⑤ 한 개 또는 숫자)","solution":"새 해설(Mathpix 마크다운, 한국어 문장 + $수식$, 분수는 \\frac, 소수 지양, 6~14문단, 끝줄 정답)","edits":"번호 목록 전체"}`;

export function readNotes(raw: unknown): AutoNote[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(Boolean)
    .map((n) => {
      const o = typeof n === "string" ? { problem: n, fix: "" } : (n as { problem?: unknown; fix?: unknown });
      return { problem: s(o.problem, 260), fix: s(o.fix, 300) };
    })
    .filter((n) => n.problem)
    .slice(0, 10);
}

async function setAuto(ctx: Ctx, problemId: string, patch: (br: Record<string, unknown>) => Record<string, unknown>, extra?: Record<string, unknown>) {
  const { data } = await ctx.admin.from("problems").select("box_range").eq("id", problemId).eq("user_id", ctx.userId).maybeSingle();
  const br = ((data?.box_range ?? {}) as Record<string, unknown>) || {};
  await ctx.admin
    .from("problems")
    .update({ ...(extra ?? {}), box_range: patch(br) })
    .eq("id", problemId)
    .eq("user_id", ctx.userId);
}

/** 다음 단계를 서버 대기열에 넣는다(일꾼이 집는다 — 한 작업이 300초를 넘지 않게 단계마다 나눈다). */
export async function enqueueAutoStep(admin: SupabaseClient, userId: string, problemId: string, step: "check" | "fix", label: string) {
  await admin.from("figure_jobs").insert({
    id: crypto.randomUUID(),
    user_id: userId,
    figure_id: `auto:${problemId}:${step}:${Date.now().toString(36)}`,
    problem_key: "",
    label: label.slice(0, 100),
    mode: "task",
    stage: "variantAuto",
    input_path: "",
    payload: { task: "variantAuto", paths: [], params: { problemId, step } },
  });
}

/** 수정을 승인받은 뒤에 두는 상태. 화면(승인 버튼)이 쓴다 — 서버에서만 돌므로 여기 둔다. */
export function approvedState(prev: VariantAutoState | undefined): VariantAutoState {
  return { ...(prev ?? { round: 0, at: "" }), status: "fixing", at: new Date().toISOString() } as VariantAutoState;
}

async function logSol(ctx: Ctx, what: string, r: { krw: number; usage?: Parameters<typeof solTokens>[0] }) {
  if (r.krw > 0 && !ctx.byok) await logAiCost(ctx.admin, { userId: ctx.userId, jobId: ctx.jobId, kind: "problem", what, krw: r.krw, tokens: solTokens(r.usage) });
}

/** **재검수 단계**: 통과면 확정(이전 그림 정리), 오류면 승인 대기. */
export async function runCheckStep(ctx: Ctx, problemId: string, t0: number) {
  const { data: prob } = await ctx.admin.from("problems").select("id,image_path,answer,box_range").eq("id", problemId).eq("user_id", ctx.userId).maybeSingle();
  if (!prob?.image_path) return { ok: false as const, error: "문제를 찾지 못했어요." };
  const br = ((prob.box_range ?? {}) as Record<string, unknown>) || {};
  const prev = br.variantAuto as VariantAutoState | undefined;
  const round = prev?.round ?? 0;
  const vo = (br.variantOf ?? {}) as { path?: string };
  const cur = await loadAsDataUrl(ctx.admin, prob.image_path as string);
  if (!cur) return { ok: false as const, error: "문제 그림을 읽지 못했어요." };
  const orig = typeof vo.path === "string" && vo.path ? await loadAsDataUrl(ctx.admin, vo.path) : null;
  const sol = typeof br.solution === "string" ? br.solution.slice(0, 3000) : "";
  const rv = await askSol(
    RECHECK_PROMPT(!!orig),
    orig ? [orig, cur] : [cur],
    { byokApiKey: ctx.byokApiKey, modelIds: [], deadlineMs: Math.min(180_000, ctx.deadlineMs - (Date.now() - t0) - 10_000), tag: ctx.tag },
    "변형 자동 재검수",
    // 통과면 사람 확인 없이 확정되므로 깊게 본다 — medium 으로 시험했더니 출력 75~220토큰(직접 풀지 않은 수준)으로 통과시켰다.
    { effort: process.env.VARIANT_RECHECK_EFFORT?.trim() || "high", cacheKey: "reprint-variant-recheck", tail: `\n\nREGISTERED ANSWER: ${String(prob.answer ?? "")}\nSOLUTION\n${sol}` },
  );
  await logSol(ctx, "sol 변형 자동 재검수", rv);
  const obj = rv.text ? (parseJsonObject(rv.text) as { notes?: unknown; solved_answer?: unknown } | null) : null;
  if (!obj) {
    await setAuto(ctx, problemId, (b) => ({ ...b, variantAuto: { ...(prev ?? {}), status: "error", round, message: rv.fail || "재검수 결과를 읽지 못했어요.", at: new Date().toISOString() } }));
    return { ok: false as const, error: rv.fail || "재검수 결과를 읽지 못했어요.", krw: rv.krw };
  }
  const notes = readNotes(obj.notes);
  const at = new Date().toISOString();
  if (notes.length === 0) {
    // 통과 — 확정한다: 보관하던 이전 그림(처음 상태·수동 수정의 직전 그림)을 지우고 기록을 정리한다.
    const keep = prob.image_path as string;
    const old = [prev?.baseImagePath, (br.variantFix as { prevImagePath?: string } | undefined)?.prevImagePath].filter((p): p is string => !!p && p !== keep);
    await setAuto(ctx, problemId, (b) => ({
      ...b,
      variantFix: undefined,
      variantRecheck: undefined,
      variantReview: undefined,
      // 처음 그림을 지우므로 조판 전 상태(그 그림을 가리킨다)도 뗀다.
      ...(old.length ? { preTypeset: undefined } : {}),
      variantAuto: { status: "passed", round, solved: s(obj.solved_answer, 60), at },
    }));
    if (old.length) await removeStored(ctx.admin, old);
    return { ok: true as const, passed: true, notes, krw: rv.krw };
  }
  await setAuto(ctx, problemId, (b) => ({
    ...b,
    variantAuto: {
      status: "needs_approval",
      round,
      notes,
      solved: s(obj.solved_answer, 60),
      at,
      ...(prev?.lastFail ? { lastFail: prev.lastFail } : {}),
      baseImagePath: prev?.baseImagePath ?? (prob.image_path as string),
    },
  }));
  return { ok: true as const, passed: false, notes, krw: rv.krw };
}

/** 그림 편집 + 합성 → data URL. */
async function patch(ctx: Ctx, base: string, instruction: string, deadlineMs: number) {
  const gen = await runFigureGeneration({
    image: base,
    mode: "problem",
    korean: false,
    patchNote: instruction,
    patchStrong: true,
    modelIds: figureImageModelIds(),
    byokApiKey: ctx.byokApiKey,
    deadlineMs,
    tag: ctx.tag,
    quality: "medium",
  });
  if (!gen.ok) return { ok: false as const, error: gen.error, krw: 0 };
  const krw = gen.usage?.estKrw ?? 0;
  if (gen.usage && !ctx.byok) await logAiCost(ctx.admin, { userId: ctx.userId, jobId: ctx.jobId, kind: "problem", what: "그림 변형 자동 수정", krw, usd: gen.usage.estUsd, tokens: imageTokens(gen.usage) });
  let url = gen.dataUrl;
  try {
    const b = splitDataUrl(base);
    const e = splitDataUrl(gen.dataUrl);
    const comp = b && e ? await compositePatch(b.bytes, e.bytes) : null;
    if (comp) url = `data:${comp.mime};base64,${comp.bytes.toString("base64")}`;
  } catch {
    /* 편집 결과 그대로 */
  }
  return { ok: true as const, url, krw };
}

/** 반영 검사 — 안 된 항목·의도하지 않은 변경을 돌려준다(빈 배열이면 통과, null 이면 검사를 못 함). */
async function fixCheck(ctx: Ctx, before: string, after: string, instruction: string, deadlineMs: number) {
  const rv = await askSol(
    FIXCHECK_PROMPT,
    [before, after],
    { byokApiKey: ctx.byokApiKey, modelIds: [], deadlineMs, tag: ctx.tag },
    "변형 자동 수정 반영 검사",
    { effort: "medium", cacheKey: "reprint-variant-fixcheck", tail: `\n\nINSTRUCTION\n${instruction}` },
  );
  await logSol(ctx, "sol 변형 자동 수정 반영 검사", rv);
  const obj = rv.text ? (parseJsonObject(rv.text) as { items?: { item?: string; done?: boolean; note?: string }[]; collateral?: unknown[] } | null) : null;
  if (!obj) return { problems: null as string[] | null, krw: rv.krw };
  const problems: string[] = [];
  for (const it of obj.items ?? []) if (it && it.done === false) problems.push(`${s(it.item, 80)}: ${s(it.note, 200)}`);
  for (const c of obj.collateral ?? []) if (c) problems.push(`의도하지 않은 변경: ${s(typeof c === "string" ? c : (c as { what?: string }).what, 200)}`);
  return { problems, krw: rv.krw };
}

/** **수정 단계**(승인 뒤): 설계 문제가 있으면 재설계 → 원본에서 새로 생성(재검수가 이어서 본다), 아니면 그림 부분 수정(반영 검사 통과해야 저장). 반영 검사를 통과해야 저장한다. 끝나면 재검수를 넣는다. */
export async function runFixStep(ctx: Ctx, problemId: string, t0: number) {
  const { data: prob } = await ctx.admin.from("problems").select("id,category_id,image_path,answer,answer_type,box_range").eq("id", problemId).eq("user_id", ctx.userId).maybeSingle();
  if (!prob?.image_path) return { ok: false as const, error: "문제를 찾지 못했어요." };
  const br = ((prob.box_range ?? {}) as Record<string, unknown>) || {};
  const st = br.variantAuto as VariantAutoState | undefined;
  const notes = st?.notes ?? [];
  const fixes = notes.map((n) => n.fix.trim()).filter(Boolean);
  const design = notes.filter((n) => !n.fix.trim()).map((n) => n.problem);
  const base = await loadAsDataUrl(ctx.admin, prob.image_path as string);
  if (!base) return { ok: false as const, error: "문제 그림을 읽지 못했어요." };
  const left = () => ctx.deadlineMs - (Date.now() - t0);
  const retry = st?.lastFail ? `\nNOTE: the previous attempt at this edit did NOT work (${st.lastFail.slice(0, 300)}). make the change clearly this time.` : "";
  let krw = 0;
  let lastFail = "";
  let saved = false;
  let update: Record<string, unknown> = {};
  let newBox: Record<string, unknown> = {};

  const vo0 = (br.variantOf ?? {}) as { path?: string };
  const orig0 = typeof vo0.path === "string" && vo0.path ? await loadAsDataUrl(ctx.admin, vo0.path) : null;

  // ① 그림 기준으로 다시 풀기(그림은 그대로 두고 정답·해설을 그림에 맞춘다). 성립하지 않으면 ② 재설계로.
  let unsound = "";
  let aligned = false;
  if (notes.length) {
    const curSol = typeof br.solution === "string" ? br.solution.slice(0, 2500) : "";
    const ask = await askSol(
      ALIGN_PROMPT(!!orig0),
      orig0 ? [orig0, base] : [base],
      { byokApiKey: ctx.byokApiKey, modelIds: [], deadlineMs: Math.min(150_000, left() - 100_000), tag: ctx.tag },
      "변형 그림 기준 다시 풀기",
      {
        effort: "high",
        cacheKey: "reprint-variant-align",
        tail: `\n\nCHECKER PROBLEMS\n${notes.map((n, i) => `${i + 1}. ${n.problem}`).join("\n")}\n\nCURRENT REGISTERED ANSWER: ${String(prob.answer ?? "")}\nCURRENT SOLUTION\n${curSol}`,
      },
    );
    await logSol(ctx, "sol 변형 그림 기준 다시 풀기", ask);
    krw += ask.krw;
    const a = ask.text ? (parseJsonObject(ask.text) as { sound?: unknown; reason?: unknown; new_answer?: unknown; solution?: unknown; text_edits?: unknown } | null) : null;
    if (a && a.sound === true && typeof a.solution === "string" && a.solution.trim().length > 30) {
      const { answer, type } = answerOf(s(a.new_answer, 100));
      if (answer) {
        aligned = true;
        update = { answer, answer_type: type };
        newBox = { solution: a.solution.trim().slice(0, 6000) };
        const edits = Array.isArray(a.text_edits) ? a.text_edits.map((x) => s(x, 300).trim()).filter(Boolean).slice(0, 6) : [];
        if (edits.length && left() > 90_000) {
          const instruction = `${edits.map((f, i) => `${i + 1}. ${f}`).join("\n")}${retry}\nchange ONLY these texts; keep every graphic, position and all other text exactly as in the picture.`;
          const p = await patch(ctx, base, instruction, left() - 50_000);
          krw += p.krw;
          if (!p.ok) lastFail = `글자 수정 실패: ${p.error}`;
          else {
            const chk = left() > 35_000 ? await fixCheck(ctx, base, p.url, instruction, Math.min(70_000, left() - 12_000)) : { problems: null, krw: 0 };
            krw += chk.krw;
            if (chk.problems && chk.problems.length) lastFail = `글자 수정이 반영되지 않음: ${chk.problems.join(" / ")}`.slice(0, 600);
            else newBox = { ...newBox, url: p.url };
          }
        }
        saved = true;
      }
    } else if (a && a.sound === false) {
      unsound = s(a.reason, 300) || "그림대로는 문제가 성립하지 않음";
    } else {
      lastFail = `그림 기준 다시 풀기 실패: ${ask.fail || "응답을 읽지 못함"}`;
    }
  }

  if (aligned) {
    // 정답·해설(과 글자 수정)을 아래에서 저장한다.
  } else if (unsound && orig0 && left() > 120_000) {
    // **설계가 잘못된 문제는 재설계 → 원본에서 새로 생성 → 재검수**(사용자 — "문제 자체가 잘못 설계된 경우 재설계 후 생성 후 검증").
    // 지금 그림 위에 덧칠하지 않는다: sol 이 원본을 보고 지적을 피한 변형을 처음부터 다시 설계하고, 원본을 그 계획대로 편집한다.
    // 반영 검사는 하지 않는다 — 곧바로 이어지는 재검수가 문제 전체를 본다.
    const curSol = typeof br.solution === "string" ? br.solution.slice(0, 2500) : "";
    const allNotes = [`the variant AS DRAWN is not a sound problem: ${unsound}`, ...notes.map((n, i) => `${i + 1}. ${n.problem}`)].join("\n");
    const ask = await askSol(
      VARIANT_PROMPT,
      [orig0],
      { byokApiKey: ctx.byokApiKey, modelIds: [], deadlineMs: Math.min(150_000, left() - 100_000), tag: ctx.tag },
      "변형 자동 재설계",
      {
        effort: "medium",
        cacheKey: "reprint-variant",
        tail: `${settingsTail("similar", "slight", 1, 1)}\n\nREDESIGN: a previous variant made from this original was rejected by the checker. design a NEW variant that avoids EVERY problem below (do not repeat its mistakes; fix the design itself, not just wording).\nPROBLEMS OF THE PREVIOUS VARIANT\n${allNotes}\nPREVIOUS VARIANT'S REGISTERED ANSWER: ${String(prob.answer ?? "")}\nPREVIOUS VARIANT'S SOLUTION\n${curSol}`,
      },
    );
    await logSol(ctx, "sol 변형 자동 재설계", ask);
    krw += ask.krw;
    let plan: ReturnType<typeof parseVariantPlan> | null = null;
    try {
      if (ask.text) plan = parseVariantPlan(ask.text);
    } catch {
      plan = null;
    }
    if (!plan) lastFail = `재설계를 못 만듦: ${ask.fail || "응답을 읽지 못함"}`;
    else if (left() < 50_000) lastFail = "재설계에 시간이 너무 걸려 그림을 못 그림";
    else {
      const gen = await runFigureGeneration({
        image: orig0,
        mode: "problem",
        korean: false,
        ...(plan.kind === "concept" ? { variantNote: plan.edits } : { patchNote: plan.edits, patchStrong: true }),
        modelIds: figureImageModelIds(),
        byokApiKey: ctx.byokApiKey,
        deadlineMs: left() - 10_000,
        tag: ctx.tag,
        quality: process.env.VARIANT_IMAGE_QUALITY || "medium",
      });
      if (!gen.ok) lastFail = `재설계 그림 생성 실패: ${gen.error}`;
      else {
        const gk = gen.usage?.estKrw ?? 0;
        krw += gk;
        if (gen.usage && !ctx.byok) await logAiCost(ctx.admin, { userId: ctx.userId, jobId: ctx.jobId, kind: "problem", what: "그림 변형 자동 재설계", krw: gk, usd: gen.usage.estUsd, tokens: imageTokens(gen.usage) });
        let url = gen.dataUrl;
        if (plan.kind !== "concept") {
          try {
            const b = splitDataUrl(orig0);
            const e = splitDataUrl(gen.dataUrl);
            const comp = b && e ? await compositePatch(b.bytes, e.bytes) : null;
            if (comp) url = `data:${comp.mime};base64,${comp.bytes.toString("base64")}`;
          } catch {
            /* 편집 결과 그대로 */
          }
        }
        const { answer, type } = answerOf(plan.newAnswer);
        saved = true;
        update = answer ? { answer, answer_type: type } : {};
        newBox = { url, solution: plan.solution ? plan.solution.slice(0, 6000) : undefined };
      }
    }
  } else if (!unsound && !lastFail && fixes.length) {
    const instruction = `${fixes.map((f, i) => `${i + 1}. ${f}`).join("\n")}${retry}\nkeep everything else exactly as in the picture.`;
    const p = await patch(ctx, base, instruction, left() - 70_000);
    krw += p.krw;
    if (!p.ok) lastFail = `그림 수정 실패: ${p.error}`;
    else {
      const chk = left() > 40_000 ? await fixCheck(ctx, base, p.url, instruction, Math.min(80_000, left() - 15_000)) : { problems: null, krw: 0 };
      krw += chk.krw;
      if (chk.problems && chk.problems.length) lastFail = chk.problems.join(" / ").slice(0, 600);
      else {
        saved = true;
        update = {};
        newBox = { url: p.url };
      }
    }
  } else if (unsound || design.length) {
    const vo = (br.variantOf ?? {}) as { path?: string };
    const orig = typeof vo.path === "string" && vo.path ? await loadAsDataUrl(ctx.admin, vo.path) : null;
    const curSol = typeof br.solution === "string" ? br.solution.slice(0, 3000) : "";
    const ask = await askSol(
      REDESIGN_PROMPT(!!orig),
      orig ? [orig, base] : [base],
      { byokApiKey: ctx.byokApiKey, modelIds: [], deadlineMs: Math.min(130_000, left() - 120_000), tag: ctx.tag },
      "변형 자동 설계 고치기",
      { effort: "medium", cacheKey: "reprint-variant-redesign", tail: `\n\nDESIGN PROBLEMS\n${design.map((x, i) => `${i + 1}. ${x}`).join("\n")}\n\nCURRENT REGISTERED ANSWER: ${String(prob.answer ?? "")}\nCURRENT SOLUTION\n${curSol}` },
    );
    await logSol(ctx, "sol 변형 자동 설계 고치기", ask);
    krw += ask.krw;
    const plan = ask.text ? (parseJsonObject(ask.text) as { summary?: string; new_answer?: string; solution?: string; edits?: string } | null) : null;
    const edits = s(plan?.edits, 5000);
    if (!plan || edits.length < 10) lastFail = `설계 고치기 계획을 못 만듦: ${ask.fail || "응답을 읽지 못함"}`;
    else {
      const instruction = `${edits}${retry}\nkeep everything else exactly as in the picture.`;
      const p = await patch(ctx, base, instruction, left() - 60_000);
      krw += p.krw;
      if (!p.ok) lastFail = `그림 수정 실패: ${p.error}`;
      else {
        const chk = left() > 35_000 ? await fixCheck(ctx, base, p.url, instruction, Math.min(70_000, left() - 12_000)) : { problems: null, krw: 0 };
        krw += chk.krw;
        if (chk.problems && chk.problems.length) lastFail = `설계 고치기가 그림에 반영되지 않음: ${chk.problems.join(" / ")}`.slice(0, 600);
        else {
          const { answer, type } = answerOf(String(plan.new_answer ?? ""));
          saved = true;
          update = answer ? { answer, answer_type: type } : {};
          newBox = { url: p.url, solution: typeof plan.solution === "string" && plan.solution.trim() ? plan.solution.trim().slice(0, 6000) : undefined };
        }
      }
    }
  } else {
    lastFail = "고칠 지적이 없어요";
  }

  let newPath = "";
  if (saved && typeof newBox.url === "string") {
    const parts = splitDataUrl(newBox.url);
    if (parts) {
      const ext = parts.mime.includes("jpeg") ? "jpg" : "png";
      newPath = `${ctx.userId}/${prob.category_id}/${crypto.randomUUID()}.${ext}`;
      if (!(await storeBytes(ctx.admin, newPath, parts.bytes, parts.mime))) {
        newPath = "";
        lastFail = "고친 그림을 저장하지 못했어요";
      }
    }
  }
  const basePath = st?.baseImagePath ?? (prob.image_path as string);
  const curPath = prob.image_path as string;
  await setAuto(
    ctx,
    problemId,
    (b) => {
      const figures = Array.isArray(b.figures) ? (b.figures as Record<string, unknown>[]) : [];
      return {
        ...b,
        ...(newPath ? { figures: figures.map((f, i) => (i === 0 ? { ...f, markup: `<img src="${cardUrl(newPath)}" alt="" />` } : f)) } : {}),
        ...((newPath || aligned) && typeof newBox.solution === "string" ? { solution: newBox.solution } : {}),
        variantAuto: { ...(st ?? {}), round: (st?.round ?? 0) + 1, status: "checking", baseImagePath: basePath, lastFail: lastFail || undefined, notes: undefined, at: new Date().toISOString() },
      };
    },
    newPath ? { image_path: newPath, ...update } : aligned ? update : undefined,
  );
  // 중간 그림은 지운다(처음 상태는 통과할 때까지 남긴다).
  if (newPath && curPath !== basePath) await removeStored(ctx.admin, [curPath]);
  await enqueueAutoStep(ctx.admin, ctx.userId, problemId, "check", "자동 재검수");
  return { ok: true as const, saved: !!newPath || aligned, lastFail, krw };
}


/* ───────────────────────── 조판으로 고치기 ───────────────────────── */

/** 조판기(우리 renderMathText)가 읽는 글 꼴 — 옮겨 적기 프롬프트의 규칙을 그대로 빌린다(한 곳만 고치면 되게). */
const MMD_RULES = TYPESET_PROMPT.slice(TYPESET_PROMPT.indexOf("output format for"), TYPESET_PROMPT.indexOf("figures: anything"));

/**
 * **에러난 변형은 조판으로 고친다**(2026-10-19, 사용자 — "처음부터 조판하지 말고 에러난 건 조판 돌리자").
 * 그림 생성 모델은 점·선·띠를 정확한 좌표에 못 놓는다 — 그래서 sol 이 고친 문제를 **글(Mathpix 꼴) + 계산한 값 그대로 그린 SVG** 로
 * 쓰고, 우리 조판기가 카드로 찍는다(카드 PNG 는 브라우저가 그린다 — `variantTypesetApply.ts`). 그림과 해설이 같은 숫자에서 나온다.
 */
export const TYPESET_FIX_PROMPT = (hasOrig: boolean) =>
  `task: you are a Korean exam writer. ${hasOrig ? "image 1 = the ORIGINAL exam question (shows the intended layout and style), image 2 = our current VARIANT of it." : "the image = our current VARIANT question."} a checker found the problems listed after the images. REWRITE THE VARIANT AS A CORRECT, SOUND QUESTION: keep its unit, idea, difficulty and the solution logic, keep its numbering; fix every listed problem (you may change values, statements, <보기> items and choices). SOLVE your rewritten question yourself: exactly ONE choice ①–⑤ must be correct; recompute all five choices.

we will typeset it ourselves, so write the whole question (stem, conditions, tables, <보기>, choices) as text in our format:
${MMD_RULES}
figures (graphs, globes with latitude lines, magnetic stripe bands, diagrams, maps): put "[[FIG fN]]" as its own paragraph where the figure sits, and DRAW each figure as standalone SVG code in "figures". the SVG must be computed from the exact values in your solution: every point, line, band edge and tick at coordinates derived from those values with a consistent scale, so a reader measuring the figure gets exactly the numbers your solution uses. rules: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 W H"> with W 320–720; only black/white/grays (#000 #fff #444 #888 #bbb #ddd); stroke-width 1–2; labels as <text> with font-size 13–16 and font-family "Nanum Myeongjo, serif", Korean as needed; include axes, ticks, tick labels, legends (e.g. black = 정자극기, white = 역자극기) and point labels like the original layout; markers like ●/○/▲ drawn as shapes; no <image>, no external links, no scripts, no foreignObject, no CSS classes. if the information is really a table of numbers, use a markdown table instead of a figure. do not repeat a figure's internal labels in the text.

BEFORE ANSWERING, VERIFY: re-read your own "text" and figures as a student would (only what is written and drawn), judge EVERY choice ①–⑤ (and every <보기> statement) true/false from them alone, and confirm exactly one choice is correct and equals new_answer. if it is not exactly one, fix the question and verify again; if you still cannot make it sound, set "unique": false and say why.
reply ONLY JSON: {"check":["① 참/거짓 + 근거 한 줄", "② …", "③ …", "④ …", "⑤ …"],"unique":true|false,"why":"unique 가 false 면 이유(한국어 한 문장)","text":"전체 문제 글(위 꼴)","figures":[{"id":"f1","svg":"<svg ...>...</svg>"}],"new_answer":"①~⑤ 한 개 또는 숫자","solution":"새 해설(Mathpix 마크다운, 한국어 문장 + $수식$, 분수는 \\frac, 소수 지양, 6~14문단, 그림의 값 그대로, 끝줄 정답)"}`;

/** 모델이 준 SVG 를 카드에 넣어도 되는 모양으로만 받는다(이 문자열은 카드에 그대로 이어붙는다). */
export function cleanSvg(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let v = raw.trim();
  if (!/^<svg[\s>]/i.test(v) || !/<\/svg>\s*$/i.test(v) || v.length > 120_000) return null;
  if (/<\s*(script|foreignObject|image|iframe|use)\b/i.test(v)) return null;
  v = v.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, "").replace(/(href|xlink:href)\s*=\s*("[^"]*"|'[^']*')/gi, "");
  return v;
}

/** **조판 고치기 단계**(승인 뒤): sol 이 글 + SVG 로 다시 쓴다 → `rendering` 으로 두면 브라우저가 카드를 그려 저장하고 재검수를 건다. */
export async function runTypesetFix(ctx: Ctx, problemId: string, t0: number) {
  const { data: prob } = await ctx.admin.from("problems").select("id,image_path,answer,text_content,box_range").eq("id", problemId).eq("user_id", ctx.userId).maybeSingle();
  if (!prob?.image_path) return { ok: false as const, error: "문제를 찾지 못했어요." };
  const br = ((prob.box_range ?? {}) as Record<string, unknown>) || {};
  const st = br.variantAuto as VariantAutoState | undefined;
  const notes = st?.notes ?? [];
  const base = await loadAsDataUrl(ctx.admin, prob.image_path as string);
  if (!base) return { ok: false as const, error: "문제 그림을 읽지 못했어요." };
  const vo = (br.variantOf ?? {}) as { path?: string };
  const orig = typeof vo.path === "string" && vo.path ? await loadAsDataUrl(ctx.admin, vo.path) : null;
  const curSol = typeof br.solution === "string" ? br.solution.slice(0, 2500) : "";
  const curText = typeof prob.text_content === "string" && prob.text_content.trim() ? prob.text_content.slice(0, 4000) : "";
  const at0 = new Date().toISOString();
  const left = () => ctx.deadlineMs - (Date.now() - t0);
  // sol(high)이 글 + SVG 를 7천 토큰 넘게 쓰면 작업 한도(300초)를 넘긴다 — 백그라운드로 걸어 두고, 이 작업에서 못 받으면
  // 다음 작업이 같은 응답을 이어 묻는다(응답 id 를 variantAuto.typesetResp 에 둔다).
  let resp = st?.typesetResp;
  if (!resp) {
    let id = "";
    for (let attempt = 0; ; attempt++) {
      try {
        id = await startVisionBackground(TYPESET_FIX_PROMPT(!!orig), orig ? [orig, base] : [base], OPENAI_TEXT_MODEL, TYPESET_EFFORT, ctx.byokApiKey, {
          cacheKey: "reprint-variant-typeset",
          tail: `\n\nCHECKER PROBLEMS\n${notes.map((n, i) => `${i + 1}. ${n.problem}`).join("\n") || "(none listed — make it sound and consistent)"}${st?.lastFail ? `\nPREVIOUS FIX ATTEMPT FAILED: ${st.lastFail}` : ""}\n\nCURRENT REGISTERED ANSWER: ${String(prob.answer ?? "")}\nCURRENT SOLUTION\n${curSol}${curText ? `\n\nCURRENT TYPESET TEXT (edit this rather than starting over)\n${curText}` : ""}`,
        });
        break;
      } catch (err) {
        const limited = err instanceof GradeError && err.status === 429 && !/quota|billing|balance/i.test(err.message);
        if (!limited || attempt >= 2) {
          const why = err instanceof Error ? err.message : "sol 조판 시작 실패";
          await setAuto(ctx, problemId, (b) => ({ ...b, variantAuto: { ...(st ?? { round: 0 }), status: "needs_approval", typesetResp: undefined, lastFail: `조판 시작 실패: ${why}`.slice(0, 400), at: at0 } }));
          return { ok: true as const, saved: false, lastFail: why, krw: 0 };
        }
        await new Promise((r) => setTimeout(r, 6000 * (attempt + 1)));
      }
    }
    resp = { id, at: at0 };
    const r = resp;
    await setAuto(ctx, problemId, (b) => ({ ...b, variantAuto: { ...((b.variantAuto as VariantAutoState | undefined) ?? st ?? { round: 0 }), status: "fixing", typesetResp: r, at: at0 } }));
  }
  const ask: { text: string | null; krw: number; fail: string; usage?: Parameters<typeof solTokens>[0] } = { text: null, krw: 0, fail: "" };
  let finished = false;
  while (left() > 25_000) {
    const poll = await pollVisionBackground(resp.id, ctx.byokApiKey);
    if (poll.status === "running") {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    finished = true;
    if (poll.status === "error") ask.fail = poll.message;
    else {
      ask.text = poll.text;
      ask.usage = poll.usage;
      ask.krw = poll.usage ? (gradingEstKrw(poll.usage, poll.model) ?? 0) : 0;
    }
    break;
  }
  if (!finished) {
    if (Date.now() - Date.parse(resp.at) < TYPESET_MAX_MS) {
      await enqueueAutoStep(ctx.admin, ctx.userId, problemId, "fix", "자동 수정 (조판 응답 기다리는 중)");
      return { ok: true as const, saved: false, lastFail: "", krw: 0 };
    }
    await deleteVisionResponse(resp.id, ctx.byokApiKey, true);
    ask.fail = "sol 조판이 30분 넘게 끝나지 않음";
  } else await deleteVisionResponse(resp.id, ctx.byokApiKey, ask.fail !== "");
  await logSol(ctx, "sol 변형 조판 고치기", ask);
  const at = new Date().toISOString();
  const back = async (why: string) => {
    await setAuto(ctx, problemId, (b) => ({ ...b, variantAuto: { ...(st ?? { round: 0 }), status: "needs_approval", typesetResp: undefined, lastFail: why.slice(0, 400), at } }));
    return { ok: true as const, saved: false, lastFail: why, krw: ask.krw };
  };
  const obj = ask.text ? (parseJsonObject(ask.text) as { text?: unknown; figures?: unknown; new_answer?: unknown; solution?: unknown; unique?: unknown; why?: unknown } | null) : null;
  const text = obj && typeof obj.text === "string" ? obj.text.trim().slice(0, 8000) : "";
  if (!obj || text.length < 20) return back(`조판 글을 못 받음: ${ask.fail || "응답을 읽지 못함"}`);
  // sol 스스로 정답이 하나로 정해지지 않는다고 했으면 카드를 찍어 봐야 재검수에서 또 '판정 불가'다 — 찍지 않고 승인 대기로.
  if (obj.unique === false) return back(`sol 이 조판한 문제의 정답을 하나로 정하지 못함: ${s(obj.why, 300) || "이유 없음"}`);
  const figs: { id: string; svg: string }[] = [];
  for (const f of Array.isArray(obj.figures) ? (obj.figures as { id?: unknown; svg?: unknown }[]).slice(0, 6) : []) {
    const id = typeof f?.id === "string" && /^f\d{1,2}$/.test(f.id) ? f.id : "";
    const svg = cleanSvg(f?.svg);
    if (id && svg) figs.push({ id, svg });
  }
  const markers = [...text.matchAll(/\[\[FIG (f\d{1,2})\]\]/g)].map((m) => m[1]);
  const missing = markers.filter((m) => !figs.some((f) => f.id === m));
  if (missing.length) return back(`그림 ${missing.join(",")} 의 SVG 가 없거나 쓸 수 없음`);
  const { answer, type } = answerOf(s(obj.new_answer, 100));
  if (!answer) return back("새 정답을 못 받음");
  const solution = typeof obj.solution === "string" && obj.solution.trim() ? obj.solution.trim().slice(0, 6000) : curSol;
  await setAuto(
    ctx,
    problemId,
    (b) => ({
      ...b,
      solution,
      variantTypeset: { text, figures: figs, at },
      variantAuto: { ...(st ?? {}), round: (st?.round ?? 0) + 1, status: "rendering", baseImagePath: st?.baseImagePath ?? (prob.image_path as string), notes: undefined, lastFail: undefined, typesetResp: undefined, at },
    }),
    { answer, answer_type: type },
  );
  return { ok: true as const, saved: true, lastFail: "", krw: ask.krw };
}
