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
import { loadAsDataUrl, removeStored, runFigureGeneration, splitDataUrl, storeBytes } from "./figureRun";
import { figureImageModelIds } from "./figureImageGen";
import { compositePatch } from "./patchComposite";
import { cardUrl } from "./cardUrl";
import { imageTokens, logAiCost, solTokens } from "./costLog";
import { parseJsonObject } from "./problemCompare";
import { VARIANT_PROMPT, answerOf, parseVariantPlan, settingsTail } from "./variantPlan";

export type AutoNote = { problem: string; fix: string };
export type VariantAutoState = {
  status: "checking" | "needs_approval" | "fixing" | "passed" | "error";
  round: number;
  notes?: AutoNote[];
  message?: string;
  /** 직전 수정이 반영되지 않았을 때 그 이유(다음 수정 지시에 함께 넣는다). */
  lastFail?: string;
  solved?: string;
  at: string;
  /** 처음 상태(되돌리기용) — 통과하면 지운다. */
  baseImagePath?: string;
};

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
  `task: re-check a GENERATED VARIANT of a Korean exam question picture. ${hasOrig ? "image 1 = the ORIGINAL question, image 2 = the VARIANT." : "the only image = the VARIANT."} after the images you get the variant's registered answer and its solution. check, reading character by character: (1) broken, misspelled or missing glyphs/words/numbers/units in the stem, the <보기> box, the table and the labels; (2) all five choices ①–⑤ present, none left over from the original that contradicts the new problem, and exactly the registered answer is correct (solve the variant yourself and compare with the solution); (3) values/figure/table in the picture agree with the solution's numbers (a figure still showing the original's values is a defect); (4) leftover original wording that no longer fits. report only real, clearly visible defects — when in doubt, say nothing. for EACH problem give a concrete image-editor action. reply ONLY JSON: {"notes":[{"problem":"문제점(한국어, 어디가 어떻게)","fix":"그림 편집기에게 줄 구체적 행동 한 문장(한국어) — 반드시 '위치(예: <보기> ㄱ 둘째 줄) + 현재 글/값 → 바꿀 글/값' 꼴. 그림 편집으로 고칠 수 없는 것(문제 설계·난이도·함정이 안 된 것, 정답 값 자체가 틀린 것)이면 빈 문자열"}],"solved_answer":"푼 정답"}. never describe your reasoning in fix; empty notes if nothing is wrong.`;

export const FIXCHECK_PROMPT = `task: check a PARTIAL EDIT of a Korean exam question picture. image 1 = BEFORE, image 2 = AFTER. the edit instruction is given after the images. for EACH numbered item decide whether image 2 now matches the instruction (read the text carefully, character by character). STRICT RULES to avoid false alarms: mark done:false ONLY when you can SEE in image 2 that the requested change is clearly not there or is wrong; if an item cannot be verified from the picture at all treat it as done:true. list a collateral change ONLY when something clearly visible in image 1 (text, numbers, choices, figure parts, labels) is clearly missing, garbled or altered in image 2 and was NOT named in the instruction; tiny pixel differences, slight shifts and equivalent re-typesetting are NOT changes. when in doubt, say nothing. reply ONLY JSON: {"items":[{"item":"짧은 한국어 설명","done":true|false,"note":"안 됐으면 무엇이 어떻게 다른지(한국어)"}],"collateral":["의도하지 않은 변경(한국어)"]}`;

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
  const orig0 = design.length && typeof vo0.path === "string" && vo0.path ? await loadAsDataUrl(ctx.admin, vo0.path) : null;

  if (design.length && orig0) {
    // **설계가 잘못된 문제는 재설계 → 원본에서 새로 생성 → 재검수**(사용자 — "문제 자체가 잘못 설계된 경우 재설계 후 생성 후 검증").
    // 지금 그림 위에 덧칠하지 않는다: sol 이 원본을 보고 지적을 피한 변형을 처음부터 다시 설계하고, 원본을 그 계획대로 편집한다.
    // 반영 검사는 하지 않는다 — 곧바로 이어지는 재검수가 문제 전체를 본다.
    const curSol = typeof br.solution === "string" ? br.solution.slice(0, 2500) : "";
    const allNotes = notes.map((n, i) => `${i + 1}. ${n.problem}${n.fix ? ` (picture fix that was suggested: ${n.fix})` : ""}`).join("\n");
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
  } else if (fixes.length) {
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
  } else if (design.length) {
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
        ...(newPath && typeof newBox.solution === "string" ? { solution: newBox.solution } : {}),
        variantAuto: { ...(st ?? {}), round: (st?.round ?? 0) + 1, status: "checking", baseImagePath: basePath, lastFail: newPath ? undefined : lastFail || undefined, notes: undefined, at: new Date().toISOString() },
      };
    },
    newPath ? { image_path: newPath, ...update } : undefined,
  );
  // 중간 그림은 지운다(처음 상태는 통과할 때까지 남긴다).
  if (newPath && curPath !== basePath) await removeStored(ctx.admin, [curPath]);
  await enqueueAutoStep(ctx.admin, ctx.userId, problemId, "check", "자동 재검수");
  return { ok: true as const, saved: !!newPath, lastFail, krw };
}
