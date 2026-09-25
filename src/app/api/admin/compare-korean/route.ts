import { NextRequest, NextResponse } from "next/server";
import { requireFontAdmin } from "../kice-font/auth";
import { GradeError, readKoreanRichTextWith } from "@/lib/gradeExam";
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
 * 무제한 계정만 쓴다(`requireFontAdmin`). 시험용이라 토큰을 차감하지 않는다.
 * 모델 이름은 모양만 확인한다 — 이름을 지어내지 않고, 화면에 적힌 것(=확인해
 * 둔 것)을 그대로 쓴다.
 */
export async function POST(req: NextRequest) {
  const gate = await requireFontAdmin();
  if (!gate.ok) return gate.response;

  let body: { image?: unknown; reference?: unknown; provider?: unknown; model?: unknown; effort?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }
  const image = typeof body.image === "string" ? body.image : "";
  if (!image.startsWith("data:image/")) {
    return NextResponse.json({ error: "지문 사진이 필요합니다." }, { status: 400 });
  }
  const reference = typeof body.reference === "string" ? body.reference.slice(0, 12000) : "";
  const provider = body.provider === "gemini" ? "gemini" : body.provider === "openai" ? "openai" : null;
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const effort = typeof body.effort === "string" ? body.effort.trim() : "";
  if (!provider || !/^[\w.-]{3,80}$/.test(model)) {
    return NextResponse.json({ error: "provider 와 model 이 필요합니다." }, { status: 400 });
  }
  if (effort && !/^[a-z]{1,16}$/.test(effort)) {
    return NextResponse.json({ error: "effort 값이 이상합니다." }, { status: 400 });
  }

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), (maxDuration - 15) * 1000);
  const t0 = Date.now();
  try {
    const out = await readKoreanRichTextWith(
      image,
      reference,
      { provider, model, effort: provider === "openai" && effort ? effort : undefined },
      deadline.signal,
    );
    const ms = Date.now() - t0;
    console.info(
      `[compare-korean] model=${out.model} effort=${effort || "-"} ${ms}ms ` +
        `참고글=${reference.length}자 in=${out.usage?.inputTokens ?? "?"} out=${out.usage?.outputTokens ?? "?"}`,
    );
    return NextResponse.json({
      blocks: out.blocks,
      usage: out.usage,
      model: out.model,
      effort: effort || null,
      // 공표 단가를 아는 모델만(`GRADING_PRICES`). 모르면 비워 둔다 — 지어내지 않는다.
      estKrw: out.usage ? (gradingEstKrw(out.usage, out.model) ?? null) : null,
      ms,
    });
  } catch (err) {
    const ms = Date.now() - t0;
    if (deadline.signal.aborted) {
      return NextResponse.json(
        { error: `${model} 이(가) ${Math.round(ms / 1000)}초 안에 끝나지 않았습니다.`, ms },
        { status: 504 },
      );
    }
    const status = err instanceof GradeError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "지문 인식에 실패했습니다.", ms },
      { status: status >= 400 && status < 600 ? status : 500 },
    );
  } finally {
    clearTimeout(timer);
  }
}
