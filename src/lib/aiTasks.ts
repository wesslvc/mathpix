// **서버 대기열의 짧은 AI 작업들**(`figure_jobs.mode = 'task'`). **서버 전용.**
//
// 사용자 — "모든 ai작업은 서버에서 돌리고 사용자한테 대기열에 들어가서 진행중인걸 볼수있게할것"(2026-10-01).
// 예전에는 글자 인식·번호 읽기·영역 찾기·제목 짓기·채점·답지 읽기·지문 다시 인식·sol 조판·sol 대화를 화면이 라우트에
// 직접 보내고 기다렸다. 이제 화면은 `/api/figure-jobs`(mode "task")에 넣고 결과를 받아 가며, 실제 호출은 일꾼
// (`/api/figure-jobs/run`)이 여기 있는 `run` 으로 한다. 진행은 그림 작업과 같은 대기열 패널에 뜬다.
//
// 과금은 그림 작업과 같은 모양이다: **넣을 때 보증금을 걸고**(세션 차감), 일꾼이 끝나면 쓴 만큼으로 맞춘다
// (남으면 돌려주고 모자라면 서비스용 차감 함수로 더 받는다). 실패하면 전부 돌려준다.

import { cleanAnswerText } from "./variantOf";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recognizeImage } from "./mathpixClient";
import {
  DetectError,
  detectKoreanPassages,
  detectKoreanQuestions,
  detectProblems,
  OPENAI_DETECT_MODEL,
  type DetectUsage,
} from "./detectProblems";
import {
  GradeError,
  OPENAI_TEXT_EFFORT,
  gradeWithVision,
  readAnswerKeyWithVision,
  readKoreanMarks,
  readKoreanRichText,
  readKoreanTitle,
  type AnswerKeyItem,
  type GradeKeySource,
  type GradingMethod,
  type Subject,
} from "./gradeExam";
import {
  GRADING_TOKEN_DEPOSIT,
  OCR_TOKEN_COST,
  PASSAGE_MARKS_DEPOSIT,
  PASSAGE_READ_TOKENS,
  gradingEstKrw,
  SOL_TYPESET_TOKENS,
  USD_KRW_RATE,
} from "./tokens";
import { HAIKU_MODEL, imageTokens, logAiCost, solTokens } from "./costLog";
import {
  parseSolChat,
  parseTranscription,
  planToChanges,
  solChatPrompt,
  TYPESET_PROMPT,
  type ChatTurn,
} from "./problemCompare";
import { askSol, loadPatchImages } from "./problemLoopRun";
import { removeStored } from "./figureRun";
import { cropOneProblem, findProblemNumber, labelUnit, lunaUsage, OPENAI_UNIT_MODEL, placeFigures } from "./lunaQuick";
import type { ProblemBox } from "./problemBoxes";
import {
  answerOf,
  parseVariantPlan,
  parseVariantReview,
  readLevel,
  readNovelty,
  reviewFixInstruction,
  settingsTail,
  VARIANT_PROMPT,
  VARIANT_REVIEW_PROMPT,
  type VariantReview,
} from "./variantPlan";
import { loadAsDataUrl, runFigureGeneration, splitDataUrl, storeBytes } from "./figureRun";
import { figureImageModelIds } from "./figureImageGen";
import { cardUrl } from "./cardUrl";
import { toStoredFigures } from "./storedFigures";
import { compositePatch } from "./patchComposite";
import { DEFAULT_FONT_PT } from "./fontSize";

export type TaskKind =
  | "ocr"
  | "detect"
  | "crop"
  | "figures"
  | "numberBox"
  | "title"
  | "grade"
  | "answerKey"
  | "passageRead"
  | "passageMarks"
  | "typeset"
  | "chat"
  | "variant"
  | "variantFix"
  | "unitLabel";

export const TASK_KINDS: readonly TaskKind[] = [
  "ocr",
  "detect",
  "crop",
  "figures",
  "numberBox",
  "title",
  "grade",
  "answerKey",
  "passageRead",
  "passageMarks",
  "typeset",
  "chat",
  "variant",
  "variantFix",
  "unitLabel",
];

/**
 * **대기열을 안 타고 곧바로 부르는 일들**(2026-10-04, 사용자 — "luna 는 금방금방 끝나니까 서버에서 돌릴 필요는 없어, 더 빠르게
 * 할 수 있다면"). 전부 luna(+고정 요금)라 몇 초~수십 초면 끝난다 — 줄에 넣고 일꾼을 깨우고 1~2초마다 묻는 왕복을 뺀다.
 * `/api/ai-direct` 가 같은 `run` 을 요청 안에서 돌린다. 화면(`aiTask.ts` 의 `DIRECT_KINDS`)도 같은 목록을 든다.
 */
export const DIRECT_TASKS: readonly TaskKind[] = ["crop", "figures", "numberBox", "detect", "title", "grade", "answerKey", "unitLabel"];

export type TaskCtx = {
  admin: SupabaseClient;
  userId: string;
  jobId: string;
  images: string[];
  params: Record<string, unknown>;
  unlimited: boolean;
  byok: boolean;
  byokApiKey?: string;
  signal: AbortSignal;
  deadlineMs: number;
  tag: string;
};

export type TaskOutcome =
  | {
      ok: true;
      result: unknown;
      /** 정산에 쓸 원가(원). 모르면 보증금을 그대로 받는다. */
      estKrw?: number;
      model?: string;
      /** 패널에 띄울 한 줄. */
      note?: string;
    }
  | {
      ok: false;
      error: string;
      /** 원가는 이미 나갔다(읽기는 됐는데 결과를 못 쓴 경우) — 그만큼은 받는다. */
      estKrw?: number;
    };

type TaskDef = {
  /** 보증금(토큰). 0 이면 받지 않는다. */
  deposit: (params: Record<string, unknown>) => number;
  /** 원가와 무관하게 늘 보증금만 받는다(Mathpix·luna 고정 요금). */
  flat: boolean;
  /** OpenAI 키가 있어야 하는가(본인 키 또는 서버 키). */
  needsOpenAI: boolean;
  /** 무제한 계정만 쓸 수 있다(영역 찾기 — `/api/detect-problems` 와 같은 규칙). */
  unlimitedOnly?: boolean;
  images: { min: number; max: number };
  /** 잔액 부족 안내에 쓸 이름. */
  name: string;
  run: (ctx: TaskCtx) => Promise<TaskOutcome>;
};

const str = (v: unknown, max = 4000) => (typeof v === "string" ? v.slice(0, max) : "");

/** 불러온 정답표(데이터)의 모양을 확인한다. 쓸 것이 하나도 없으면 null(= 사진 정답표로 본다). */
function readKeyItems(v: unknown): AnswerKeyItem[] | null {
  if (!Array.isArray(v)) return null;
  const out: AnswerKeyItem[] = [];
  const seen = new Set<number>();
  for (const raw of v.slice(0, 200)) {
    const o = raw as Record<string, unknown>;
    const no = Math.floor(Number(o?.no));
    const answer = typeof o?.answer === "string" ? o.answer.trim().slice(0, 60) : "";
    if (!Number.isFinite(no) || no < 1 || no > 999 || !answer || seen.has(no)) continue;
    seen.add(no);
    const points = Number(o?.points);
    out.push({ no, answer, ...(Number.isFinite(points) && points > 0 && points <= 100 ? { points } : {}) });
  }
  return out.length ? out : null;
}

