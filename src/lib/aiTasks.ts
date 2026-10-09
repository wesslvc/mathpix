// **서버 대기열의 짧은 AI 작업들**(`figure_jobs.mode = 'task'`). **서버 전용.**
//
// 사용자 — "모든 ai작업은 서버에서 돌리고 사용자한테 대기열에 들어가서 진행중인걸 볼수있게할것"(2026-10-01).
// 예전에는 글자 인식·번호 읽기·영역 찾기·제목 짓기·채점·답지 읽기·지문 다시 인식·sol 조판·sol 대화를 화면이 라우트에
// 직접 보내고 기다렸다. 이제 화면은 `/api/figure-jobs`(mode "task")에 넣고 결과를 받아 가며, 실제 호출은 일꾼
// (`/api/figure-jobs/run`)이 여기 있는 `run` 으로 한다. 진행은 그림 작업과 같은 대기열 패널에 뜬다.
//
// 과금은 그림 작업과 같은 모양이다: **넣을 때 보증금을 걸고**(세션 차감), 일꾼이 끝나면 쓴 만큼으로 맞춘다
// (남으면 돌려주고 모자라면 서비스용 차감 함수로 더 받는다). 실패하면 전부 돌려준다.

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
} from "./tokens";
import { logAiCost, solTokens } from "./costLog";
import {
  parseSolChat,
  parseTranscription,
  planToChanges,
  solChatPrompt,
  TYPESET_PROMPT,
  type ChatTurn,
} from "./problemCompare";
import { askSol, loadPatchImages } from "./problemLoopRun";
import { cropOneProblem, findProblemNumber, lunaUsage, placeFigures } from "./lunaQuick";
import type { ProblemBox } from "./problemBoxes";

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
  | "chat";

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
];

/**
 * **대기열을 안 타고 곧바로 부르는 일들**(2026-10-04, 사용자 — "luna 는 금방금방 끝나니까 서버에서 돌릴 필요는 없어, 더 빠르게
 * 할 수 있다면"). 전부 luna(+고정 요금)라 몇 초~수십 초면 끝난다 — 줄에 넣고 일꾼을 깨우고 1~2초마다 묻는 왕복을 뺀다.
 * `/api/ai-direct` 가 같은 `run` 을 요청 안에서 돌린다. 화면(`aiTask.ts` 의 `DIRECT_KINDS`)도 같은 목록을 든다.
 */
export const DIRECT_TASKS: readonly TaskKind[] = ["crop", "figures", "numberBox", "detect", "title", "grade", "answerKey"];

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

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof GradeError || err instanceof DetectError) return err.message;
  return err instanceof Error ? err.message : fallback;
}

const mathpixMock = () => !process.env.MATHPIX_APP_ID || !process.env.MATHPIX_APP_KEY;

export const TASKS: Record<TaskKind, TaskDef> = {
  // Mathpix 글자 인식(결과 화면으로 가는 "글자로 인식" · 번호 읽기 · 전체 번호 인식).
  ocr: {
    // mock(키 미설정)은 실제 호출이 아니라 받지 않는다. 무제한·BYOK 는 Mathpix 를 무료로 쓴다(넣는 쪽이 거른다).
    deposit: () => (mathpixMock() ? 0 : OCR_TOKEN_COST),
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
      const cost = async (usage: DetectUsage | undefined, what: string, kind: "passage" | "problem") => {
        if (!usage) return undefined;
        const krw = gradingEstKrw(
          { inputTokens: usage.input, outputTokens: usage.output, ...(usage.cached ? { cachedInputTokens: usage.cached } : {}) },
          OPENAI_DETECT_MODEL,
        );
        if (krw) await logAiCost(ctx.admin, { userId: ctx.userId, jobId: ctx.jobId, kind, what, krw, tokens: usage });
        return krw;
      };
      try {
        if (mode === "korean-passage") {
          const { passages, figures, model, usage } = await detectKoreanPassages(ctx.images[0]);
          const estKrw = await cost(usage, "지문 자리 찾기", "passage");
          return { ok: true, result: { regions: passages, figures, model }, model, estKrw };
        }
        if (mode === "korean-question") {
          const { regions, model, usage } = await detectKoreanQuestions(ctx.images[0], readBoxes(ctx.params.passages));
          const estKrw = await cost(usage, "국어 문제 자리 찾기", "passage");
          return { ok: true, result: { regions, model }, model, estKrw };
        }
        const { problems, model, usage } = await detectProblems(ctx.images[0]);
        const estKrw = await cost(usage, "지면 자리 찾기", "problem");
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
        const { box, model, usage, number, choices, retried, rotate, advice, adviceReason } = await cropOneProblem(ctx.images[0]);
        const estKrw = usage ? gradingEstKrw(lunaUsage(usage), OPENAI_DETECT_MODEL) : undefined;
        if (estKrw && usage) {
          await logAiCost(ctx.admin, { userId: ctx.userId, jobId: ctx.jobId, kind: "problem", what: "luna 자동 자르기", krw: estKrw, tokens: usage });
        }
        const note = !box
          ? "문제 자리를 못 찾았어요"
          : `${number ? `번호 ${number}` : "번호 못 봄"} · 선지 ${choices}개${retried ? " (다시 봄)" : ""}${rotate ? ` · ${rotate * 90}° 돌림` : ""}${advice ? ` · 추천 ${advice === "asis" ? "원본 그대로" : "AI로 다시 그리기"}` : ""}`;
        return { ok: true, result: { box, model, number, choices, rotate, advice, adviceReason }, model, estKrw, note };
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
    deposit: () => 1,
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
    deposit: () => SOL_TYPESET_TOKENS,
    flat: true,
    needsOpenAI: true,
    images: { min: 1, max: 1 },
    name: "sol 조판 인식",
    async run(ctx) {
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
    deposit: () => 20,
    flat: false,
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
};

/** 한 대화에서 오갈 수 있는 말 수(사용자 + sol). 끝없이 늘어 요금이 커지는 것을 막는다. */
export const MAX_CHAT_MESSAGES = 24;

/** 넣을 때 `params` 를 이만큼까지만 받는다(대화·문단 목록이 가장 크다). */
export const MAX_TASK_PARAMS_CHARS = 200_000;
