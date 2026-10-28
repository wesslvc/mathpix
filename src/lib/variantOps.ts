/**
 * **변형문제 후속 단계를 전부 OpenAI Batch 로**(2026-10-19, 사용자 — "변형문제 관련 모든 사항은 전부 batch로, 1차 수정정도는 이미지생성으로 돌리고
 * 2차부터는 sol이 부분적으로 svg생성시 더 이득일 부분만 생성해서 덮어, 검수는 med").
 *
 * 문제 하나에 대한 작업 하나 = `variant_ops` 한 줄. `step` 은 지금 batch 로 걸려야 할 단계다:
 *   check    sol(medium)이 원본·변형·정답·해설을 견준다 → 지적 없음 = 확정(passed), 있음 = 승인 대기(needs_approval)
 *   draw     1차 수정: sunburst 가 지적 사항만 부분 편집(`patchPrompt`) → 안 바뀐 곳은 지금 그림 픽셀 그대로(`compositePatch`) → check
 *   overlay  2차 이후: sol(high)이 "SVG 로 덮어 그리는 편이 더 믿을 만한 부분"만 골라 덮개를 설계 → 서버가 그려 덮는다(`svgOverlay.ts`) → check
 * 승인(approve)이 draw/overlay 를 만든다 — 승인 없이 수정이 돌지 않는다. 수정이 끝나면 같은 줄이 check 로 넘어가 재검수한다. 바퀴 수 제한은 없다.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { harvest } from "./gradeExam";
import { figureImageModelIds, patchPrompt, variantPrompt, pickOutputSize, readUsage, sniffImageMime } from "./figureImageGen";
import { loadAsDataUrl, removeStored, splitDataUrl, storeBytes } from "./figureRun";
import { compositePatch } from "./patchComposite";
import { cardUrl } from "./cardUrl";
import { logAiCost } from "./costLog";
import { parseJsonObject } from "./problemCompare";
import { toStoredFigures } from "./storedFigures";
import { RECHECK_PROMPT, readNotes, type AutoNote, type VariantAutoState } from "./variantAuto";
import { OVERLAY_PROMPT, applyOverlays, parseOverlays } from "./svgOverlay";
import { BATCH_DISCOUNT, CHUNK, createBatch, lineError, logSolCost, s, solBody, uploadJsonl, type OutLine } from "./variantBatchCore";
import sharp from "sharp";

export type OpStep = "check" | "draw" | "overlay";
export type Op = {
  id: string;
  user_id: string;
  problem_id: string;
  step: OpStep | "done" | "error";
  batch_id: string | null;
  state: { notes?: AutoNote[]; lastFail?: string; tries?: number; quality?: string; mode?: "regen" | "patch" };
  cost_krw: number;
};
type Prob = { id: string; image_path: string | null; answer: string | null; box_range: Record<string, unknown> };
const COLS = "id,user_id,problem_id,step,batch_id,state,cost_krw";

const RECHECK_EFFORT = () => process.env.VARIANT_RECHECK_EFFORT?.trim() || "medium";
const OVERLAY_EFFORT = () => process.env.VARIANT_OVERLAY_EFFORT?.trim() || "high";
/** 일시적인 OpenAI 오류(과부하 503·429·5xx 등)는 승인 없이 서버가 알아서 다시 건다 — 이 횟수까지. */
const MAX_TRANSIENT_RETRIES = () => {
  const n = Number(process.env.VARIANT_OP_RETRIES);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 6;
};
const isTransient = (msg: string) => /\b(429|5\d\d)\b|overload|rate.?limit|try again|temporar|timed? ?out|capacity|unavailable/i.test(msg);
const FIX_QUALITY = () => {
  const q = process.env.VARIANT_FIX_QUALITY?.trim() || "medium";
  return ["low", "medium", "high"].includes(q) ? q : "medium";
};

type Cache = { probs: Map<string, Promise<Prob | null>>; imgs: Map<string, Promise<string | null>> };
const newCache = (): Cache => ({ probs: new Map(), imgs: new Map() });
function probOf(admin: SupabaseClient, c: Cache, userId: string, id: string) {
  let p = c.probs.get(id);
  if (!p) {
    p = (async () => {
      const { data } = await admin.from("problems").select("id,image_path,answer,box_range").eq("id", id).eq("user_id", userId).maybeSingle();
      return data ? ({ ...data, box_range: ((data.box_range ?? {}) as Record<string, unknown>) || {} } as Prob) : null;
    })();
    c.probs.set(id, p);
  }
  return p;
}
function imgOf(admin: SupabaseClient, c: Cache, path: string) {
  let p = c.imgs.get(path);
  if (!p) {
    p = loadAsDataUrl(admin, path);
    c.imgs.set(path, p);
  }
  return p;
}

