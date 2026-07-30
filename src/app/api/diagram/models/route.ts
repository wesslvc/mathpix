import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
// 아래 프로브가 실제 모델을 호출하므로 기본 제한 시간으론 부족할 수 있다.
export const maxDuration = 60;

const NVIDIA_BASE = "https://integrate.api.nvidia.com/v1";

/** 도형 재구성에 쓰는 모델. diagramVector.ts와 같은 값을 봐야 의미가 있다. */
const TARGET_MODEL = "moonshotai/kimi-k2.6";

/** 1x1 흰색 PNG. 이미지 입력이 되는지만 보려는 것이라 내용은 의미 없다. */
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type Probe = {
  ok: boolean;
  status: number;
  body: string;
};

/**
 * 같은 모델을 "텍스트만" / "이미지 포함" 두 가지로 실제 호출해본다.
 * NVIDIA는 (모델 + 입력 형태)에 따라 서로 다른 NIM function으로 라우팅하는
 * 것으로 보이는데, 404 메시지가 "Function '<uuid>': Not found for account"라
 * 텍스트는 되고 비전만 계정에 없을 수도 있다. 둘을 갈라 봐야 구분이 된다.
 */
async function probe(apiKey: string, withImage: boolean): Promise<Probe> {
  const content = withImage
    ? [
        { type: "text", text: "hi" },
        { type: "image_url", image_url: { url: TINY_PNG } },
      ]
    : "hi";

  try {
    const res = await fetch(`${NVIDIA_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: TARGET_MODEL,
        messages: [{ role: "user", content }],
        max_tokens: 16,
      }),
    });
    const body = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, body: body.slice(0, 600) };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 이 계정의 NVIDIA_API_KEY로 "실제 호출 가능한" 모델 목록과, 대상 모델의
 * 텍스트/비전 호출 가능 여부를 함께 보여주는 진단용 엔드포인트.
 *
 * build.nvidia.com 카탈로그에 보이는 것과 계정이 실제로 쓸 수 있는 것이 다를
 * 수 있어서(kimi-k2.6이 404 "Not found for account"였다) 모델을 고르기 전에
 * 여기서 먼저 확인한다. 키를 쓰는 엔드포인트라 로그인한 사용자만 볼 수 있게 한다.
 */
export async function GET() {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "NVIDIA_API_KEY가 설정되지 않았습니다." },
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

  // 키가 바뀌었는지 눈으로 확인할 수 있게 앞 8자만 보여준다(전체 노출 금지).
  const keyFingerprint = `${apiKey.slice(0, 8)}...(${apiKey.length}자)`;

  const listRes = await fetch(`${NVIDIA_BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  let models: { total: number; targetInList: boolean; visionCandidates: string[]; all: string[] } | { error: string } ;
  if (!listRes.ok) {
    const body = await listRes.text().catch(() => "");
    models = { error: `목록 조회 실패 ${listRes.status}: ${body.slice(0, 500)}` };
  } else {
    const json = await listRes.json();
    const ids: string[] = (json?.data ?? [])
      .map((m: { id?: string }) => m?.id)
      .filter((id: unknown): id is string => typeof id === "string")
      .sort();
    models = {
      total: ids.length,
      targetInList: ids.includes(TARGET_MODEL),
      // 이름만 보고 "이미지 입력이 될 법한" 후보를 추려준다(확정은 아님).
      visionCandidates: ids.filter((id) =>
        /vision|vl\b|-vl|multimodal|kimi|llava|pixtral|phi|gemma|qwen.*vl/i.test(id),
      ),
      all: ids,
    };
  }

  const [textOnly, withImage] = await Promise.all([
    probe(apiKey, false),
    probe(apiKey, true),
  ]);

  return NextResponse.json({
    targetModel: TARGET_MODEL,
    keyFingerprint,
    probes: { textOnly, withImage },
    models,
  });
}
