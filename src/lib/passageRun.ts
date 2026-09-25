// 국어 지문 인식을 서버 일꾼이 한다(2026-09-25). **서버 전용.**
//
// 예전에는 국어 모드 화면이 sol 읽기 → 서식 검수 → 지문 안 그림 다시 그리기를
// 차례로 기다리느라 그동안 아무것도 못 했다. 이제 화면은 지문을 사진으로 먼저
// 저장하고 입력만 올려 두면 끝이다 — 여기서 **단계마다 일꾼 한 번씩** 돈다
// (한 번에 다 하면 300초 한도를 넘길 수 있다):
//
//   read   — sol 이 글자와 서식을 읽는다. 그림 입력은 영구 자리로 옮겨 우선 원본을 붙인다.
//   marks  — 서식 검수(원문자·밑줄·네모·굵게만 다시 본다). 실패해도 건너뛴다.
//   figure — 지문 안 그림을 하나씩 sunburst 로 다시 그린다. 실패하면 원본을 둔다.
//
// **단계가 끝날 때마다 그 행의 `box_range.korean.blocks` 를 고쳐 쓴다.** 뒤 단계가
// 죽어도(배포 교체·시간 초과) 앞에서 읽은 글자는 남는다.
//
// 과금: 넣을 때 `passageDepositFrom("read")` 를 통째로 걸고, `charged_tokens` 는 늘
// **아직 안 쓴 보증금**이다 — 실패하면(또는 멈춘 작업 정리가) 그만큼만 돌려준다.
// 쓴 것은 `state.spent` 에 모으고, 끝나면 `charged_tokens` 를 쓴 만큼으로 바꿔 적는다.

import type { SupabaseClient } from "@supabase/supabase-js";
import { cardUrl } from "./cardUrl";
import { loadAsDataUrl, removeStored, runFigureGeneration, splitDataUrl, storeBytes } from "./figureRun";
import { GradeError, readKoreanMarks, readKoreanRichText } from "./gradeExam";
import { describeMarks, emptyMarkStats, readRichBlocks, type RichBlock } from "./kice/richText";
import {
  applyMarksReview,
  describeMarksReview,
  reviewParagraphs,
  type MarksReviewPara,
} from "./kice/marksReview";
import { placePassageFigures } from "./kice/passageFigurePlace";
import {
  FIGURE_TOKEN_DEPOSIT,
  PASSAGE_MARKS_DEPOSIT,
  PASSAGE_READ_TOKENS,
  gradingEstKrw,
  gradingTokenCharge,
} from "./tokens";

/** 넣을 때 브라우저가 준비해 올린 입력들(전부 `<uid>/_jobs/` 아래 경로). */
export type PassagePayload = {
  /** 서식 검수용 전체 사진(작게). */
  overview: string;
  /** 서식 검수용 확대 띠들. */
  strips: string[];
  /** sol 에게 자리만 알려 줄 그림 사본(작게). */
  figuresSmall: string[];
  /** 다시 그릴 그림(모델 입력 크기)과 지문 폭 대비 비율·크기. */
  figures: { path: string; scale: number; width?: number; height?: number }[];
};

type FigureSlot = { src: string; ratio: number; scale: number; path: string; redrawn?: boolean };

export type PassageState = {
  blocks?: RichBlock[];
  review?: MarksReviewPara[];
  /** `f1`, `f2`… 차례. */
  figures?: FigureSlot[];
  /** `readMarks` 는 첫 호출의 서식 요약 — 서식 검수가 끝나면 그쪽 요약만 보인다. */
  notes?: { read?: string; readMarks?: string; marks?: string; figures?: string };
  /** 지금까지 **쓴** 토큰(보증금 중 돌려주지 않을 몫). */
  spent?: number;
};

export type PassageJob = {
  id: string;
  user_id: string;
  problem_id: string | null;
  input_path: string;
  payload: PassagePayload | null;
  stage: string | null;
  state: PassageState | null;
  charged: boolean;
};

