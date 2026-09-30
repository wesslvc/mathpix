import { NextRequest, NextResponse } from "next/server";
import { requireFontAdmin } from "../kice-font/auth";
import { GradeError, pollVisionBackground, startVisionBackground } from "@/lib/gradeExam";
import { figureImageModelIds } from "@/lib/figureImageGen";
import { runFigureGeneration } from "@/lib/figureRun";
import { gradingEstKrw } from "@/lib/tokens";
import {
  parseTranscription,
  parseVerify,
  TRANSCRIBE_PROMPT,
  VERIFY_PROMPT,
} from "@/lib/problemCompare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 문제 한 장을 통째로 그리는 데 1분 남짓 걸린다(운영 `/api/figure` 와 같은 한도).
export const maxDuration = 300;

/**
 * **문제 글자 정확도 비교**(`/admin/compare-problem`)의 서버 쪽.
 *
 * 무제한 계정만 쓴다(`requireFontAdmin`). 시험용이라 토큰을 차감하지 않는다.
 * 비용은 공표 단가로 계산해 돌려준다(그림은 `FigureUsage.estKrw`, sol 은
 * `gradingEstKrw`) — 화면이 더하기만 한다.
 *
 * `task`:
 *  - `generate`  : sunburst 로 그리기(문제 통째로 `problem` · 그림 하나 `figure`).
 *                  `quality` 를 주면 그 값을 보낸다(운영은 안 보낸다 — 올려서 재 보는 용도).
 *                  운영과 **같은 알맹이**(`runFigureGeneration`)라 결과가 운영과 같다.
 *  - `verify`    : sol 이 원본과 다시 만든 것을 대조(백그라운드).
 *  - `transcribe`: sol 이 본문을 글자·LaTeX 로 옮기고 그림 자리를 짚는다(백그라운드).
 * sol 호출은 백그라운드로 건다 — 강도를 올리면 300초를 넘길 수 있다.
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
  const task = body.task;

  if (task === "generate") {
    if (!isImage(body.image)) {
      return NextResponse.json({ error: "그림이 필요합니다." }, { status: 400 });
    }
    const mode = body.mode === "figure" ? "figure" : "problem";
    const w = Number(body.width);
    const h = Number(body.height);
    const quality =
      typeof body.quality === "string" && ["low", "medium", "high", "auto"].includes(body.quality)
        ? body.quality
        : undefined;
    const t0 = Date.now();
    const out = await runFigureGeneration({
      image: body.image,
      mode,
      korean: false,
      instruction: typeof body.instruction === "string" ? body.instruction.slice(0, 4000) : undefined,
      inputSize: w > 0 && h > 0 ? { width: w, height: h } : undefined,
      modelIds: figureImageModelIds(),
      deadlineMs: (maxDuration - 15) * 1000,
      tag: "compare-problem",
      quality,
    });
    const ms = Date.now() - t0;
    if (!out.ok) return NextResponse.json({ error: out.error, ms }, { status: out.status });
    console.info(
      `[compare-problem] generate mode=${mode} quality=${quality ?? "-"} ms=${ms} krw=${out.usage?.estKrw ?? "?"}`,
    );
    return NextResponse.json({
      image: out.dataUrl,
      model: out.modelId,
      usage: out.usage ?? null,
      quality: quality ?? null,
      ms,
    });
  }

  const model = typeof body.model === "string" ? body.model.trim() : "";
  const effort = typeof body.effort === "string" ? body.effort.trim() : "";
  if (!/^gpt-[\w.-]{2,60}$/.test(model)) {
    return NextResponse.json({ error: "model 이 이상합니다." }, { status: 400 });
  }
  if (effort && !/^[a-z]{1,16}$/.test(effort)) {
    return NextResponse.json({ error: "effort 값이 이상합니다." }, { status: 400 });
  }

  try {
    if (task === "verify") {
      if (!isImage(body.original) || !isImage(body.recreated)) {
        return NextResponse.json({ error: "원본과 다시 만든 그림이 필요합니다." }, { status: 400 });
      }
      const jobId = await startVisionBackground(
        VERIFY_PROMPT,
        [body.original, body.recreated],
        model,
        effort || undefined,
      );
      return NextResponse.json({ jobId });
    }
    if (task === "transcribe") {
      if (!isImage(body.image)) {
        return NextResponse.json({ error: "문제 사진이 필요합니다." }, { status: 400 });
      }
      const jobId = await startVisionBackground(TRANSCRIBE_PROMPT, body.image, model, effort || undefined);
      return NextResponse.json({ jobId });
    }
  } catch (err) {
    const status = err instanceof GradeError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "시작하지 못했습니다." },
      { status: status >= 400 && status < 600 ? status : 500 },
    );
  }
  return NextResponse.json({ error: "task 가 이상합니다." }, { status: 400 });
}

/** 백그라운드 sol 작업을 묻는다. `?id=resp_...&task=verify|transcribe` */
export async function GET(req: NextRequest) {
  const gate = await requireFontAdmin();
  if (!gate.ok) return gate.response;
  const id = req.nextUrl.searchParams.get("id") ?? "";
  const task = req.nextUrl.searchParams.get("task");
  if (!/^resp_[\w-]{8,200}$/.test(id)) {
    return NextResponse.json({ error: "id 가 이상합니다." }, { status: 400 });
  }
  try {
    const poll = await pollVisionBackground(id);
    if (poll.status !== "done") return NextResponse.json(poll);
    const cost = {
      usage: poll.usage ?? null,
      model: poll.model,
      estKrw: poll.usage ? (gradingEstKrw(poll.usage, poll.model) ?? null) : null,
    };
    try {
      if (task === "verify") {
        return NextResponse.json({ status: "done", diffs: parseVerify(poll.text), ...cost });
      }
      return NextResponse.json({ status: "done", ...parseTranscription(poll.text), raw: poll.text, ...cost });
    } catch (err) {
      return NextResponse.json({
        status: "error",
        message: err instanceof Error ? err.message : "결과를 읽지 못했습니다.",
        ...cost,
      });
    }
  } catch (err) {
    return NextResponse.json(
      { status: "error", message: err instanceof Error ? err.message : "상태를 못 읽었습니다." },
      { status: 502 },
    );
  }
}
