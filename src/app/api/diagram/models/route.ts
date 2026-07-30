import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const LIST_URL =
  "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000";

type GeminiModel = { name?: string; supportedGenerationMethods?: string[] };

/**
 * 이 GEMINI_API_KEY로 실제 쓸 수 있는 모델 목록. 모델 이름을 기억으로 고르면
 * 계속 틀린다(2.0-flash는 계정에서 사라졌고, 2.5-flash-lite는 신규 사용자
 * 미제공으로 404). 키가 실제로 보는 목록을 받아서 고르려고 만든 진단용이다.
 */
export async function GET() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "GEMINI_API_KEY 없음" }, { status: 500 });
  }

  if (isSupabaseConfigured()) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    }
  }

  const res = await fetch(LIST_URL, { headers: { "x-goog-api-key": apiKey } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `목록 조회 실패 ${res.status}`, detail: body.slice(0, 800) },
      { status: 502 },
    );
  }

  const json = await res.json();
  const models: GeminiModel[] = json?.models ?? [];
  const toId = (m: GeminiModel) => (m.name ?? "").replace("models/", "");

  // 도형 재구성은 generateContent만 쓰고, 임베딩/TTS/이미지생성은 제외한다.
  const usable = models
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map(toId)
    .filter((id) => id && !/embed|aqa|tts|imagen|veo/i.test(id))
    .sort();

  return NextResponse.json({
    recommended: usable.filter((id) => /flash|pro/i.test(id)),
    generateContentModels: usable,
    allIds: models.map(toId).sort(),
  });
}