const autoOf = (br: Record<string, unknown>) => br.variantAuto as VariantAutoState | undefined;
const numbered = (notes: AutoNote[]) => notes.map((n, i) => `${i + 1}. ${n.fix || n.problem}`).join("\n");

async function setAuto(admin: SupabaseClient, userId: string, problemId: string, fn: (br: Record<string, unknown>) => Record<string, unknown>) {
  const { data } = await admin.from("problems").select("box_range").eq("id", problemId).eq("user_id", userId).maybeSingle();
  if (!data) return;
  const br = ((data.box_range ?? {}) as Record<string, unknown>) || {};
  await admin.from("problems").update({ box_range: fn(br) }).eq("id", problemId).eq("user_id", userId);
}

/** 작업을 오류로 닫고 문제의 상태를 되돌린다: 수정 단계였으면 지적을 살려 승인 대기로, 재검수였으면 오류로. */
async function failOp(admin: SupabaseClient, op: Op, message: string) {
  await admin.from("variant_ops").update({ step: "error", error: message.slice(0, 500), batch_id: null, updated_at: new Date().toISOString() }).eq("id", op.id);
  const at = new Date().toISOString();
  await setAuto(admin, op.user_id, op.problem_id, (br) => {
    const prev = autoOf(br);
    const notes = op.state.notes;
    return {
      ...br,
      variantAuto: notes?.length
        ? { ...(prev ?? { round: 0 }), status: "needs_approval", notes, lastFail: message.slice(0, 300), at }
        : { ...(prev ?? { round: 0 }), status: "error", message: message.slice(0, 300), at },
    };
  });
}

/** 줄 하나 만들기. */
async function buildLine(admin: SupabaseClient, op: Op, c: Cache): Promise<{ url: string; body: Record<string, unknown> } | { error: string }> {
  const prob = await probOf(admin, c, op.user_id, op.problem_id);
  if (!prob?.image_path) return { error: "문제를 찾지 못했어요." };
  const cur = await imgOf(admin, c, prob.image_path);
  if (!cur) return { error: "문제 그림을 읽지 못했어요." };
  const br = prob.box_range;
  const vo = (br.variantOf ?? {}) as { path?: string; planEdits?: string };
  const orig = typeof vo.path === "string" && vo.path ? await imgOf(admin, c, vo.path) : null;
  const sol = typeof br.solution === "string" ? br.solution.slice(0, 3000) : "";
  const reg = `\n\nREGISTERED ANSWER: ${String(prob.answer ?? "")}\nSOLUTION\n${sol}`;
  const notes = op.state.notes ?? [];
  const failNote = op.state.lastFail ? `\nPREVIOUS ATTEMPT FAILED: ${op.state.lastFail}` : "";

  if (op.step === "check") {
    return { url: "/v1/responses", body: solBody(RECHECK_PROMPT(!!orig), orig ? [orig, cur] : [cur], reg, RECHECK_EFFORT()) };
  }
  if (op.step === "draw") {
    if (!notes.length) return { error: "고칠 지적이 없어요." };
    const model = figureImageModelIds()[0];
    if (!model) return { error: "그림 모델이 없어요." };
    const quality = ["low", "medium", "high"].includes(String(op.state.quality)) ? String(op.state.quality) : FIX_QUALITY();
    const planEdits = typeof (vo as { planEdits?: string }).planEdits === "string" ? (vo as { planEdits?: string }).planEdits! : "";
    if (op.state.mode === "regen" && orig && planEdits) {
      // 완전 새로 만들기: 원본 + 설계 편집 지시 + 앞 시도의 지적(되풀이하지 말 것)
      const oparts = splitDataUrl(orig);
      const ometa = oparts ? await sharp(oparts.bytes).metadata() : null;
      return {
        url: "/v1/images/edits",
        body: {
          model,
          images: [{ image_url: orig }],
          prompt: variantPrompt(`${planEdits}\n\nA PREVIOUS ATTEMPT OF THIS SAME EDIT HAD THESE DEFECTS — do them right this time:\n${numbered(notes)}${failNote}`),
          n: 1,
          size: pickOutputSize(ometa?.width, ometa?.height) ?? "auto",
          quality,
          output_format: "jpeg",
          output_compression: 90,
        },
      };
    }
    const parts = splitDataUrl(cur);
    const meta = parts ? await sharp(parts.bytes).metadata() : null;
    return {
      url: "/v1/images/edits",
      body: {
        model,
        images: [{ image_url: cur }],
        prompt: patchPrompt(numbered(notes) + failNote, true),
        n: 1,
        size: pickOutputSize(meta?.width, meta?.height) ?? "auto",
        quality,
        output_format: "jpeg",
        output_compression: 90,
      },
    };
  }
  if (op.step === "overlay") {
    if (!notes.length) return { error: "고칠 지적이 없어요." };
    const parts = splitDataUrl(cur);
    const meta = parts ? await sharp(parts.bytes).metadata() : null;
    const tail = `\n\nIMAGE SIZE: ${meta?.width ?? "?"}x${meta?.height ?? "?"} px${reg}\nREMAINING PROBLEMS\n${notes.map((n, i) => `${i + 1}. ${n.problem}${n.fix ? ` (fix hint: ${n.fix})` : ""}`).join("\n")}${failNote}`;
    return { url: "/v1/responses", body: solBody(OVERLAY_PROMPT(!!orig), orig ? [orig, cur] : [cur], tail, OVERLAY_EFFORT()) };
  }
  return { error: "알 수 없는 단계" };
}

