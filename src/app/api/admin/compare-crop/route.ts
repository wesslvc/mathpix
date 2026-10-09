import { NextRequest, NextResponse } from "next/server";
import { requireFontAdmin } from "../kice-font/auth";
import { detectProblems, OPENAI_DETECT_MODEL } from "@/lib/detectProblems";
import { gradingEstKrw, USD_KRW_RATE } from "@/lib/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * **지면 자르기 모델 비교**(`/admin/compare-crop`, 2026-10-09 사용자 — "자동 자르기 비교 화면 만들어 줘"·"테스트하는 걸 지면 자르기로").
 *
 * 지면 사진 한 장을 정해 준 모델 **하나로만** 영역 찾기한다(`detectProblems(image, only)` — 운영처럼 실패하면 luna 로 넘어가지
 * 않는다). 프롬프트·해석(단을 넘어 이어진 문제 묶기 `cont` 포함)은 운영과 **같다**. 화면이 모델마다 동시에 불러 나란히 놓고,
 * 글자에 맞춰 다듬기·문제마다 다시 맞추기는 화면이 운영과 같은 함수로 한다. 무제한 계정만, 토큰은 안 뗀다.
 */
export async function POST(req: NextRequest) {
  const gate = await requireFontAdmin();
  if (!gate.ok) return gate.response;
  const body = (await req.json().catch(() => null)) as {
    image?: unknown;
    engine?: unknown;
    model?: unknown;
    effort?: unknown;
  } | null;
  const image = typeof body?.image === "string" ? body.image : "";
  const engine =
    body?.engine === "gemini" ? "gemini" : body?.engine === "openai" ? "openai" : body?.engine === "openrouter" ? "openrouter" : null;
  const model = typeof body?.model === "string" ? body.model.trim() : "";
  const effort = typeof body?.effort === "string" && /^[a-z]{1,16}$/.test(body.effort) ? body.effort : undefined;
  if (!image.startsWith("data:image/") || !engine || !/^[\w./:-]{1,100}$/.test(model)) {
    return NextResponse.json({ error: "image·engine·model 이 필요합니다." }, { status: 400 });
  }
  if (engine === "openai" && model !== OPENAI_DETECT_MODEL) {
    return NextResponse.json({ error: `OpenAI 쪽은 ${OPENAI_DETECT_MODEL} 만 됩니다.` }, { status: 400 });
  }
  const t0 = Date.now();
  try {
    const r = await detectProblems(image, { engine, model, effort });
    // 오픈라우터는 응답에 실제 청구액을 준다 — 단가표를 따로 들 필요가 없다(이미지 토큰 계산까지 반영된 값).
    const estKrw = r.usage?.costUsd != null
      ? r.usage.costUsd * USD_KRW_RATE
      : r.usage
      ? gradingEstKrw(
          { inputTokens: r.usage.input, outputTokens: r.usage.output, cachedInputTokens: r.usage.cached },
          engine === "openai" ? OPENAI_DETECT_MODEL : `${engine}:${model}`,
        )
      : undefined;
    return NextResponse.json({ ok: true, ms: Date.now() - t0, problems: r.problems, usage: r.usage ?? null, estKrw: estKrw ?? null });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[compare-crop] ${engine} ${model} 실패 (${Date.now() - t0}ms):`, msg.slice(0, 800));
    return NextResponse.json({ ok: false, ms: Date.now() - t0, error: msg.slice(0, 700) });
  }
}
