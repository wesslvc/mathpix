import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const GEMINI_LIST_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000";

type GeminiModel = {
  name?: string;
  displayName?: string;
  description?: string;
  supportedGenerationMethods?: string[];
};

/**
 * 이 GEMINI_API_KEY로 실제 사용 가능한 모델 목록을 보여주는 진단용 엔드포인트.
 *
 * 모델 이름을 문서나 기억에 의존해 고르면 계속 틀린다 — gemini-2.0-flash는
 * 계정에서 사라졌고, gemini-2.5-flash-lite는 "no longer available to new
 * users"로 404가 났다. 그래서 키가 실제로 볼 수 있는 목록을 직접 받아서 고른다.
 * 키를 쓰는 엔드포인트라 로그인한 사용자만 볼 수 있게 한다.
 */
export async function GET() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY가 설정되지 않았습니다." },
      { status: 500 },
    );
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

  const res = await fetch(GEMINI_LIST_ENDPOINT, {
    headers: { "x-goog-api-key": apiKey },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `모델 목록 조회 실패 ${res.status}`, detail: body.slice(0, 800) },
      { status: 502 },
    );
  }

  const json = await res.json();
  const models: GeminiModel[] = json?.models ?? [];

  // 호출할 때 쓰는 ID는 "models/" 접두어를 뗀 값이다.
  const toId = (m: GeminiModel) => (m.name ?? "").replace(/^models\//, "");

  // 도형 재구성은 generateContent만 쓰면 되므로 그걸 지원하는 것만 추린다.
  const usable = models
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map(toId)
    .filter(Boolean)
    .sort();

  // 이미지를 넣을 것이므로 임베딩·TTS 같은 건 빼고 본다.
  const notEmbedding = usable.filter(
    (id) => !/embed|aqa|tts|imagen|veo/i.test(id),
  );

  return NextResponse.json({
    // 이 중에서 골라 diagramVector.ts의 GEMINI_MODEL에 넣으면 된다.
    recommended: notEmbedding.filter((id) => /flash|pro/i.test(id)),
    generateContentModels: notEmbedding,
    totalModels: models.length,
    allIds: models.map(toId).sort(),
  });
}