/** batch_id 가 빈 작업을 단계별로 모아 건다. */
export async function submitOps(admin: SupabaseClient, deadline: number): Promise<number> {
  let submitted = 0;
  const cache = newCache();
  for (const step of ["check", "draw", "overlay"] as OpStep[]) {
    for (;;) {
      if (Date.now() > deadline) return submitted;
      const { data } = await admin.from("variant_ops").select(COLS).eq("step", step).is("batch_id", null).order("created_at").limit(CHUNK);
      const ops = (data ?? []) as Op[];
      if (!ops.length) break;
      const mine = ops.filter((o) => o.user_id === ops[0].user_id);
      const endpoint = step === "draw" ? "/v1/images/edits" : "/v1/responses";
      const lines: string[] = [];
      const ok: Op[] = [];
      for (const op of mine) {
        const built = await buildLine(admin, op, cache);
        if ("error" in built) {
          await failOp(admin, op, built.error);
          continue;
        }
        lines.push(JSON.stringify({ custom_id: op.id, method: "POST", url: built.url, body: built.body }));
        ok.push(op);
      }
      if (!ok.length) continue;
      try {
        const fileId = await uploadJsonl(lines.join("\n"));
        const batchId = await createBatch(fileId, endpoint);
        await admin.from("openai_batches").insert({ id: batchId, user_id: ok[0].user_id, stage: `op:${step}`, status: "submitted", item_count: ok.length });
        await admin.from("variant_ops").update({ batch_id: batchId, updated_at: new Date().toISOString() }).in("id", ok.map((x) => x.id));
        submitted++;
      } catch (err) {
        console.warn(`[variant-ops] ${step} batch 걸기 실패:`, err instanceof Error ? err.message : err);
        await admin.from("variant_ops").update({ updated_at: new Date().toISOString(), error: err instanceof Error ? err.message.slice(0, 300) : "batch 걸기 실패" }).in("id", ok.map((x) => x.id));
        return submitted;
      }
    }
  }
  return submitted;
}

/** 수정 결과 그림을 문제에 올리고(이전 중간 그림은 지운다) 재검수 상태로 넘긴다. */
async function adoptImage(admin: SupabaseClient, op: Op, prob: Prob, bytes: Buffer, mime: string, patchBr?: Record<string, unknown>) {
  const ext = mime.includes("jpeg") ? "jpg" : "png";
  const userId = op.user_id;
  const { data: cat } = await admin.from("problems").select("category_id").eq("id", prob.id).maybeSingle();
  const path = `${userId}/${cat?.category_id ?? "variants"}/${crypto.randomUUID()}.${ext}`;
  if (!(await storeBytes(admin, path, bytes, mime))) return false;
  const old = prob.image_path as string;
  const at = new Date().toISOString();
  const prev = autoOf(prob.box_range);
  const base = prev?.baseImagePath ?? old;
  const vo = (prob.box_range.variantOf ?? {}) as { path?: string };
  await admin
    .from("problems")
    .update({
      image_path: path,
      box_range: {
        ...prob.box_range,
        ...(patchBr ?? {}),
        figures: toStoredFigures([{ id: crypto.randomUUID(), markup: `<img src="${cardUrl(path)}" alt="" />`, layout: { scale: 100, offsetX: 0, offsetY: 0 }, position: 0 }]),
        variantAuto: { status: "checking", round: (prev?.round ?? 0) + 1, baseImagePath: base, at },
      },
    })
    .eq("id", prob.id)
    .eq("user_id", userId);
  // 처음 상태(되돌리기용)와 원본은 남기고, 그 사이의 중간 그림만 지운다.
  if (old !== base && old !== vo.path) await removeStored(admin, [old]);
  return true;
}

