import { NextRequest, NextResponse } from "next/server";
import { requireFontAdmin } from "../kice-font/auth";
import { cropOneProblem, lunaUsage } from "@/lib/lunaQuick";
import { gradingEstKrw } from "@/lib/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * **자동 자르기 모델 비교**(`/admin/compare-crop`, 2026-10-09 사용자 — "자동 자르기 비교 화면 만들어 줘").
 *
 * 사진 한 장을 정해 준 모델 **하나로만** 자른다(운영처럼 실패하면 luna 로 넘어가지 않는다). 프롬프트·해석·선지 다시 묻기는 운영
 * 자동 자르기(`cropOneProblem`)와 **같다** — 바뀌는 것은 모델·강도뿐이다. 화면이 모델마다 이 라우트를 동시에 불러 나란히 놓는다.
 * 무제한 계정만, 토큰은 안 뗀다.
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
  const engine = body?.engine === "gemini" ? "gemini" : body?.engine === "openai" ? "openai" : null;
  const model = typeof body?.model === "string" ? body.model.trim() : "";
  const effort = typeof body?.effort === "string" && /^[a-z]{1,16}$/.test(body.effort) ? body.effort : undefined;
  if (!image.startsWith("data:image/") || !engine || !/^[\w.-]{1,60}$/.test(model)) {
    return NextResponse.json({ error: "image·engine·model 이 필요합니다." }, { status: 400 });
  }
  const t0 = Date.now();
  try {
    const r = await cropOneProblem(image, undefined, { engine, model, effort });
    const estKrw = r.usage ? gradingEstKrw(lunaUsage(r.usage), model) : undefined;
    return NextResponse.json({
      ok: true,
      ms: Date.now() - t0,
      box: r.box,
      number: r.number ?? null,
      choices: r.choices,
      retried: r.retried,
      rotate: r.rotate ?? 0,
      advice: r.advice ?? null,
      adviceReason: r.adviceReason ?? null,
      usage: r.usage ?? null,
      estKrw: estKrw ?? null,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      ms: Date.now() - t0,
      error: err instanceof Error ? err.message.slice(0, 500) : String(err),
    });
  }
}