export type PassageStageOutcome =
  /** 다음 단계로. `refund` 만큼 보증금을 돌려준다. */
  | { kind: "next"; stage: string; state: PassageState; note: string; refund: number; spent: number }
  /** 끝. 쓰고 남은 보증금은 부르는 쪽이 모두 돌려준다. */
  | { kind: "done"; state: PassageState; note: string; refund: number; spent: number }
  | { kind: "fail"; error: string };

type Ctx = {
  byokApiKey?: string;
  /** 그림 다시 그리기에 쓸 이미지 모델 후보(`pickModelIds`). */
  modelIds: string[];
  /** 이 단계에 쓸 시간(ms). */
  deadlineMs: number;
  tag: string;
};

/** 입력 경로들(끝나면 지운다). */
export function passageInputPaths(job: { input_path: string; payload: PassagePayload | null }): string[] {
  const p = job.payload;
  if (!p) return [job.input_path];
  return [job.input_path, p.overview, ...p.strips, ...p.figuresSmall, ...p.figures.map((f) => f.path)];
}

/** 지금 상태로 조판할 블록(그림을 제자리에 붙이고 서식 검수를 입힌다). */
export function passageBlocksOf(state: PassageState): RichBlock[] {
  const placed = placePassageFigures(
    state.blocks ?? [],
    (state.figures ?? []).map((f) => ({ src: f.src, ratio: f.ratio, scale: f.scale })),
  ).blocks;
  return state.review ? applyMarksReview(placed, state.review).blocks : placed;
}

/**
 * 그 지문 행의 `korean.blocks` 를 고쳐 쓴다. **쓰기 직전에 다시 읽는다** — 그
 * 사이 사용자가 제목을 고쳤을 수 있다. 지문 행이 아니면 건드리지 않는다.
 */
async function publish(admin: SupabaseClient, job: PassageJob, state: PassageState) {
  if (!job.problem_id) return;
  const { data: row } = await admin
    .from("problems")
    .select("box_range")
    .eq("id", job.problem_id)
    .eq("user_id", job.user_id)
    .maybeSingle();
  if (!row) return;
  const box = (row.box_range ?? {}) as Record<string, unknown>;
  const korean = (box.korean ?? null) as Record<string, unknown> | null;
  if (!korean || korean.role !== "passage") return;
  const { error } = await admin
    .from("problems")
    .update({ box_range: { ...box, korean: { ...korean, blocks: passageBlocksOf(state) } } })
    .eq("id", job.problem_id)
    .eq("user_id", job.user_id);
  if (error) throw new Error(`지문을 저장하지 못했어요: ${error.message}`);
}

/** 그림 한 장을 영구 자리(`passage-figures/`)에 둔다. 주소를 돌려준다. */
async function keepFigure(admin: SupabaseClient, userId: string, dataUrl: string) {
  const parts = splitDataUrl(dataUrl);
  if (!parts) return null;
  const path = `${userId}/passage-figures/${crypto.randomUUID()}.${parts.ext}`;
  if (!(await storeBytes(admin, path, parts.bytes, parts.mime))) return null;
  return { path, src: cardUrl(path) };
}

function figureNote(slots: FigureSlot[], missing: number): string {
  if (slots.length === 0) return "";
  const redrawn = slots.filter((f) => f.redrawn).length;
  const parts = [`그림 ${slots.length}개 붙임`];
  if (redrawn > 0) parts.push(`sunburst 로 ${redrawn}개 다시 그림`);
  if (redrawn < slots.length) parts.push(`${slots.length - redrawn}개는 원본`);
  if (missing > 0) parts.push(`${missing}개는 자리를 못 짚어 지문 끝에 붙였어요`);
  return parts.join(" · ");
}

function joinNotes(state: PassageState): string {
  const n = state.notes ?? {};
  return [n.read, n.marks ?? n.readMarks, n.figures].filter(Boolean).join(" · ");
}

async function loadAll(admin: SupabaseClient, paths: string[]): Promise<string[] | null> {
  const out = await Promise.all(paths.map((p) => loadAsDataUrl(admin, p)));
  return out.every((x): x is string => typeof x === "string") ? out : null;
}