async function handleCheck(admin: SupabaseClient, op: Op, body: Record<string, unknown>, prob: Prob, krw: number) {
  const obj = parseJsonObject(harvest(body)) as { notes?: unknown; solved_answer?: unknown } | null;
  const prev = autoOf(prob.box_range);
  const round = prev?.round ?? 0;
  const at = new Date().toISOString();
  if (!obj) return failOp(admin, { ...op, state: {} }, "재검수 결과를 읽지 못했어요.");
  const notes = readNotes(obj.notes);
  const solved = s(obj.solved_answer, 60);
  if (notes.length === 0) {
    const keep = prob.image_path as string;
    const old = [prev?.baseImagePath, (prob.box_range.variantFix as { prevImagePath?: string } | undefined)?.prevImagePath].filter((p): p is string => !!p && p !== keep);
    await setAuto(admin, op.user_id, op.problem_id, (br) => ({
      ...br,
      variantFix: undefined,
      variantRecheck: undefined,
      variantReview: undefined,
      ...(old.length ? { preTypeset: undefined } : {}),
      variantAuto: { status: "passed", round, solved, at },
    }));
    if (old.length) await removeStored(admin, old);
  } else {
    await setAuto(admin, op.user_id, op.problem_id, (br) => ({
      ...br,
      variantAuto: { status: "needs_approval", round, notes, solved, at, ...(prev?.lastFail ? { lastFail: prev.lastFail } : {}), baseImagePath: prev?.baseImagePath ?? (prob.image_path as string) },
    }));
  }
  await admin.from("variant_ops").update({ step: "done", batch_id: null, cost_krw: op.cost_krw + krw, error: null, updated_at: at }).eq("id", op.id);
}

/** 수정이 반영됐으니 같은 줄을 재검수 단계로 넘긴다. */
const toCheck = (admin: SupabaseClient, op: Op, krw: number) =>
  admin.from("variant_ops").update({ step: "check", batch_id: null, state: {}, cost_krw: op.cost_krw + krw, error: null, updated_at: new Date().toISOString() }).eq("id", op.id);

async function handleDraw(admin: SupabaseClient, op: Op, body: Record<string, unknown>, prob: Prob, c: Cache) {
  const usage = readUsage(body.usage as Parameters<typeof readUsage>[0]);
  const krw = (usage?.estKrw ?? 0) * BATCH_DISCOUNT;
  if (usage && krw > 0) {
    await logAiCost(admin, { userId: op.user_id, jobId: op.id, kind: "problem", what: "그림 변형 1차 수정 (batch)", krw, usd: usage.estUsd * BATCH_DISCOUNT, tokens: { input: usage.inputText + usage.inputImage, cached: usage.cached, output: usage.output } });
  }
  const b64 = (body.data as { b64_json?: string }[] | undefined)?.[0]?.b64_json;
  if (!b64) return failOp(admin, op, "그림 결과가 비어 있어요.");
  let bytes: Buffer = Buffer.from(b64, "base64");
  let mime = sniffImageMime(b64);
  const regen = op.state.mode === "regen";
  if (!regen) try {
    const curUrl = await imgOf(admin, c, prob.image_path as string);
    const parts = curUrl ? splitDataUrl(curUrl) : null;
    const comp = parts ? await compositePatch(parts.bytes, bytes) : null;
    if (comp) {
      bytes = comp.bytes;
      mime = comp.mime;
    }
  } catch {
    /* 합성 실패 — 편집 결과 그대로 */
  }
  if (!(await adoptImage(admin, op, prob, bytes, mime, regen ? { variantOf: { ...((prob.box_range.variantOf ?? {}) as object), regen: true } } : undefined))) return failOp(admin, op, "수정한 그림을 저장하지 못했어요.");
  await toCheck(admin, op, krw);
}