/** 화면이 보낸 지문 자리(0~1). 모양이 이상한 것은 버린다. */
function readBoxes(raw: unknown): ProblemBox[] {
  if (!Array.isArray(raw)) return [];
  const out: ProblemBox[] = [];
  for (const b of raw.slice(0, 20)) {
    const o = b as Partial<ProblemBox>;
    const vals = [o.x, o.y, o.w, o.h].map(Number);
    if (!vals.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) continue;
    out.push({ x: vals[0], y: vals[1], w: vals[2], h: vals[3] });
  }
  return out;
}

/** 무제한·BYOK 계정에만 원가를 보여 준다(막는 자리는 서버다). */
function money(ctx: TaskCtx, usage: object | undefined, estKrw: number | undefined) {
  return (ctx.unlimited || ctx.byok) && usage ? { ...usage, estKrw } : undefined;
}

/** 자동 자르기의 표적(지면 정밀 자르기): 그림 안 어림 자리(0~1) + 번호. 모양이 이상하면 없는 것으로. */
function readTarget(v: unknown): { box: { x: number; y: number; w: number; h: number }; number?: string } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as { box?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown }; number?: unknown };
  const b = o.box;
  if (!b) return undefined;
  const [x, y, w, h] = [b.x, b.y, b.w, b.h].map(Number);
  if (![x, y, w, h].every((n) => Number.isFinite(n) && n >= 0 && n <= 1) || w <= 0 || h <= 0) return undefined;
  const number = typeof o.number === "string" ? o.number.trim().slice(0, 12) : undefined;
  return { box: { x, y, w, h }, ...(number ? { number } : {}) };
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof GradeError || err instanceof DetectError) return err.message;
  return err instanceof Error ? err.message : fallback;
}

const mathpixMock = () => !process.env.MATHPIX_APP_ID || !process.env.MATHPIX_APP_KEY;

export function taskNeedsOpenAI(def: { needsOpenAI: boolean }, params: Record<string, unknown>): boolean {
  return def.needsOpenAI && params.engine !== "mathpix";
}

