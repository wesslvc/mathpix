import { NextResponse, type NextRequest } from "next/server";
import {
  DetectError,
  detectKoreanPassages,
  detectKoreanQuestions,
  detectProblems,
} from "@/lib/detectProblems";
import type { ProblemBox } from "@/lib/problemBoxes";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 영역 찾기를 luna xhigh 로 돌린다(`OPENAI_DETECT_EFFORT`) — 오래 생각하면
// 지면 한 장에 1분을 넘길 수 있어 한도를 넉넉히 둔다.
export const maxDuration = 300;

/**
 * 지면 한 장에서 문제마다의 영역을 찾아 돌려준다.
 *
 * **무제한 계정 전용이다.** 실험적인 기능이고 한 번에 열 몇 문제를 통째로 다시
 * 그리는 일로 이어지므로, 일반 사용자에게 열어 두면 요금이 순식간에 커진다.
 * 화면에서도 감추지만 막는 자리는 여기다 — 화면은 얼마든지 우회할 수 있다.
 */
export async function POST(req: NextRequest) {
  let body: { image?: string; mode?: string; passages?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }
  if (!body.image || typeof body.image !== "string") {
    return NextResponse.json(
      { error: "image(base64 data URL) 필드가 필요합니다." },
      { status: 400 },
    );
  }

  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase가 설정되지 않았습니다." }, { status: 503 });
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  const { data: ent } = await supabase
    .from("entitlements")
    .select("unlimited")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!ent?.unlimited) {
    return NextResponse.json(
      { error: "이 기능은 무제한 계정에서만 쓸 수 있습니다." },
      { status: 403 },
    );
  }

  try {
    // 국어는 **지문 먼저, 문제는 따로**(2026-09-25, 사용자 지시). 지문 호출은
    // 지문 안의 그림 자리도 함께 돌려주고, 문제 호출은 앞서 찾은 지문 자리를
    // 받아 비켜 간다(`detectProblems.ts` 주석 참고).
    if (body.mode === "korean-passage") {
      const { passages, figures, model } = await detectKoreanPassages(body.image);
      return NextResponse.json({ regions: passages, figures, model });
    }
    if (body.mode === "korean-question") {
      const { regions, model } = await detectKoreanQuestions(body.image, readBoxes(body.passages));
      return NextResponse.json({ regions, model });
    }
    const { problems, model } = await detectProblems(body.image);
    return NextResponse.json({ problems, model });
  } catch (err) {
    const status = err instanceof DetectError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "문제 영역 인식에 실패했습니다." },
      { status: status >= 400 && status < 600 ? status : 500 },
    );
  }
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