async function handleOverlay(admin: SupabaseClient, op: Op, body: Record<string, unknown>, prob: Prob, c: Cache, krw: number) {
  const obj = parseJsonObject(harvest(body)) as { overlays?: unknown; solution?: unknown; skipped?: unknown } | null;
  if (!obj) return failOp(admin, op, "덮개 설계를 읽지 못했어요.");
  const { overlays, dropped } = parseOverlays(obj.overlays);
  const skipped = s(obj.skipped, 300);
  if (!overlays.length) return failOp(admin, op, `sol 이 덮어 그릴 곳을 못 찾았어요.${skipped ? ` (${skipped})` : ""}${dropped.length ? ` ${dropped.join(" ")}` : ""}`.slice(0, 480));
  const curUrl = await imgOf(admin, c, prob.image_path as string);
  const parts = curUrl ? splitDataUrl(curUrl) : null;
  if (!parts) return failOp(admin, op, "지금 그림을 읽지 못했어요.");
  const res = await applyOverlays(parts.bytes, overlays);
  if (!res) return failOp(admin, op, `덮개를 그리지 못했어요. ${dropped.join(" ")}`.slice(0, 480));
  const sol = typeof obj.solution === "string" && obj.solution.trim().length > 20 ? obj.solution.trim().slice(0, 4000) : null;
  if (!(await adoptImage(admin, op, prob, res.bytes, res.mime, sol ? { solution: sol } : undefined))) return failOp(admin, op, "수정한 그림을 저장하지 못했어요.");
  await toCheck(admin, op, krw);
  // 글꼴에 없어 못 그린 글자가 있으면 다음 재검수가 알아채도록 기록한다(승인 대기 화면의 안내용).
  if (res.missingGlyphs.length || res.failed.length) {
    console.warn("[variant-ops] 덮개 일부 못 그림:", res.missingGlyphs.join(""), res.failed.join(" "));
  }
}

/** 끝난 batch 의 결과 줄들을 작업마다 처리한다. */
export async function handleOpBatch(admin: SupabaseClient, batchId: string, status: string, byId: Map<string, OutLine>) {
  const { data } = await admin.from("variant_ops").select(COLS).eq("batch_id", batchId);
  const cache = newCache();
  for (const op of (data ?? []) as Op[]) {
    try {
      const line = byId.get(op.id);
      const err = status !== "completed" && !line ? `batch 가 ${status} 로 끝났어요.` : lineError(line);
      if (err) {
        // 과부하 같은 일시 오류는 승인을 다시 받지 않고 같은 단계를 서버가 알아서 다시 건다(같은 batch_id 를 비우면 다음 poll 이 새 batch 로 건다).
        const tries = op.state.tries ?? 0;
        if ((isTransient(err) || status === "expired") && tries < MAX_TRANSIENT_RETRIES()) {
          console.warn(`[variant-ops] ${op.step} 일시 오류 — ${tries + 1}번째 재시도:`, err.slice(0, 160));
          await admin
            .from("variant_ops")
            .update({ batch_id: null, state: { ...op.state, tries: tries + 1 }, error: `일시 오류로 다시 시도 중(${tries + 1}): ${err}`.slice(0, 500), updated_at: new Date().toISOString() })
            .eq("id", op.id);
          continue;
        }
        await failOp(admin, op, `${op.step} 단계 실패: ${err}${tries ? ` (${tries}번 다시 시도함)` : ""}`);
        continue;
      }
      const prob = await probOf(admin, cache, op.user_id, op.problem_id);
      if (!prob?.image_path) {
        await admin.from("variant_ops").update({ step: "error", error: "문제를 찾지 못했어요.", batch_id: null }).eq("id", op.id);
        continue;
      }
      const body = (line!.response!.body ?? {}) as Record<string, unknown>;
      if (op.step === "draw") {
        await handleDraw(admin, op, body, prob, cache);
      } else {
        const what = op.step === "check" ? "sol 변형 재검수 (batch)" : "sol 변형 SVG 덮개 설계 (batch)";
        const krw = await logSolCost(admin, { userId: op.user_id, jobId: op.id }, what, body);
        if (op.step === "check") await handleCheck(admin, op, body, prob, krw);
        else await handleOverlay(admin, op, body, prob, cache, krw);
      }
    } catch (err) {
      await failOp(admin, op, err instanceof Error ? err.message : "처리 실패").catch(() => undefined);
    }
  }
}

/** 작업 만들기(라우트·최초 생성이 쓴다). 같은 문제에 끝나지 않은 작업이 있으면 만들지 않는다. */
export async function enqueueOp(admin: SupabaseClient, userId: string, problemId: string, step: OpStep, state: Op["state"] = {}): Promise<boolean> {
  const { data: open } = await admin.from("variant_ops").select("id").eq("problem_id", problemId).in("step", ["check", "draw", "overlay"]).limit(1);
  if (open?.length) return false;
  const { error } = await admin.from("variant_ops").insert({ user_id: userId, problem_id: problemId, step, state });
  return !error;
}
