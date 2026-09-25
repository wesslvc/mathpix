import { NextRequest, NextResponse } from "next/server";
import { requireFontAdmin } from "../kice-font/auth";
import {
  callGeminiJson,
  GradeError,
  pollKoreanTextBackground,
  pollVisionBackground,
  startKoreanTextBackground,
  startVisionBackground,
} from "@/lib/gradeExam";
import {
  KOREAN_POLYGON_PROMPT,
  KOREAN_PROMPT,
  parseKorean,
  parseKoreanPolygons,
} from "@/lib/detectProblems";

/** 위치 찾기 결과를 모양에 맞게 읽는다. 네모는 `regions`, 다각형은 `polygons`. */
function readDetect(text: string, polygon: boolean) {
  return polygon ? { polygons: parseKoreanPolygons(text) } : { regions: parseKorean(text) };
}
import { gradingEstKrw } from "@/lib/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 최대 추론 강도는 오래 걸린다. 함수 한도 끝까지 쓰고 우리가 15초 앞에서 끊는다.
export const maxDuration = 300;

/**
 * **국어 지문 인식 모델 비교**(`/admin/compare-korean`).
 *
 * 한 지문을 정해 준 모델 **하나로만** 읽는다 — 운영 경로처럼 실패하면 다른
 * 모델로 내려가지 않는다(내려가면 무엇을 견줬는지 알 수 없다). 화면이 두 모델에
 * 각각 이 라우트를 불러 나란히 놓는다.
 *
 * `task` 가 둘이다 — `read`(지문 옮겨 적기, 기본 · OpenAI 만)와 `detect`(지면에서 지문·문제
 * 위치 찾기). `detect` 는 운영 국어 모드의 자동 찾기와 **같은 프롬프트**
 * (`KOREAN_PROMPT`)·같은 해석(`parseKorean`)을 쓰고 모델만 바꿔 본다.
 *
 * 무제한 계정만 쓴다(`requireFontAdmin`). 시험용이라 토큰을 차감하지 않는다.
 * 모델 이름은 모양만 확인한다 — 이름을 지어내지 않고, 화면에 적힌 것(=확인해
 * 둔 것)을 그대로 쓴다.
 */
export async function POST(req: NextRequest) {
  const gate = await requireFontAdmin();
  if (!gate.ok) return gate.response;

  let body: {
    image?: unknown;
    provider?: unknown;
    model?: unknown;
    effort?: unknown;
    task?: unknown;
    shape?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }
  const image = typeof body.image === "string" ? body.image : "";
  if (!image.startsWith("data:image/")) {
    return NextResponse.json({ error: "지문 사진이 필요합니다." }, { status: 400 });
  }
  const provider = body.provider === "gemini" ? "gemini" : body.provider === "openai" ? "openai" : null;
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const effort = typeof body.effort === "string" ? body.effort.trim() : "";
  if (!provider || !/^[\w.-]{3,80}$/.test(model)) {
    return NextResponse.json({ error: "provider 와 model 이 필요합니다." }, { status: 400 });
  }
  if (effort && !/^[a-z]{1,16}$/.test(effort)) {
    return NextResponse.json({ error: "effort 값이 이상합니다." }, { status: 400 });
  }
  const detect = body.task === "detect";
  const polygon = body.shape === "polygon";
  const detectPrompt = polygon ? KOREAN_POLYGON_PROMPT : KOREAN_PROMPT;

  if (detect && provider === "openai") {
    try {
      const jobId = await startVisionBackground(detectPrompt, image, model, effort || undefined);
      console.info(`[compare-korean] 위치 찾기 시작 model=${model} effort=${effort || "-"} id=${jobId}`);
      return NextResponse.json({ jobId });
    } catch (err) {
      const status = err instanceof GradeError ? err.status : 500;
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "위치 찾기를 시작하지 못했습니다." },
        { status: status >= 400 && status < 600 ? status : 500 },
      );
    }
  }
  if (detect) {
    const t0 = Date.now();
    try {
      const out = await callGeminiJson(detectPrompt, image, model);
      const ms = Date.now() - t0;
      return NextResponse.json({
        ...readDetect(out.text, polygon),
        usage: out.usage,
        model: out.model,
        estKrw: out.usage ? (gradingEstKrw(out.usage, out.model) ?? null) : null,
        ms,
      });
    } catch (err) {
      const status = err instanceof GradeError ? err.status : 500;
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "위치를 찾지 못했습니다.", ms: Date.now() - t0 },
        { status: status >= 400 && status < 600 ? status : 500 },
      );
    }
  }

  // **지문 읽기는 OpenAI 만**(2026-09-25, 사용자 지시 — 비교 화면에서는 추론
  // 강도만 바꿔 본다). 백그라운드로 건다 — 강도가 높으면 300초 한도를 넘긴다
  // (실제로 넘겼다). 여기서는 id 만 돌려주고 화면이 GET 으로 물어본다.
  if (provider !== "openai") {
    return NextResponse.json({ error: "지문 읽기는 OpenAI 모델만 견줍니다." }, { status: 400 });
  }
  try {
    const jobId = await startKoreanTextBackground(image, model, effort || undefined);
    console.info(`[compare-korean] 백그라운드 시작 model=${model} effort=${effort || "-"} id=${jobId}`);
    return NextResponse.json({ jobId });
  } catch (err) {
    const status = err instanceof GradeError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "지문 인식을 시작하지 못했습니다." },
      { status: status >= 400 && status < 600 ? status : 500 },
    );
  }
}

/** 백그라운드로 건 OpenAI 작업이 끝났는지 묻는다. `?id=resp_...&task=read|detect` */
export async function GET(req: NextRequest) {
  const gate = await requireFontAdmin();
  if (!gate.ok) return gate.response;
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!/^resp_[\w-]{8,200}$/.test(id)) {
    return NextResponse.json({ error: "id 가 이상합니다." }, { status: 400 });
  }
  try {
    if (req.nextUrl.searchParams.get("task") === "detect") {
      const poll = await pollVisionBackground(id);
      if (poll.status !== "done") return NextResponse.json(poll);
      try {
        return NextResponse.json({
          status: "done",
          ...readDetect(poll.text, req.nextUrl.searchParams.get("shape") === "polygon"),
          usage: poll.usage,
          model: poll.model,
          estKrw: poll.usage ? (gradingEstKrw(poll.usage, poll.model) ?? null) : null,
        });
      } catch (err) {
        return NextResponse.json({
          status: "error",
          message: err instanceof Error ? err.message : "영역을 읽지 못했습니다.",
        });
      }
    }
    const poll = await pollKoreanTextBackground(id);
    if (poll.status !== "done") return NextResponse.json(poll);
    console.info(
      `[compare-korean] 백그라운드 끝 model=${poll.model} id=${id} ` +
        `in=${poll.usage?.inputTokens ?? "?"} out=${poll.usage?.outputTokens ?? "?"}`,
    );
    return NextResponse.json({
      status: "done",
      blocks: poll.blocks,
      usage: poll.usage,
      model: poll.model,
      estKrw: poll.usage ? (gradingEstKrw(poll.usage, poll.model) ?? null) : null,
    });
  } catch (err) {
    return NextResponse.json(
      { status: "error", message: err instanceof Error ? err.message : "상태를 못 읽었습니다." },
      { status: 502 },
    );
  }
}
