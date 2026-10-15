import { NextRequest, NextResponse } from "next/server";
import { requireFontAdmin } from "../admin/kice-font/auth";
import {
  GradeError,
  OPENAI_TEXT_MODEL,
  deleteVisionResponse,
  pollVisionBackground,
  startVisionBackground,
} from "@/lib/gradeExam";
import { figureImageModelIds } from "@/lib/figureImageGen";
import { runFigureGeneration } from "@/lib/figureRun";
import { gradingEstKrw } from "@/lib/tokens";
import { parseVariantPlan, VARIANT_PROMPT } from "@/lib/variantPlan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * **변형문제 생성**(`/variants`)의 서버 쪽 — 시험 중이라 **무제한 계정만** 쓴다(`requireFontAdmin`), 토큰은 안 뗀다.
 *
 * - `POST {task:"plan", image}`     : sol(`OPENAI_TEXT_MODEL`)이 문제를 이해·풀고 변형을 설계한다(백그라운드).
 *                                     → `{jobId}`, `GET ?id=` 로 묻는다 → `{status:"done", plan, estKrw}`.
 * - `POST {task:"generate", image, edits, width, height, quality?}` : 그림 모델(sunburst)이 원본 이미지를 바탕으로
 *                                     `edits` 대로 고쳐 그린다(그림·도표도 새 숫자에 맞게 고친다).
 */
export async function POST(req: NextRequest) {
  const gate = await requireFontAdmin();
  if (!gate.ok) return gate.response;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }
  const isImage = (v: unknown): v is string => typeof v === "string" && v.startsWith("data:image/");
  if (!isImage(body.image)) return NextResponse.json({ error: "그림이 필요합니다." }, { status: 400 });

  if (body.task === "plan") {
    try {
      const effort = process.env.OPENAI_VARIANT_EFFORT?.trim() || "high";
      const jobId = await startVisionBackground(
        VARIANT_PROMPT,
        [body.image],
        OPENAI_TEXT_MODEL,
        effort === "default" ? undefined : effort,
        undefined,
        { cacheKey: "reprint-variant" },
      );
      return NextResponse.json({ jobId });
    } catch (err) {
      const status = err instanceof GradeError ? err.status : 500;
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "시작하지 못했습니다." },
        { status: status >= 400 && status < 600 ? status : 500 },
      );
    }
  }

  if (body.task === "generate") {
    const edits = typeof body.edits === "string" ? body.edits.trim().slice(0, 6000) : "";
    if (edits.length < 10) return NextResponse.json({ error: "편집 지시가 필요합니다." }, { status: 400 });
    const w = Number(body.width);
    const h = Number(body.height);
    const quality =
      typeof body.quality === "string" && ["low", "medium", "high", "xhigh", "max", "auto"].includes(body.quality)
        ? body.quality
        : undefined;
    const t0 = Date.now();
    const out = await runFigureGeneration({
      image: body.image,
      mode: "problem",
      korean: false,
      variantNote: edits,
      inputSize: w > 0 && h > 0 ? { width: w, height: h } : undefined,
      modelIds: figureImageModelIds(),
      deadlineMs: (maxDuration - 15) * 1000,
      tag: "variant",
      quality,
    });
    const ms = Date.now() - t0;
    if (!out.ok) return NextResponse.json({ error: out.error, ms }, { status: out.status });
    return NextResponse.json({ image: out.dataUrl, model: out.modelId, usage: out.usage ?? null, quality: quality ?? null, ms });
  }
  return NextResponse.json({ error: "task 가 이상합니다." }, { status: 400 });
}

/** 변형 계획(sol 백그라운드)을 묻는다. `?id=resp_...` */
export async function GET(req: NextRequest) {
  const gate = await requireFontAdmin();
  if (!gate.ok) return gate.response;
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!/^resp_[\w-]{8,200}$/.test(id)) return NextResponse.json({ error: "id 가 이상합니다." }, { status: 400 });
  try {
    const poll = await pollVisionBackground(id);
    if (poll.status !== "done") return NextResponse.json(poll);
    void deleteVisionResponse(id);
    const estKrw = poll.usage ? (gradingEstKrw(poll.usage, poll.model) ?? null) : null;
    try {
      return NextResponse.json({ status: "done", plan: parseVariantPlan(poll.text), estKrw, model: poll.model });
    } catch (err) {
      return NextResponse.json({
        status: "error",
        message: err instanceof Error ? err.message : "결과를 읽지 못했습니다.",
        estKrw,
      });
    }
  } catch (err) {
    return NextResponse.json(
      { status: "error", message: err instanceof Error ? err.message : "상태를 못 읽었습니다." },
      { status: 502 },
    );
  }
}