/** 다음 단계 이름. 그림이 없으면 검수 뒤에 끝난다. */
function afterMarks(state: PassageState): { stage: string } | null {
  return (state.figures?.length ?? 0) > 0 ? { stage: "figure:0" } : null;
}

export async function runPassageStage(
  admin: SupabaseClient,
  job: PassageJob,
  ctx: Ctx,
): Promise<PassageStageOutcome> {
  const payload = job.payload;
  if (!payload) return { kind: "fail", error: "지문 입력 정보가 없어요. 다시 넣어주세요." };
  const stage = job.stage ?? "read";
  const state: PassageState = { ...(job.state ?? {}) };
  const spent0 = state.spent ?? 0;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), ctx.deadlineMs);
  try {
    // ── read ─────────────────────────────────────────────────────────
    if (stage === "read") {
      const image = await loadAsDataUrl(admin, job.input_path);
      const small = await loadAll(admin, payload.figuresSmall);
      if (!image || !small) return { kind: "fail", error: "올려 둔 지문 사진을 찾지 못했어요. 다시 넣어주세요." };
      const { blocks: raw, model } = await readKoreanRichText(image, deadline.signal, ctx.byokApiKey, small);
      const stats = emptyMarkStats();
      const blocks = readRichBlocks(raw, 0, stats);
      if (blocks.length === 0) return { kind: "fail", error: "지문에서 문단을 하나도 읽지 못했어요." };

      // 그림은 우선 **원본**을 영구 자리에 옮겨 붙인다 — 다시 그리기가 끝나기 전에
      // 뽑아도(또는 그 단계가 죽어도) 빈 자리가 아니다.
      const figures: FigureSlot[] = [];
      for (const f of payload.figures) {
        const data = await loadAsDataUrl(admin, f.path);
        const kept = data ? await keepFigure(admin, job.user_id, data) : null;
        // 하나라도 빠뜨리면 뒤의 그림들이 한 칸씩 밀려 엉뚱한 자리에 붙는다(f1, f2… 는 차례다).
        if (!kept) return { kind: "fail", error: "지문 안 그림을 옮기지 못했어요. 다시 시도해주세요." };
        figures.push({
          src: kept.src,
          path: kept.path,
          scale: f.scale,
          ratio: f.width && f.height ? f.height / f.width : 1,
        });
      }
      const next: PassageState = {
        ...state,
        blocks,
        figures,
        notes: { read: model, readMarks: describeMarks(stats) || undefined },
        spent: spent0 + PASSAGE_READ_TOKENS,
      };
      next.notes!.figures = figureNote(figures, placePassageFigures(blocks, figures).missing) || undefined;
      await publish(admin, job, next);
      return { kind: "next", stage: "marks", state: next, note: joinNotes(next), refund: 0, spent: PASSAGE_READ_TOKENS };
    }

    // ── marks ────────────────────────────────────────────────────────
    if (stage === "marks") {
      const paragraphs = reviewParagraphs(state.blocks ?? []);
      let charge = 0;
      const next: PassageState = { ...state, notes: { ...state.notes } };
      if (paragraphs.length > 0) {
        const images = await loadAll(admin, [payload.overview, ...payload.strips]);
        let lastError = images ? "" : "검수용 사진을 찾지 못했어요";
        // **서식 검수는 빠지면 안 된다** — 한 번 실패하면 한 번 더 건다.
        for (let attempt = 0; images && attempt < 2 && !deadline.signal.aborted; attempt++) {
          try {
            const { review, usage, model } = await readKoreanMarks(
              images,
              paragraphs,
              deadline.signal,
              ctx.byokApiKey,
            );
            const est = usage ? gradingEstKrw(usage, model) : undefined;
            charge = Math.min(PASSAGE_MARKS_DEPOSIT, gradingTokenCharge(est));
            next.review = review;
            next.notes!.marks = describeMarksReview(
              applyMarksReview(state.blocks ?? [], review).stats,
            );
            lastError = "";
            break;
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            // 요청 자체가 틀린 것은 다시 해도 같다.
            if (err instanceof GradeError && err.status >= 400 && err.status < 500) break;
          }
        }
        if (lastError) next.notes!.marks = `서식 검수 실패 — 첫 결과의 서식을 씁니다 (${lastError.slice(0, 120)})`;
      }
      next.spent = spent0 + charge;
      await publish(admin, job, next);
      const refund = PASSAGE_MARKS_DEPOSIT - charge;
      const then = afterMarks(next);
      return then
        ? { kind: "next", stage: then.stage, state: next, note: joinNotes(next), refund, spent: charge }
        : { kind: "done", state: next, note: joinNotes(next), refund, spent: charge };
    }

    // ── figure:i ─────────────────────────────────────────────────────
    const m = /^figure:(\d+)$/.exec(stage);
    if (m) {
      const i = Number(m[1]);
      const slots = [...(state.figures ?? [])];
      const input = payload.figures[i];
      let kept = false;
      if (slots[i] && input) {
        const image = await loadAsDataUrl(admin, input.path);
        const outcome = image
          ? await runFigureGeneration({
              image,
              mode: "figure",
              korean: true,
              inputSize: input.width && input.height ? { width: input.width, height: input.height } : undefined,
              modelIds: ctx.modelIds,
              byokApiKey: ctx.byokApiKey,
              deadlineMs: ctx.deadlineMs,
              tag: `${ctx.tag} 그림${i + 1}`,
            })
          : null;
        if (outcome?.ok) {
          const saved = await keepFigure(admin, job.user_id, outcome.dataUrl);
          if (saved) {
            // 우선 붙여 둔 원본 사본은 이제 아무도 안 가리킨다.
            await removeStored(admin, [slots[i].path]);
            slots[i] = { ...slots[i], src: saved.src, path: saved.path, redrawn: true };
            kept = true;
          }
        } else if (outcome) {
          console.warn(`[${ctx.tag}] 그림${i + 1} 다시 그리기 실패: ${outcome.error}`);
        }
      }
      const charge = kept ? FIGURE_TOKEN_DEPOSIT : 0;
      const next: PassageState = {
        ...state,
        figures: slots,
        spent: spent0 + charge,
        notes: {
          ...state.notes,
          figures: figureNote(slots, placePassageFigures(state.blocks ?? [], slots).missing),
        },
      };
      await publish(admin, job, next);
      const refund = FIGURE_TOKEN_DEPOSIT - charge;
      return i + 1 < payload.figures.length
        ? { kind: "next", stage: `figure:${i + 1}`, state: next, note: joinNotes(next), refund, spent: charge }
        : { kind: "done", state: next, note: joinNotes(next), refund, spent: charge };
    }

    return { kind: "fail", error: `알 수 없는 단계예요 (${stage}).` };
  } catch (err) {
    if (deadline.signal.aborted) {
      return { kind: "fail", error: "지문 인식이 제때 끝나지 않았어요. 토큰은 돌려드렸어요." };
    }
    return { kind: "fail", error: err instanceof Error ? err.message : "지문 인식에 실패했어요." };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `stage` 부터 끝까지 도는 데 걸 보증금. 실패한 작업을 다시 돌릴 때 **실패한
 * 단계부터** 잇는다 — 이미 읽은 글자를 다시 읽으면 같은 값을 두 번 받는다.
 */
export function passageDepositFrom(stage: string | null, figureCount: number): number {
  const s = stage ?? "read";
  const m = /^figure:(\d+)$/.exec(s);
  if (m) return FIGURE_TOKEN_DEPOSIT * Math.max(0, figureCount - Number(m[1]));
  const figures = FIGURE_TOKEN_DEPOSIT * figureCount;
  return s === "marks" ? PASSAGE_MARKS_DEPOSIT + figures : PASSAGE_READ_TOKENS + PASSAGE_MARKS_DEPOSIT + figures;
}