export const TASKS: Record<TaskKind, TaskDef> = {
  // Mathpix 글자 인식(결과 화면으로 가는 "글자로 인식" · 번호 읽기 · 전체 번호 인식).
  ocr: {
    // mock(키 미설정)은 실제 호출이 아니라 받지 않는다. 무제한·BYOK 는 Mathpix 를 무료로 쓴다(넣는 쪽이 거른다).
    // 번호 읽기(`params.free`)는 무료다. 글자로 인식(결과 화면)만 받는다.
    deposit: (params) => (mathpixMock() || params.free === true ? 0 : OCR_TOKEN_COST),
    flat: true,
    needsOpenAI: false,
    images: { min: 1, max: 1 },
    name: "글자 인식",
    async run(ctx) {
      try {
        const result = await recognizeImage(ctx.images[0], {
          appId: process.env.MATHPIX_APP_ID,
          appKey: process.env.MATHPIX_APP_KEY,
        });
        return { ok: true, result, model: "Mathpix" };
      } catch (err) {
        return { ok: false, error: errorMessage(err, "Mathpix 인식에 실패했습니다.") };
      }
    },
  },

  // luna 영역 찾기(지면 통째로 · 국어 지문/문제). 무제한 계정 전용, 토큰을 안 뗀다(예전 라우트와 같다).
  detect: {
    deposit: () => 0,
    flat: true,
    needsOpenAI: false,
    unlimitedOnly: true,
    images: { min: 1, max: 1 },
    name: "영역 찾기",
    async run(ctx) {
      const mode = str(ctx.params.mode, 40);
      // 영역 찾기도 원가가 든다(luna, 추론 강도 high) — 무제한 계정의 원가 장부에 적는다. 토큰은 안 뗀다(deposit 0·flat).
      const cost = async (usage: DetectUsage | undefined, what: string, kind: "passage" | "problem", answered?: string) => {
        if (!usage) return undefined;
        // 하이쿠(오픈라우터)가 답했으면 응답이 준 실제 청구액으로 적는다.
        if (answered?.includes("/")) {
          const hk = typeof usage.costUsd === "number" ? usage.costUsd * USD_KRW_RATE : 0;
          if (hk > 0) await logAiCost(ctx.admin, { userId: ctx.userId, jobId: ctx.jobId, kind, what, krw: hk, model: HAIKU_MODEL, tokens: usage });
          return hk > 0 ? hk : undefined;
        }
        const krw = gradingEstKrw(
          { inputTokens: usage.input, outputTokens: usage.output, ...(usage.cached ? { cachedInputTokens: usage.cached } : {}) },
          OPENAI_DETECT_MODEL,
        );
        if (krw) await logAiCost(ctx.admin, { userId: ctx.userId, jobId: ctx.jobId, kind, what, krw, model: OPENAI_DETECT_MODEL, tokens: usage });
        return krw;
      };
      try {
        if (mode === "korean-passage") {
          const { passages, figures, pageNo, model, usage } = await detectKoreanPassages(ctx.images[0]);
          const estKrw = await cost(usage, "지문 자리 찾기", "passage", model);
          return { ok: true, result: { regions: passages, figures, pageNo, model }, model, estKrw };
        }
        if (mode === "korean-question") {
          const { regions, pageNo, model, usage } = await detectKoreanQuestions(ctx.images[0], readBoxes(ctx.params.passages));
          const estKrw = await cost(usage, "국어 문제 자리 찾기", "passage", model);
          return { ok: true, result: { regions, pageNo, model }, model, estKrw };
        }
        const { problems, model, usage } = await detectProblems(ctx.images[0]);
        // 원가는 답한 모델로 적는다: 하이쿠(오픈라우터)는 응답이 준 실제 청구액, luna 는 공표 단가. Gemini 단가는 아직 모른다 — 지어내지 않는다.
        let estKrw: number | undefined;
        if (model.includes("/") && usage && typeof usage.costUsd === "number") {
          estKrw = usage.costUsd * USD_KRW_RATE;
          if (estKrw > 0) {
            await logAiCost(ctx.admin, { userId: ctx.userId, jobId: ctx.jobId, kind: "problem", what: "지면 자리 찾기", krw: estKrw, model: HAIKU_MODEL, tokens: usage });
          }
        } else if (model.startsWith(OPENAI_DETECT_MODEL)) {
          estKrw = await cost(usage, "지면 자리 찾기", "problem");
        }
        return { ok: true, result: { problems, model }, model, estKrw };
      } catch (err) {
        return { ok: false, error: errorMessage(err, "문제 영역 인식에 실패했습니다.") };
      }
    },
  },

  // 사진 한 장의 자동 자르기(luna, 추론 강도 low). 업로드 직후 화면이 부른다 — 누구나, 토큰을 안 뗀다(원가 몇 원, 장부에 적는다).
  crop: {
    deposit: () => 0,
    flat: true,
    needsOpenAI: false,
    images: { min: 1, max: 1 },
    name: "자동 자르기",
    async run(ctx) {
      try {
        const { box, model, usage, number, choices, retried, rotate, kind } = await cropOneProblem(
          ctx.images[0],
          readTarget(ctx.params.target),
          undefined,
          typeof ctx.params.effort === "string" ? ctx.params.effort : undefined,
        );
        // luna 는 공표 단가, 오픈라우터(하이쿠)는 응답이 준 실제 청구액으로 원가를 적는다 — Gemini 단가는 아직 표에 없다(지어내지 않는다).
        const estKrw = usage
          ? model.includes("/") && typeof usage.costUsd === "number"
            ? usage.costUsd * USD_KRW_RATE
            : gradingEstKrw(lunaUsage(usage), model)
          : undefined;
        if (estKrw && usage) {
          await logAiCost(ctx.admin, { userId: ctx.userId, jobId: ctx.jobId, kind: "problem", what: model.includes("/") ? "하이쿠 자동 자르기" : "luna 자동 자르기", krw: estKrw, model: model.includes("/") ? HAIKU_MODEL : OPENAI_DETECT_MODEL, tokens: usage });
        }
        const note = !box
          ? `${model} · 문제 자리를 못 찾았어요`
          : `${model} · ${number ? `번호 ${number}` : "번호 못 봄"} · 선지 ${choices}개${retried ? " (다시 봄)" : ""}${rotate ? ` · ${rotate * 90}° 돌림` : ""}${kind ? ` · ${kind === "math" ? "수학" : kind === "korean" ? "국어" : "그림·표 섞임"}` : ""}`;
        // 비교 화면이 다시 맞추기 비용을 합산하려고 금액을 결과에 싣는다 — 금액은 무제한·BYOK 에게만(다른 화면과 같은 규칙).
        const shownKrw = (ctx.unlimited || ctx.byok) && estKrw ? { estKrw: Math.round(estKrw * 100) / 100 } : {};
        return { ok: true, result: { box, model, number, choices, rotate, kind, ...shownKrw }, model, estKrw, note };
      } catch (err) {
        return { ok: false, error: errorMessage(err, "자동 자르기에 실패했습니다.") };
      }
    },
  },

  // 글자로 인식한 문제의 그림 자리와 그 그림이 어느 문단 앞에 오는지(luna, 추론 강도 low). 자동 자르기처럼 토큰을 안 뗀다.
  figures: {
    deposit: () => 0,
    flat: true,
    needsOpenAI: false,
    images: { min: 1, max: 1 },
    name: "그림 자리 찾기",
    async run(ctx) {
      const blocks = Array.isArray(ctx.params.blocks)
        ? (ctx.params.blocks as unknown[]).slice(0, 60).map((b) => str(b, 200))
        : [];
      try {
        const { figures, model, usage } = await placeFigures(ctx.images[0], blocks);
        const estKrw = usage ? gradingEstKrw(lunaUsage(usage), OPENAI_DETECT_MODEL) : undefined;
        if (estKrw && usage) {
          await logAiCost(ctx.admin, { userId: ctx.userId, jobId: ctx.jobId, kind: "problem", what: "luna 그림 자리 찾기", krw: estKrw, tokens: usage });
        }
        return { ok: true, result: { figures, model }, model, estKrw, note: `그림 ${figures.length}개` };
      } catch (err) {
        return { ok: false, error: errorMessage(err, "그림 자리를 찾지 못했습니다.") };
      }
    },
  },

  // 문제 그림에서 인쇄된 번호 자리(luna, 추론 강도 low). 여러 실모를 묶어 PDF 로 뽑으며 1번부터 다시 매길 때 원래 번호를 덮을
  // 자리다 — 자동 자르기처럼 토큰을 안 뗀다(원가 몇 원, 장부에 적는다).
  numberBox: {
    deposit: () => 0,
    flat: true,
    needsOpenAI: false,
    images: { min: 1, max: 1 },
    name: "번호 자리 찾기",
    async run(ctx) {
      try {
        // 못 찾은 것을 다시 물을 때만 강도를 올린다(화면이 위쪽을 확대해 `effort: "medium"` 으로 보낸다).
        const effort = ["low", "medium", "high"].includes(String(ctx.params.effort)) ? String(ctx.params.effort) : undefined;
        const { box, text, model, usage } = await findProblemNumber(ctx.images[0], effort);
        const estKrw = usage ? gradingEstKrw(lunaUsage(usage), OPENAI_DETECT_MODEL) : undefined;
        if (estKrw && usage) {
          await logAiCost(ctx.admin, { userId: ctx.userId, jobId: ctx.jobId, kind: "problem", what: "luna 번호 자리 찾기", krw: estKrw, tokens: usage });
        }
        return { ok: true, result: { box, text, model }, model, estKrw, note: box ? undefined : "번호를 못 찾았어요" };
      } catch (err) {
        return { ok: false, error: errorMessage(err, "번호 자리를 찾지 못했습니다.") };
      }
    },
  },

  // 국어 지문 제목 짓기(luna, 고정 1토큰).
  title: {
    deposit: () => 0,
    flat: true,
    needsOpenAI: true,
    images: { min: 0, max: 1 },
    name: "제목 짓기",
    async run(ctx) {
      const text = str(ctx.params.text, 12000).trim();
      if (!ctx.images[0] && text.length < 20) return { ok: false, error: "제목을 지을 지문 사진이나 글이 필요합니다." };
      try {
        const { result, usage, model } = await readKoreanTitle(
          text.length >= 20 ? { text } : { image: ctx.images[0] },
          ctx.signal,
          ctx.byokApiKey,
        );
        const estKrw = usage ? gradingEstKrw(usage, model) : undefined;
        if (estKrw && !ctx.byok) await logAiCost(ctx.admin, { userId: ctx.userId, jobId: ctx.jobId, kind: "passage", what: "지문 제목 짓기", krw: estKrw, tokens: solTokens(usage) });
        return { ok: true, result: { ...result, model, usage: money(ctx, usage, estKrw) }, estKrw, model };
      } catch (err) {
        return { ok: false, error: errorMessage(err, "제목 짓기에 실패했습니다.") };
      }
    },
  },

  // 자동채점(luna, 고정). images = [OMR(또는 가채점표), 정답표…].
  grade: {
    deposit: () => GRADING_TOKEN_DEPOSIT,
    flat: true,
    needsOpenAI: true,
    // 정답표를 전부 저장된 것에서 불러오면 OMR 한 장만 온다.
    images: { min: 1, max: 3 },
    name: "자동채점",
    async run(ctx) {
      const p = ctx.params;
      const subject: Subject =
        p.subject === "math" || p.subject === "elective" || p.subject === "english" ? p.subject : "korean";
      const method: GradingMethod = p.method === "handwritten" ? "handwritten" : "omr";
      const electiveLabel = str(p.electiveLabel, 100).trim() || undefined;
      const keys = (Array.isArray(p.keys) ? p.keys : []) as { slot?: number; label?: string; items?: unknown }[];
      // 정답표마다 사진인지, 불러온 정답표(데이터)인지. 데이터는 모양을 다시 확인한다(사람이 보낸 값이다).
      const sources: GradeKeySource[] = keys.map((k) => {
        const items = readKeyItems(k?.items);
        return items ? { kind: "data", items } : { kind: "image" };
      });
      const keyCount = keys.length || ctx.images.length - 1;
      const imageKeys = keys.length ? sources.filter((k) => k.kind === "image").length : keyCount;
      const valid =
        (subject === "elective" ? keyCount === 1 || keyCount === 2 : keyCount === 1) &&
        ctx.images.length === 1 + imageKeys;
      if (!valid) return { ok: false, error: "정답표 사진 수가 맞지 않아요." };
      try {
        const result = await gradeWithVision(
          subject,
          ctx.images,
          method,
          ctx.signal,
          electiveLabel,
          ctx.byokApiKey,
          keys.length ? sources : undefined,
        );
        const estKrw = result.usage ? gradingEstKrw(result.usage, result.model) : undefined;
        if (estKrw && !ctx.byok) await logAiCost(ctx.admin, { userId: ctx.userId, jobId: ctx.jobId, kind: "grade", what: "자동채점", krw: estKrw, tokens: solTokens(result.usage) });
        // 슬롯에 사용자가 적어 준 과목명(elective_label)을 그대로 이어 붙인다.
        const slots = result.slots.map((s) => {
          const key = s.slot ? keys.find((k) => k?.slot === s.slot) : keys[0];
          return { ...s, label: typeof key?.label === "string" ? key.label : undefined };
        });
        return {
          ok: true,
          result: { slots, model: result.model, usage: money(ctx, result.usage, estKrw) },
          estKrw,
          model: result.model,
        };
      } catch (err) {
        return { ok: false, error: errorMessage(err, "채점에 실패했습니다.") };
      }
    },
  },

  // 답지(정답표) 읽기(luna, 고정).
  answerKey: {
    deposit: () => GRADING_TOKEN_DEPOSIT,
    flat: true,
    needsOpenAI: true,
    images: { min: 1, max: 10 },
    name: "답지 인식",
    async run(ctx) {
      try {
        const result = await readAnswerKeyWithVision(ctx.images, ctx.signal, ctx.byokApiKey);
        const estKrw = result.usage ? gradingEstKrw(result.usage, result.model) : undefined;
        if (estKrw && !ctx.byok) await logAiCost(ctx.admin, { userId: ctx.userId, jobId: ctx.jobId, kind: "grade", what: "답지 읽기", krw: estKrw, tokens: solTokens(result.usage) });
        return {
          ok: true,
          result: { items: result.items, model: result.model, usage: money(ctx, result.usage, estKrw) },
          estKrw,
          model: result.model,
        };
      } catch (err) {
        return { ok: false, error: errorMessage(err, "답지 인식에 실패했습니다.") };
      }
    },
  },

  // 국어 지문을 글자로(수정 창의 "다시 인식하기"). images = [지문, 지문 안 그림 작은 사본…].
  passageRead: {
    deposit: () => PASSAGE_READ_TOKENS,
    flat: true,
    needsOpenAI: true,
    images: { min: 1, max: 9 },
    name: "지문 인식",
    async run(ctx) {
      try {
        const { blocks, usage, model } = await readKoreanRichText(
          ctx.images[0],
          ctx.signal,
          ctx.byokApiKey,
          ctx.images.slice(1),
        );
        const estKrw = usage ? gradingEstKrw(usage, model) : undefined;
        if (estKrw && !ctx.byok) {
          await logAiCost(ctx.admin, { userId: ctx.userId, jobId: ctx.jobId, kind: "passage", what: "지문 읽기(다시 인식)", krw: estKrw, tokens: solTokens(usage) });
        }
        return { ok: true, result: { blocks, model, usage: money(ctx, usage, estKrw) }, estKrw, model };
      } catch (err) {
        return { ok: false, error: errorMessage(err, "지문 인식에 실패했습니다.") };
      }
    },
  },

  // 서식 검수(원문자·밑줄·네모·굵게). images = [전체, 확대 띠…], params.paragraphs.
  passageMarks: {
    deposit: () => PASSAGE_MARKS_DEPOSIT,
    flat: false,
    needsOpenAI: true,
    images: { min: 1, max: 13 },
    name: "서식 검수",
    async run(ctx) {
      const paragraphs = (Array.isArray(ctx.params.paragraphs) ? ctx.params.paragraphs : [])
        .filter((t): t is string => typeof t === "string")
        .slice(0, 300)
        .map((t) => t.slice(0, 4000));
      if (paragraphs.length === 0) return { ok: false, error: "검수할 문단이 없습니다." };
      try {
        const { review, usage, model } = await readKoreanMarks(ctx.images, paragraphs, ctx.signal, ctx.byokApiKey);
        const estKrw = usage ? gradingEstKrw(usage, model) : undefined;
        if (estKrw && !ctx.byok) {
          await logAiCost(ctx.admin, { userId: ctx.userId, jobId: ctx.jobId, kind: "passage", what: "서식 검수(다시 인식)", krw: estKrw, tokens: solTokens(usage) });
        }
        return { ok: true, result: { review, model, usage: money(ctx, usage, estKrw) }, estKrw, model };
      } catch (err) {
        return { ok: false, error: errorMessage(err, "서식 검수에 실패했습니다.") };
      }
    },
  },

  // sol 이 문제를 글자로 옮겨 적는다(수정 창의 "sol 인식 후 조판"). 실사용량 정산.
  typeset: {
    deposit: (params) => (params.engine === "mathpix" ? (mathpixMock() ? 0 : OCR_TOKEN_COST) : SOL_TYPESET_TOKENS),
    flat: true,
    needsOpenAI: true,
    images: { min: 1, max: 1 },
    name: "sol 조판 인식",
    async run(ctx) {
      if (ctx.params.engine === "mathpix") {
        // Mathpix 로 읽어 같은 조판 경로로 보낸다(수학 기본). 그림은 Mathpix 가 잡은 도형을 쓰지 않고 본문만 옮긴다.
        try {
          const r = await recognizeImage(ctx.images[0], {
            appId: process.env.MATHPIX_APP_ID,
            appKey: process.env.MATHPIX_APP_KEY,
          });
          if (r.mock || !r.text.trim()) return { ok: false, error: "Mathpix 가 글자를 읽지 못했어요." };
          return { ok: true, result: { text: r.text, figures: [] }, model: "Mathpix", note: `글 ${r.text.length}자` };
        } catch (err) {
          return { ok: false, error: errorMessage(err, "Mathpix 인식에 실패했습니다.") };
        }
      }
      const ask = await askSol(
        TYPESET_PROMPT,
        ctx.images,
        { byokApiKey: ctx.byokApiKey, modelIds: [], deadlineMs: ctx.deadlineMs, tag: ctx.tag },
        "조판 인식",
        { cacheKey: "reprint-typeset", effort: OPENAI_TEXT_EFFORT },
      );
      if (ask.krw > 0 && !ctx.byok) {
        await logAiCost(ctx.admin, { userId: ctx.userId, jobId: ctx.jobId, kind: "problem", what: "sol 조판 인식", krw: ask.krw, tokens: solTokens(ask.usage) });
      }
      if (ask.text === null) return { ok: false, error: `sol 이 읽지 못했어요. ${ask.fail.slice(0, 160)}` };
      const estKrw = ask.krw > 0 ? ask.krw : undefined;
      try {
        const parsed = parseTranscription(ask.text);
        return {
          ok: true,
          result: {
            text: parsed.text,
            figures: parsed.figures,
            ...(ctx.unlimited || ctx.byok ? { estKrw: Math.round(ask.krw * 10) / 10 } : {}),
          },
          estKrw,
          note: `글 ${parsed.text.length}자 · 그림 ${parsed.figures.length}개`,
        };
      } catch (err) {
        // 읽기는 했으니(원가가 나갔다) 쓴 만큼은 받는다.
        return { ok: false, error: errorMessage(err, "sol 결과를 읽지 못했어요."), estKrw };
      }
    },
  },

  // sol 수정 대화 한 마디. 추론 강도는 안 보낸다(사용자 지시). images 는 원본·지금 그림 두 장, 또는 params.jobId.
  chat: {
    deposit: () => 0,
    flat: true,
    needsOpenAI: true,
    images: { min: 0, max: 2 },
    name: "sol 대화",
    async run(ctx) {
      const goal = ctx.params.goal === "redraw" ? "redraw" : "patch";
      const turns: ChatTurn[] = (Array.isArray(ctx.params.messages) ? ctx.params.messages : [])
        .map((m) => {
          const r = m as { role?: unknown; text?: unknown };
          return { role: r.role === "assistant" ? "assistant" : "user", text: str(r.text, 4000) } as ChatTurn;
        })
        .filter((t) => t.text.trim());
      if (turns.length === 0 || turns[turns.length - 1].role !== "user") return { ok: false, error: "보낼 말이 없어요." };
      if (turns.length > MAX_CHAT_MESSAGES) {
        return { ok: false, error: "대화가 너무 길어졌어요. 지금까지 정리된 수정 사항으로 확정하거나 새로 시작해주세요." };
      }
      let images = ctx.images;
      let findings = "";
      const jobId = str(ctx.params.jobId, 100);
      if (jobId) {
        const { data: row } = await ctx.admin
          .from("figure_jobs")
          .select("id, input_path, state")
          .eq("id", jobId)
          .eq("user_id", ctx.userId)
          .maybeSingle();
        if (!row) return { ok: false, error: "작업을 찾지 못했어요." };
        const loaded = await loadPatchImages(ctx.admin, row);
        if (!loaded) return { ok: false, error: "원본이나 지금 그림을 찾지 못했어요." };
        images = [loaded.original, loaded.current];
        findings = loaded.findings;
      }
      if (images.length !== 2) return { ok: false, error: "원본과 지금 그림, 두 장이 필요해요." };
      const prompt = solChatPrompt(goal, turns, findings);
      const ask = await askSol(
        prompt.head,
        images,
        { byokApiKey: ctx.byokApiKey, modelIds: [], deadlineMs: Math.min(ctx.deadlineMs, 150_000), tag: ctx.tag },
        "대화",
        { noEffort: true, cacheKey: "reprint-sol-chat", tail: prompt.tail },
      );
      if (ask.krw > 0 && !ctx.byok) {
        await logAiCost(ctx.admin, { userId: ctx.userId, jobId: jobId || ctx.jobId, kind: "problem", what: "sol 수정 대화", krw: ask.krw, tokens: solTokens(ask.usage) });
      }
      if (ask.text === null) return { ok: false, error: `sol 이 답하지 못했어요. ${ask.fail.slice(0, 160)}` };
      const estKrw = ask.krw > 0 ? ask.krw : undefined;
      try {
        const parsed = parseSolChat(ask.text);
        return {
          ok: true,
          result: {
            reply: parsed.reply,
            plan: parsed.plan
              ? { understood: parsed.plan.understood, text: planToChanges(parsed.plan), count: parsed.plan.edits.length }
              : null,
            ...(ctx.unlimited || ctx.byok ? { estKrw: Math.round(ask.krw * 10) / 10 } : {}),
          },
          estKrw,
        };
      } catch (err) {
        return { ok: false, error: errorMessage(err, "sol 답변을 읽지 못했어요."), estKrw };
      }
    },
  },

  // **문제 단원 표지**(변형문제 "유형별 원본 가져오기", 무제한 계정 전용, 토큰 0): 저장된 문제 그림을 서버가 직접 읽어
  // luna 가 단원을 적고 `problem_units` 에 저장한다. 한 번 적으면 다시 검색할 때 모델을 안 부른다.
  unitLabel: {
    deposit: () => 0,
    flat: true,
    needsOpenAI: true,
    unlimitedOnly: true,
    images: { min: 0, max: 0 },
    name: "단원 표지",
    async run(ctx) {
      const problemId = str(ctx.params.problemId, 60);
      if (!/^[0-9a-f-]{36}$/i.test(problemId)) return { ok: false, error: "문제가 정해지지 않았어요." };
      const { data: prob } = await ctx.admin.from("problems").select("id,image_path").eq("id", problemId).eq("user_id", ctx.userId).maybeSingle();
      if (!prob?.image_path) return { ok: false, error: "문제를 찾지 못했어요." };
      const dataUrl = await loadAsDataUrl(ctx.admin, prob.image_path as string);
      if (!dataUrl) return { ok: false, error: "문제 그림을 읽지 못했어요." };
      try {
        const { unit, model, usage } = await labelUnit(dataUrl, str(ctx.params.hint, 60));
        const estKrw = usage ? gradingEstKrw(lunaUsage(usage), OPENAI_UNIT_MODEL) : undefined;
        if (estKrw && usage && !ctx.byok) {
          await logAiCost(ctx.admin, { userId: ctx.userId, jobId: ctx.jobId, kind: "problem", what: "luna 단원 표지", krw: estKrw, model, tokens: usage });
        }
        if (!unit) return { ok: false, error: "단원을 읽지 못했어요.", estKrw };
        const { error: upErr } = await ctx.admin.from("problem_units").upsert({ problem_id: problemId, user_id: ctx.userId, unit, model }, { onConflict: "problem_id" });
        if (upErr) return { ok: false, error: `단원을 저장하지 못했어요: ${upErr.message}`, estKrw };
        return { ok: true, result: { unit, model }, estKrw, model };
      } catch (err) {
        return { ok: false, error: errorMessage(err, "단원 표지를 달지 못했어요.") };
      }
    },
  },

  // **변형문제**(`/variants`, 무제한 계정 전용 — 시험 중). 수정하기처럼 서버에서 돈다: sol 이 변형을 설계(강도 선택) →
  // 그림 모델이 원본을 고쳐 그림(품질 선택) → 지정한 폴더의 묶음(`params.categoryId`)에 해설·정답과 함께 저장. 화면을 닫아도 끝까지 간다.
  variant: {
    deposit: () => 0,
    flat: true,
    needsOpenAI: true,
    unlimitedOnly: true,
    images: { min: 1, max: 1 },
    name: "변형문제",
    async run(ctx) {
      const t0 = Date.now();
      const effortRaw = str(ctx.params.effort, 12);
      const effort = ["low", "medium", "high"].includes(effortRaw) ? effortRaw : "medium";
      const qRaw = str(ctx.params.quality, 12);
      const quality = ["low", "medium", "high", "xhigh", "max"].includes(qRaw) ? qRaw : undefined;
      const copies = Math.min(5, Math.max(1, Math.round(Number(ctx.params.copies) || 1)));
      const copy = Math.min(copies, Math.max(1, Math.round(Number(ctx.params.copy) || 1)));
      const categoryId = str(ctx.params.categoryId, 60);
      if (!/^[0-9a-f-]{36}$/i.test(categoryId)) return { ok: false, error: "저장할 묶음이 정해지지 않았어요." };
      const { data: cat } = await ctx.admin.from("categories").select("id").eq("id", categoryId).eq("user_id", ctx.userId).maybeSingle();
      if (!cat) return { ok: false, error: "저장할 묶음을 찾지 못했어요." };

      const level = readLevel(ctx.params.level);
      const novelty = readNovelty(ctx.params.novelty);
      // 바뀌는 설정은 사진 뒤(꼬리) — 지시문+원본이 앞에서 같아야 프롬프트 캐시에 맞는다.
      const tail = settingsTail(level, novelty, copy, copies);
      const planBudget = Math.min(150_000, ctx.deadlineMs - 70_000);
      const ask = await askSol(
        VARIANT_PROMPT,
        ctx.images,
        { byokApiKey: ctx.byokApiKey, modelIds: [], deadlineMs: planBudget, tag: ctx.tag },
        "변형 설계",
        { effort, cacheKey: "reprint-variant", tail },
      );
      let spent = ask.krw;
      if (ask.krw > 0 && !ctx.byok) {
        await logAiCost(ctx.admin, { userId: ctx.userId, jobId: ctx.jobId, kind: "problem", what: "sol 변형 설계", krw: ask.krw, tokens: solTokens(ask.usage) });
      }
      if (ask.text === null) return { ok: false, error: `sol 이 변형을 설계하지 못했어요. ${ask.fail.slice(0, 160)}`, estKrw: spent || undefined };
      let plan;
      try {
        plan = parseVariantPlan(ask.text);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "변형 계획을 읽지 못했어요.", estKrw: spent || undefined };
      }

      const left = ctx.deadlineMs - (Date.now() - t0);
      if (left < 45_000) return { ok: false, error: "설계에 시간이 너무 걸려 그림을 그릴 시간이 없었어요. sol 강도를 낮춰 보세요.", estKrw: spent || undefined };
      const w = Number(ctx.params.width);
      const h = Number(ctx.params.height);
      const gen = await runFigureGeneration({
        image: ctx.images[0],
        mode: "problem",
        korean: false,
        // 부분수정 방식: 개념형(문제를 새로 쓰는 것)이 아니면 수정하기와 같은 편집 프롬프트로 목록의 곳만 고치고,
        // 아래에서 안 바뀐 곳은 원본 픽셀 그대로 되돌린다(compositePatch). 개념형은 통째로 다시 쓰는 편집 프롬프트.
        ...(plan.kind === "concept" ? { variantNote: plan.edits } : { patchNote: plan.edits, patchStrong: true }),
        inputSize: w > 0 && h > 0 ? { width: w, height: h } : undefined,
        modelIds: figureImageModelIds(),
        byokApiKey: ctx.byokApiKey,
        deadlineMs: left,
        tag: ctx.tag,
        quality,
      });
      if (!gen.ok) return { ok: false, error: gen.error, estKrw: spent || undefined };
      if (gen.usage) {
        spent += gen.usage.estKrw;
        if (!ctx.byok) {
          await logAiCost(ctx.admin, { userId: ctx.userId, jobId: ctx.jobId, kind: "problem", what: `그림 변형${quality ? ` ${quality}` : ""}`, krw: gen.usage.estKrw, usd: gen.usage.estUsd, tokens: imageTokens(gen.usage) });
        }
      }

      let outUrl = gen.dataUrl;
      let kept = "";
      if (plan.kind !== "concept") {
        try {
          const b = splitDataUrl(ctx.images[0]);
          const e = splitDataUrl(gen.dataUrl);
          const comp = b && e ? await compositePatch(b.bytes, e.bytes) : null;
          if (comp) {
            outUrl = `data:${comp.mime};base64,${comp.bytes.toString("base64")}`;
            kept = ` · 안 바뀐 곳 ${Math.round(comp.keptRatio * 100)}%는 원본 그대로`;
          }
        } catch (e) {
          console.warn(`${ctx.tag} 변형 합성 실패 — 편집 결과를 그대로 씁니다:`, e instanceof Error ? e.message : e);
        }
      }
      // **제작 검수**: 기획(설계)대로 나왔는지 sol 이 원본과 견준다. 고칠 수 있는 결함이 있고 시간이 남으면 그 곳만 한 번 고친다
      // (다시 검수는 안 한다 — 원가). 검수가 실패하면 그림은 그대로 저장하고 "검수 못 함"으로 알린다.
      let review: (VariantReview & { fixed: boolean; skipped?: string; fixSuggestion?: string; finalChecked?: boolean }) | null = null;
      {
        const rLeft = ctx.deadlineMs - (Date.now() - t0);
        if (rLeft < 50_000) {
          review = { ok: false, solvedAnswer: "", answerMatches: true, trapsKept: true, settingsOk: true, issues: [], fixed: false, skipped: "시간이 모자라 검수를 건너뜀" };
        } else {
          const planJson = JSON.stringify({
            kind: plan.kind,
            difficulty: level,
            novelty,
            traps: plan.traps,
            changes: plan.changes.slice(0, 30),
            edits: plan.edits,
            new_answer: plan.newAnswer,
          });
          const rv = await askSol(
            VARIANT_REVIEW_PROMPT,
            [ctx.images[0], outUrl],
            { byokApiKey: ctx.byokApiKey, modelIds: [], deadlineMs: Math.min(100_000, rLeft - 15_000), tag: ctx.tag },
            "변형 검수",
            { effort: "medium", cacheKey: "reprint-variant-review", tail: `\n\nPLAN\n${planJson}` },
          );
          spent += rv.krw;
          if (rv.krw > 0 && !ctx.byok) {
            await logAiCost(ctx.admin, { userId: ctx.userId, jobId: ctx.jobId, kind: "problem", what: "sol 변형 검수", krw: rv.krw, tokens: solTokens(rv.usage) });
          }
          try {
            if (rv.text === null) throw new Error(rv.fail || "검수 실패");
            review = { ...parseVariantReview(rv.text), fixed: false };
          } catch (e) {
            review = { ok: false, solvedAnswer: "", answerMatches: true, trapsKept: true, settingsOk: true, issues: [], fixed: false, skipped: `검수 못 함 — ${e instanceof Error ? e.message.slice(0, 80) : ""}` };
          }
          const fixNote = review.issues.length ? reviewFixInstruction(review) : "";
          const fLeft = ctx.deadlineMs - (Date.now() - t0);
          if (fixNote && fLeft >= 60_000) {
            const fix = await runFigureGeneration({
              image: outUrl,
              mode: "problem",
              korean: false,
              patchNote: fixNote,
              patchStrong: true,
              modelIds: figureImageModelIds(),
              byokApiKey: ctx.byokApiKey,
              deadlineMs: fLeft - 10_000,
              tag: ctx.tag,
              // 검수 수정은 지적된 몇 곳만 고치고 나머지는 원본 픽셀로 되돌리는 작은 편집이라 medium 이면 충분하다
              // (장부: auto 평균 93원·medium 평균 36원). 사용자가 더 낮은 품질을 골랐으면 그 값을 쓴다.
              quality: quality === "low" ? "low" : "medium",
            });
            if (fix.ok) {
              if (fix.usage) {
                spent += fix.usage.estKrw;
                if (!ctx.byok) {
                  await logAiCost(ctx.admin, { userId: ctx.userId, jobId: ctx.jobId, kind: "problem", what: "그림 변형 검수 수정", krw: fix.usage.estKrw, usd: fix.usage.estUsd, tokens: imageTokens(fix.usage) });
                }
              }
              try {
                const b2 = splitDataUrl(outUrl);
                const e2 = splitDataUrl(fix.dataUrl);
                const comp2 = b2 && e2 ? await compositePatch(b2.bytes, e2.bytes) : null;
                outUrl = comp2 ? `data:${comp2.mime};base64,${comp2.bytes.toString("base64")}` : fix.dataUrl;
              } catch {
                outUrl = fix.dataUrl;
              }
              review.fixed = true;
              // **최종 검수**: 고친 그림을 한 번 더 견줘 남은 차이를 구한다. 그래도 계획과 다른 곳은 화면에서 사용자가 확인·수정한다.
              const lLeft = ctx.deadlineMs - (Date.now() - t0);
              if (lLeft >= 40_000) {
                const rv2 = await askSol(
                  VARIANT_REVIEW_PROMPT,
                  [ctx.images[0], outUrl],
                  { byokApiKey: ctx.byokApiKey, modelIds: [], deadlineMs: Math.min(90_000, lLeft - 10_000), tag: ctx.tag },
                  "변형 최종 검수",
                  { effort: "medium", cacheKey: "reprint-variant-review", tail: `\n\nPLAN\n${planJson}` },
                );
                spent += rv2.krw;
                if (rv2.krw > 0 && !ctx.byok) {
                  await logAiCost(ctx.admin, { userId: ctx.userId, jobId: ctx.jobId, kind: "problem", what: "sol 변형 최종 검수", krw: rv2.krw, tokens: solTokens(rv2.usage) });
                }
                try {
                  if (rv2.text === null) throw new Error(rv2.fail || "검수 실패");
                  review = { ...parseVariantReview(rv2.text), fixed: true, finalChecked: true };
                } catch {
                  /* 최종 검수를 못 했으면 첫 검수 결과를 그대로 둔다 */
                }
              }
            }
          }
          review.fixSuggestion = review.issues.length ? reviewFixInstruction(review) : "";
        }
      }
      const parts = splitDataUrl(outUrl);
      if (!parts) return { ok: false, error: "그린 그림을 읽지 못했어요.", estKrw: spent || undefined };
      const ext = parts.mime.includes("jpeg") ? "jpg" : "png";
      const path = `${ctx.userId}/${categoryId}/${crypto.randomUUID()}.${ext}`;
      if (!(await storeBytes(ctx.admin, path, parts.bytes, parts.mime))) {
        return { ok: false, error: "그림을 저장하지 못했어요.", estKrw: spent || undefined };
      }
      const { data: maxRow } = await ctx.admin
        .from("problems")
        .select("sort_order")
        .eq("category_id", categoryId)
        .order("sort_order", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      const no = Number(ctx.params.no);
      const { answer, type } = answerOf(plan.newAnswer);
      // **원본 사본**: 내보낼 때 "원본 → 변형들" 순서로 싣기 위해 원본 그림을 한 번 저장해 두고(같은 원본의 변형들이 나눠 쓴다)
      // 각 변형 행이 `box_range.variantOf` 로 가리킨다. 저장에 실패하면 변형은 그대로 두고 원본 연결만 없다.
      let variantOf: { key: string; label: string; path: string; no?: number; answer?: string } | undefined;
      const srcKey = str(ctx.params.srcKey, 200);
      const srcParts = srcKey ? splitDataUrl(ctx.images[0]) : null;
      if (srcKey && srcParts) {
        const originPath = `${ctx.userId}/_origins/${createHash("sha1").update(srcKey).digest("hex").slice(0, 24)}.jpg`;
        if (await storeBytes(ctx.admin, originPath, srcParts.bytes, srcParts.mime)) {
          variantOf = {
            key: srcKey,
            label: str(ctx.params.srcLabel, 120),
            path: originPath,
            ...(Number.isFinite(no) && no > 0 ? { no } : {}),
            ...(plan.originalAnswer ? { answer: cleanAnswerText(String(plan.originalAnswer)) } : {}),
          };
        }
      }
      const { data: row, error: insErr } = await ctx.admin
        .from("problems")
        .insert({
          category_id: categoryId,
          user_id: ctx.userId,
          image_path: path,
          latex: null,
          text_content: null,
          answer,
          answer_type: type,
          sort_order: (maxRow?.sort_order ?? 0) + 1,
          box_range: {
            ranges: null,
            fontPt: DEFAULT_FONT_PT,
            figures: toStoredFigures([
              {
                id: crypto.randomUUID(),
                markup: `<img src="${cardUrl(path)}" alt="" />`,
                layout: { scale: 100, offsetX: 0, offsetY: 0 },
                position: 0,
              },
            ]),
            ...(plan.solution ? { solution: plan.solution } : {}),
            ...(variantOf ? { variantOf } : {}),
            // 검수에서 남은 지적을 저장해 둔다 — 모아보기에서 지적된 것만 모아 고칠 수 있다.
            ...(review && review.issues.length
              ? {
                  variantReview: {
                    fixSuggestion: review.fixSuggestion ?? "",
                    issues: review.issues.slice(0, 8).map((i) => ({ kind: i.kind, where: String(i.where).slice(0, 160), problem: String(i.problem).slice(0, 300) })),
                    at: new Date().toISOString(),
                  },
                }
              : {}),
          },
        })
        .select("id")
        .single();
      if (insErr || !row) {
        await removeStored(ctx.admin, [path]);
        return { ok: false, error: `저장하지 못했어요: ${insErr?.message ?? ""}`, estKrw: spent || undefined };
      }
      // 묶음 안에서 1번부터 차례로 번호를 매긴다(원래 번호는 variantOf.no 에 남는다) — 같은 번호가 여럿 뜨면 구분이 안 된다.
      const { error: numErr } = await ctx.admin.rpc("assign_variant_number", { p_problem: row.id });
      if (numErr) console.warn(`${ctx.tag} 변형 번호 매기기 실패:`, numErr.message);
      return {
        ok: true,
        result: {
          imagePath: path,
          categoryId,
          problemId: row.id,
          kind: plan.kind,
          summary: plan.summary,
          changes: plan.changes.slice(0, 12),
          originalAnswer: plan.originalAnswer,
          newAnswer: plan.newAnswer,
          solution: plan.solution,
          edits: plan.edits,
          traps: plan.traps,
          level,
          novelty,
          review,
          copy,
          ...(ctx.unlimited || ctx.byok ? { estKrw: Math.round(spent * 10) / 10 } : {}),
        },
        estKrw: spent > 0 ? spent : undefined,
        model: gen.modelId,
        note: `${plan.kind || "변형"} · 정답 ${plan.newAnswer || "?"}${kept}${
          review ? (review.skipped ? ` · ${review.skipped}` : review.ok ? " · 검수 통과" : ` · 검수 ${review.issues.length}건${review.fixed ? " 고침" : ""}`) : ""
        }`,
      };
    },
  },

  // **변형문제 검수 수정**: 이미 만든 변형 그림을 다시 만들지 않고, 사용자가 확인한 지시대로 그 곳만 고친다(수정하기와 같은 부분 편집 + 합성).
  variantFix: {
    deposit: () => 0,
    flat: true,
    needsOpenAI: true,
    unlimitedOnly: true,
    images: { min: 0, max: 0 },
    name: "변형문제 수정",
    async run(ctx) {
      const t0 = Date.now();
      const problemId = str(ctx.params.problemId, 60);
      let instruction = str(ctx.params.instruction, 2500);
      if (!/^[0-9a-f-]{36}$/i.test(problemId)) return { ok: false, error: "문제가 정해지지 않았어요." };
      const { data: prob } = await ctx.admin
        .from("problems")
        .select("id,category_id,image_path,box_range")
        .eq("id", problemId)
        .eq("user_id", ctx.userId)
        .maybeSingle();
      if (!prob?.image_path) return { ok: false, error: "문제를 찾지 못했어요." };
      if (!instruction.trim()) {
        // 지시를 안 주면 저장해 둔 검수 지적을 쓴다.
        const saved = (prob.box_range as { variantReview?: { fixSuggestion?: string } } | null)?.variantReview?.fixSuggestion;
        instruction = typeof saved === "string" ? saved.slice(0, 2500) : "";
      }
      if (!instruction.trim()) return { ok: false, error: "고칠 내용이 비어 있어요." };
      const base = await loadAsDataUrl(ctx.admin, prob.image_path as string);
      if (!base) return { ok: false, error: "문제 그림을 읽지 못했어요." };
      const gen = await runFigureGeneration({
        image: base,
        mode: "problem",
        korean: false,
        patchNote: instruction,
        patchStrong: true,
        modelIds: figureImageModelIds(),
        byokApiKey: ctx.byokApiKey,
        deadlineMs: ctx.deadlineMs - (Date.now() - t0) - 10_000,
        tag: ctx.tag,
        quality: "medium",
      });
      if (!gen.ok) return { ok: false, error: gen.error };
      let spent = 0;
      if (gen.usage) {
        spent = gen.usage.estKrw;
        if (!ctx.byok) {
          await logAiCost(ctx.admin, { userId: ctx.userId, jobId: ctx.jobId, kind: "problem", what: "그림 변형 검수 수정", krw: gen.usage.estKrw, usd: gen.usage.estUsd, tokens: imageTokens(gen.usage) });
        }
      }
      let outUrl = gen.dataUrl;
      try {
        const b = splitDataUrl(base);
        const e = splitDataUrl(gen.dataUrl);
        const comp = b && e ? await compositePatch(b.bytes, e.bytes) : null;
        if (comp) outUrl = `data:${comp.mime};base64,${comp.bytes.toString("base64")}`;
      } catch {
        /* 합성 실패 — 편집 결과를 그대로 쓴다 */
      }
      const parts = splitDataUrl(outUrl);
      if (!parts) return { ok: false, error: "고친 그림을 읽지 못했어요.", estKrw: spent || undefined };
      const ext = parts.mime.includes("jpeg") ? "jpg" : "png";
      const path = `${ctx.userId}/${prob.category_id}/${crypto.randomUUID()}.${ext}`;
      if (!(await storeBytes(ctx.admin, path, parts.bytes, parts.mime))) return { ok: false, error: "그림을 저장하지 못했어요.", estKrw: spent || undefined };
      const br = ((prob.box_range ?? {}) as Record<string, unknown>) || {};
      const figures = Array.isArray(br.figures) ? (br.figures as Record<string, unknown>[]) : [];
      const nextFigures = figures.length
        ? figures.map((f, i) => (i === 0 ? { ...f, markup: `<img src="${cardUrl(path)}" alt="" />` } : f))
        : figures;
      const { error: upErr } = await ctx.admin
        .from("problems")
        .update({ image_path: path, box_range: { ...br, figures: nextFigures, variantReview: undefined } })
        .eq("id", problemId)
        .eq("user_id", ctx.userId);
      if (upErr) {
        await removeStored(ctx.admin, [path]);
        return { ok: false, error: `저장하지 못했어요: ${upErr.message}`, estKrw: spent || undefined };
      }
      // 옛 그림은 다른 문제가 같이 쓰지 않을 때만 지운다.
      const { count } = await ctx.admin.from("problems").select("id", { count: "exact", head: true }).eq("image_path", prob.image_path as string);
      if (!count) await removeStored(ctx.admin, [prob.image_path as string]);
      return {
        ok: true,
        result: { imagePath: path, problemId, ...(ctx.unlimited || ctx.byok ? { estKrw: Math.round(spent * 10) / 10 } : {}) },
        estKrw: spent > 0 ? spent : undefined,
        model: gen.modelId,
        note: "검수 지적대로 고쳤어요",
      };
    },
  },

};

/** 한 대화에서 오갈 수 있는 말 수(사용자 + sol). 끝없이 늘어 요금이 커지는 것을 막는다. */
export const MAX_CHAT_MESSAGES = 24;

/** 넣을 때 `params` 를 이만큼까지만 받는다(대화·문단 목록이 가장 크다). */
export const MAX_TASK_PARAMS_CHARS = 200_000;
