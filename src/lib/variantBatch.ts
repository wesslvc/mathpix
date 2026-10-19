/**
 * **변형문제 최초 생성을 OpenAI Batch API 로**(2026-10-19, 사용자 — "최초 변형생성은 batch 이용해서 만들자").
 *
 * Batch 는 같은 요청을 **반값**에 받는 대신 결과가 최대 24시간 뒤에 온다(보통 몇 분~몇십 분). 변형 하나 = `variant_batch_items` 한 줄,
 * 단계마다 여러 줄을 모아 batch 하나로 건다:
 *   plan    sol 이 문제를 풀고 변형을 설계한다(`VARIANT_PROMPT`, /v1/responses)
 *   image   sunburst 가 원본을 편집해 변형 그림을 만든다(/v1/images/edits, JSON 몸통 — 2026-10-19 프로브로 받는 것 확인)
 *   review  sol 이 원본·변형·정답·해설을 견준다(자동 검수의 `RECHECK_PROMPT`, 강도 high)
 *   done    문제로 저장. 검수 결과로 `variantAuto` 를 바로 정한다(통과 = 확정, 지적 = 승인 대기 → 자동 검수 흐름이 이어 받는다).
 *
 * pg_cron 이 1분마다 `/api/variant-batch/poll` 을 깨우면 `pollBatches`(끝난 batch 처리) → `submitReady`(다음 단계 걸기)가 돈다.
 * 원가는 실시간 단가의 절반으로 장부에 적는다.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { OPENAI_TEXT_MODEL, harvest } from "./gradeExam";
import { figureImageModelIds, patchPrompt, pickOutputSize, readUsage, sniffImageMime, variantPrompt } from "./figureImageGen";
import { loadAsDataUrl, removeStored, splitDataUrl, storeBytes } from "./figureRun";
import { compositePatch } from "./patchComposite";
import { cardUrl } from "./cardUrl";
import { logAiCost } from "./costLog";
import { gradingEstKrw } from "./tokens";
import { VARIANT_PROMPT, answerOf, parseVariantPlan, readLevel, readNovelty, settingsTail, type VariantPlan } from "./variantPlan";
import { RECHECK_PROMPT, readNotes } from "./variantAuto";
import { parseJsonObject } from "./problemCompare";
import { cleanAnswerText } from "./variantOf";
import { toStoredFigures } from "./storedFigures";
import { DEFAULT_FONT_PT } from "./fontSize";

const OPENAI = "https://api.openai.com/v1";
/** 한 batch 에 담는 줄 수 — 그림 단계 결과(줄마다 그림 1장)를 한 번에 받아 처리할 수 있는 크기. */
const CHUNK = 20;
const BATCH_DISCOUNT = 0.5;
const TERMINAL = new Set(["completed", "failed", "expired", "cancelled"]);

export type BatchStage = "plan" | "image" | "review";
type Item = {
  id: string;
  user_id: string;
  group_id: string;
  category_id: string;
  src_path: string;
  params: Record<string, unknown>;
  stage: BatchStage | "done" | "error";
  batch_id: string | null;
  plan: VariantPlan | null;
  draft_path: string | null;
  cost_krw: number;
};

const key = () => {
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new Error("OPENAI_API_KEY 가 없어요.");
  return k;
};
const s = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** 원본을 `_origins/` 에 한 번 둔다(같은 원본의 변형들이 나눠 쓰고, 내보내기의 "원본" 그림도 이것이다). */
export function originPathFor(userId: string, srcKey: string) {
  return `${userId}/_origins/${createHash("sha1").update(srcKey).digest("hex").slice(0, 24)}.jpg`;
}

async function uploadJsonl(text: string): Promise<string> {
  const form = new FormData();
  form.append("purpose", "batch");
  form.append("file", new Blob([text], { type: "application/jsonl" }), "variant.jsonl");
  const res = await fetch(`${OPENAI}/files`, { method: "POST", headers: { Authorization: `Bearer ${key()}` }, body: form });
  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (!res.ok || !body.id) throw new Error(`batch 파일을 올리지 못했어요 (HTTP ${res.status}) ${body.error?.message ?? ""}`);
  return body.id;
}

async function createBatch(fileId: string, endpoint: string): Promise<string> {
  const res = await fetch(`${OPENAI}/batches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input_file_id: fileId, endpoint, completion_window: "24h" }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (!res.ok || !body.id) throw new Error(`batch 를 걸지 못했어요 (HTTP ${res.status}) ${body.error?.message ?? ""}`);
  return body.id;
}

function solBody(prompt: string, images: string[], tail: string, effort: string) {
  return {
    model: OPENAI_TEXT_MODEL,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          ...images.map((url) => ({ type: "input_image", image_url: url, detail: "high" })),
          { type: "input_text", text: tail },
        ],
      },
    ],
    text: { format: { type: "json_object" } },
    reasoning: { effort },
  };
}

/** 한 번 부를 동안 같은 원본을 R2 에서 여러 번 읽지 않게 들고 있는다(같은 원본의 변형이 여럿이다). */
type SrcCache = Map<string, Promise<string | null>>;
function srcOf(admin: SupabaseClient, cache: SrcCache, path: string) {
  let p = cache.get(path);
  if (!p) {
    p = loadAsDataUrl(admin, path);
    cache.set(path, p);
  }
  return p;
}

/** 줄 하나 만들기. 실패(그림을 못 읽음 등)면 null — 그 변형은 오류로 돌린다. */
async function buildLine(admin: SupabaseClient, it: Item, cache: SrcCache): Promise<{ body: Record<string, unknown> } | { error: string }> {
  const src = await srcOf(admin, cache, it.src_path);
  if (!src) return { error: "원본 그림을 읽지 못했어요." };
  const p = it.params;
  if (it.stage === "plan") {
    const copies = Math.min(25, Math.max(1, Math.round(Number(p.copies) || 1)));
    const copy = Math.min(copies, Math.max(1, Math.round(Number(p.copy) || 1)));
    const effort = ["low", "medium", "high"].includes(String(p.effort)) ? String(p.effort) : "medium";
    return { body: solBody(VARIANT_PROMPT, [src], settingsTail(readLevel(p.level), readNovelty(p.novelty), copy, copies), effort) };
  }
  if (it.stage === "image") {
    const plan = it.plan;
    if (!plan) return { error: "설계가 없어요." };
    const model = figureImageModelIds()[0];
    if (!model) return { error: "그림 모델이 없어요." };
    const q = String(p.quality ?? "");
    const quality = ["low", "medium", "high"].includes(q) ? q : process.env.VARIANT_IMAGE_QUALITY || "medium";
    return {
      body: {
        model,
        images: [{ image_url: src }],
        prompt: plan.kind === "concept" ? variantPrompt(plan.edits) : patchPrompt(plan.edits, true),
        n: 1,
        size: pickOutputSize(Number(p.width) || undefined, Number(p.height) || undefined) ?? "auto",
        quality,
        output_format: "jpeg",
        output_compression: 90,
      },
    };
  }
  if (it.stage === "review") {
    if (!it.draft_path) return { error: "변형 그림이 없어요." };
    const draft = await loadAsDataUrl(admin, it.draft_path);
    if (!draft) return { error: "변형 그림을 읽지 못했어요." };
    const effort = process.env.VARIANT_RECHECK_EFFORT?.trim() || "high";
    return {
      body: solBody(RECHECK_PROMPT(true), [src, draft], `\n\nREGISTERED ANSWER: ${s(it.plan?.newAnswer, 100)}\nSOLUTION\n${s(it.plan?.solution, 3000)}`, effort),
    };
  }
  return { error: "알 수 없는 단계" };
}

async function failItems(admin: SupabaseClient, ids: string[], error: string, drafts: (string | null)[] = []) {
  if (!ids.length) return;
  await admin.from("variant_batch_items").update({ stage: "error", error: error.slice(0, 500), batch_id: null, updated_at: new Date().toISOString() }).in("id", ids);
  const d = drafts.filter((x): x is string => !!x);
  if (d.length) await removeStored(admin, d);
}

/** batch 를 기다리지 않는(=batch_id 가 빈) plan/image/review 줄을 모아 단계별로 건다. */
export async function submitReady(admin: SupabaseClient, deadline: number): Promise<number> {
  let submitted = 0;
  const cache: SrcCache = new Map();
  for (const stage of ["plan", "image", "review"] as BatchStage[]) {
    for (;;) {
      if (Date.now() > deadline) return submitted;
      const { data } = await admin
        .from("variant_batch_items")
        .select("id,user_id,group_id,category_id,src_path,params,stage,batch_id,plan,draft_path,cost_krw")
        .eq("stage", stage)
        .is("batch_id", null)
        .order("created_at")
        .limit(CHUNK);
      const items = (data ?? []) as Item[];
      if (!items.length) break;
      // 사람이 섞이지 않게 첫 줄의 사람 것만 한 batch 에 담는다(장부·소유를 단순하게).
      const mine = items.filter((x) => x.user_id === items[0].user_id);
      const lines: string[] = [];
      const ok: Item[] = [];
      for (const it of mine) {
        const built = await buildLine(admin, it, cache);
        if ("error" in built) {
          await failItems(admin, [it.id], built.error, [it.draft_path]);
          continue;
        }
        lines.push(JSON.stringify({ custom_id: it.id, method: "POST", url: stage === "image" ? "/v1/images/edits" : "/v1/responses", body: built.body }));
        ok.push(it);
      }
      if (!ok.length) continue;
      try {
        const fileId = await uploadJsonl(lines.join("\n"));
        const batchId = await createBatch(fileId, stage === "image" ? "/v1/images/edits" : "/v1/responses");
        await admin.from("openai_batches").insert({ id: batchId, user_id: ok[0].user_id, stage, status: "submitted", item_count: ok.length });
        await admin.from("variant_batch_items").update({ batch_id: batchId, updated_at: new Date().toISOString() }).in("id", ok.map((x) => x.id));
        submitted++;
      } catch (err) {
        // 거는 데 실패하면 다음 깨움에서 다시 시도하도록 둔다(batch_id 가 비어 있다). 같은 오류가 되풀이되면 updated_at 으로 1분 간격이 생긴다.
        console.warn(`[variant-batch] ${stage} batch 걸기 실패:`, err instanceof Error ? err.message : err);
        await admin.from("variant_batch_items").update({ updated_at: new Date().toISOString(), error: err instanceof Error ? err.message.slice(0, 300) : "batch 걸기 실패" }).in("id", ok.map((x) => x.id));
        return submitted;
      }
    }
  }
  return submitted;
}

type OutLine = { custom_id?: string; response?: { status_code?: number; body?: Record<string, unknown> } | null; error?: { message?: string } | null };

async function readFile(fileId: unknown): Promise<OutLine[]> {
  if (typeof fileId !== "string") return [];
  const res = await fetch(`${OPENAI}/files/${encodeURIComponent(fileId)}/content`, { headers: { Authorization: `Bearer ${key()}` } });
  if (!res.ok) throw new Error(`batch 결과를 받지 못했어요 (HTTP ${res.status})`);
  const out: OutLine[] = [];
  for (const l of (await res.text()).split("\n")) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l) as OutLine);
    } catch {
      /* 깨진 줄은 건너뛴다 */
    }
  }
  return out;
}

function lineError(line: OutLine | undefined): string | null {
  if (!line) return "batch 결과에 이 줄이 없어요.";
  if (line.error) return line.error.message ?? "실패";
  const code = line.response?.status_code ?? 0;
  if (code !== 200) {
    const m = (line.response?.body?.error as { message?: string } | undefined)?.message;
    return `HTTP ${code} ${m ?? ""}`.trim();
  }
  return null;
}

function solUsage(body: Record<string, unknown>) {
  const u = body.usage as { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } | undefined;
  if (!u) return undefined;
  return { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cachedInputTokens: u.input_tokens_details?.cached_tokens ?? 0 };
}

async function logSolCost(admin: SupabaseClient, it: Item, what: string, body: Record<string, unknown>) {
  const usage = solUsage(body);
  const krw = usage ? (gradingEstKrw(usage, String(body.model ?? OPENAI_TEXT_MODEL)) ?? 0) * BATCH_DISCOUNT : 0;
  if (krw > 0) {
    await logAiCost(admin, { userId: it.user_id, jobId: it.id, kind: "problem", what, krw, tokens: usage ? { input: usage.inputTokens, cached: usage.cachedInputTokens, output: usage.outputTokens } : undefined });
  }
  return krw;
}

/** 단계 하나가 끝난 변형 한 줄을 처리한다. */
async function handleLine(admin: SupabaseClient, it: Item, line: OutLine | undefined, cache: SrcCache) {
  const err = lineError(line);
  if (err) return failItems(admin, [it.id], `${it.stage} 단계 실패: ${err}`, [it.draft_path]);
  const body = (line!.response!.body ?? {}) as Record<string, unknown>;
  const now = new Date().toISOString();

  if (it.stage === "plan") {
    const krw = await logSolCost(admin, it, "sol 변형 설계 (batch)", body);
    let plan: VariantPlan;
    try {
      plan = parseVariantPlan(harvest(body));
    } catch (e) {
      return failItems(admin, [it.id], e instanceof Error ? e.message : "설계를 읽지 못했어요.");
    }
    await admin.from("variant_batch_items").update({ stage: "image", plan, batch_id: null, cost_krw: it.cost_krw + krw, error: null, updated_at: now }).eq("id", it.id);
    return;
  }

  if (it.stage === "image") {
    const usage = readUsage(body.usage as Parameters<typeof readUsage>[0]);
    const krw = (usage?.estKrw ?? 0) * BATCH_DISCOUNT;
    if (usage && krw > 0) {
      await logAiCost(admin, { userId: it.user_id, jobId: it.id, kind: "problem", what: "그림 변형 (batch)", krw, usd: usage.estUsd * BATCH_DISCOUNT, tokens: { input: usage.inputText + usage.inputImage, cached: usage.cached, output: usage.output } });
    }
    const b64 = (body.data as { b64_json?: string }[] | undefined)?.[0]?.b64_json;
    if (!b64) return failItems(admin, [it.id], "그림 결과가 비어 있어요.");
    let bytes: Buffer = Buffer.from(b64, "base64");
    let mime = sniffImageMime(b64);
    if (it.plan?.kind !== "concept") {
      try {
        const srcUrl = await srcOf(admin, cache, it.src_path);
        const srcParts = srcUrl ? splitDataUrl(srcUrl) : null;
        const comp = srcParts ? await compositePatch(srcParts.bytes, bytes) : null;
        if (comp) {
          bytes = comp.bytes;
          mime = comp.mime;
        }
      } catch {
        /* 합성 실패 — 편집 결과 그대로 */
      }
    }
    const ext = mime.includes("jpeg") ? "jpg" : "png";
    const path = `${it.user_id}/${it.category_id}/${crypto.randomUUID()}.${ext}`;
    if (!(await storeBytes(admin, path, bytes, mime))) return failItems(admin, [it.id], "그림을 저장하지 못했어요.");
    await admin.from("variant_batch_items").update({ stage: "review", draft_path: path, batch_id: null, cost_krw: it.cost_krw + krw, error: null, updated_at: now }).eq("id", it.id);
    return;
  }

  if (it.stage === "review") {
    const krw = await logSolCost(admin, it, "sol 변형 자동 재검수 (batch)", body);
    const obj = parseJsonObject(harvest(body)) as { notes?: unknown; solved_answer?: unknown } | null;
    const notes = obj ? readNotes(obj.notes) : null;
    await saveProblem(admin, it, notes, s(obj?.solved_answer, 60), krw);
  }
}

/** 검수까지 끝난 변형을 문제로 저장한다. notes 가 null 이면 검수를 못 읽은 것 — 실시간 자동 재검수로 넘긴다. */
async function saveProblem(admin: SupabaseClient, it: Item, notes: ReturnType<typeof readNotes> | null, solved: string, krw: number) {
  const plan = it.plan!;
  const path = it.draft_path!;
  const { data: maxRow } = await admin
    .from("problems")
    .select("sort_order")
    .eq("category_id", it.category_id)
    .order("sort_order", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  const p = it.params;
  const no = Number(p.no);
  const { answer, type } = answerOf(plan.newAnswer);
  const at = new Date().toISOString();
  const variantAuto =
    notes === null
      ? { status: "checking", round: 0, at }
      : notes.length === 0
        ? { status: "passed", round: 0, solved, at, message: "제작 검수 통과 (batch)" }
        : { status: "needs_approval", round: 0, notes, solved, at, baseImagePath: path };
  const srcKey = s(p.srcKey, 200);
  const { data: row, error } = await admin
    .from("problems")
    .insert({
      category_id: it.category_id,
      user_id: it.user_id,
      image_path: path,
      latex: null,
      text_content: null,
      answer,
      answer_type: type,
      sort_order: (maxRow?.sort_order ?? 0) + 1,
      box_range: {
        ranges: null,
        fontPt: DEFAULT_FONT_PT,
        figures: toStoredFigures([{ id: crypto.randomUUID(), markup: `<img src="${cardUrl(path)}" alt="" />`, layout: { scale: 100, offsetX: 0, offsetY: 0 }, position: 0 }]),
        ...(plan.solution ? { solution: plan.solution } : {}),
        ...(srcKey
          ? {
              variantOf: {
                key: srcKey,
                label: s(p.srcLabel, 120),
                path: it.src_path,
                ...(Number.isFinite(no) && no > 0 ? { no } : {}),
                ...(plan.originalAnswer ? { answer: cleanAnswerText(String(plan.originalAnswer)) } : {}),
              },
            }
          : {}),
        variantAuto,
      },
    })
    .select("id")
    .single();
  if (error || !row) return failItems(admin, [it.id], `저장하지 못했어요: ${error?.message ?? ""}`, [path]);
  const { error: numErr } = await admin.rpc("assign_variant_number", { p_problem: row.id });
  if (numErr) console.warn("[variant-batch] 번호 매기기 실패:", numErr.message);
  await admin.from("variant_batch_items").update({ stage: "done", problem_id: row.id, batch_id: null, cost_krw: it.cost_krw + krw, error: null, updated_at: at }).eq("id", it.id);
  if (notes === null) {
    const { enqueueAutoStep } = await import("./variantAuto");
    await enqueueAutoStep(admin, it.user_id, row.id, "check", "자동 재검수");
  }
}

/** 걸어 둔 batch 들의 상태를 묻고, 끝난 것은 결과를 처리한다. */
export async function pollBatches(admin: SupabaseClient, deadline: number): Promise<{ checked: number; finished: number }> {
  const { data } = await admin
    .from("openai_batches")
    .select("id,stage,status")
    .is("done_at", null)
    .lt("polled_at", new Date(Date.now() - 45_000).toISOString())
    .or(`created_at.gt.${new Date(Date.now() - 15 * 60_000).toISOString()},polled_at.lt.${new Date(Date.now() - 4 * 60_000).toISOString()}`)
    .order("polled_at")
    .limit(10);
  let checked = 0;
  let finished = 0;
  for (const b of data ?? []) {
    if (Date.now() > deadline) break;
    checked++;
    const res = await fetch(`${OPENAI}/batches/${encodeURIComponent(b.id)}`, { headers: { Authorization: `Bearer ${key()}` } });
    const info = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const status = String(info.status ?? (res.ok ? "unknown" : `http_${res.status}`));
    await admin.from("openai_batches").update({ status, polled_at: new Date().toISOString() }).eq("id", b.id);
    if (!TERMINAL.has(status)) continue;
    // 처리 중에 다른 poll 이 같은 batch 를 집지 않게 먼저 찜한다.
    const { data: claimed } = await admin.from("openai_batches").update({ done_at: new Date().toISOString() }).eq("id", b.id).is("done_at", null).select("id").maybeSingle();
    if (!claimed) continue;
    const { data: rows } = await admin
      .from("variant_batch_items")
      .select("id,user_id,group_id,category_id,src_path,params,stage,batch_id,plan,draft_path,cost_krw")
      .eq("batch_id", b.id);
    const items = (rows ?? []) as Item[];
    let lines: OutLine[] = [];
    try {
      lines = [...(await readFile(info.output_file_id)), ...(await readFile(info.error_file_id))];
    } catch (err) {
      // 결과를 못 받았으면 찜을 풀어 다음에 다시 받는다.
      await admin.from("openai_batches").update({ done_at: null }).eq("id", b.id);
      console.warn("[variant-batch] 결과 받기 실패:", err instanceof Error ? err.message : err);
      continue;
    }
    const byId = new Map(lines.map((l) => [l.custom_id ?? "", l]));
    const cache: SrcCache = new Map();
    for (const it of items) {
      try {
        if (status !== "completed" && !byId.has(it.id)) await failItems(admin, [it.id], `batch 가 ${status} 로 끝났어요.`, [it.draft_path]);
        else await handleLine(admin, it, byId.get(it.id), cache);
      } catch (err) {
        await failItems(admin, [it.id], err instanceof Error ? err.message : "처리 실패", [it.draft_path]);
      }
    }
    finished++;
  }
  return { checked, finished };
}
