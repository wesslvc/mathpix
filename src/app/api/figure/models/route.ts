import { NextResponse } from "next/server";
import { figureModelIds } from "@/lib/figureVector";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * 이 키로 실제로 부를 수 있는 모델을 알아내는 진단 엔드포인트.
 *
 * **모델 이름을 기억이나 웹 검색으로 고르지 말 것.** 이 저장소에서 그러다
 * 404를 여러 번 맞았다(phi-3.5는 카탈로그에 아예 없었고, kimi-k2.6은 키를
 * 새로 발급해도 계정 해시가 같아 계속 404, gemini-2.5-flash-lite는 목록에는
 * 있는데 호출하면 "신규 사용자에게 제공 안 함"이었다). 제공 여부가 키가 아니라
 * **계정**에 묶여 있어서 목록만 봐서는 알 수 없다.
 *
 * 그래서 두 가지를 같이 돌려준다:
 *   - listed : GET /v1/models 가 알려주는 목록 (참고용, 이것만 믿으면 안 됨)
 *   - probes : 후보 모델마다 1×1 PNG를 **실제로 보내본** 결과 (이게 정답)
 *
 * NVIDIA를 쓰던 시절 이 프로브 방식이 한 방에 답을 줬다. 결과에서 ok=true인
 * 이름을 골라 OPENAI_FIGURE_MODELS 환경변수에 쉼표로 넣으면 재배포 없이 적용된다.
 */

/** 1×1 투명 PNG. 프로브에 쓰는 토큰을 최소로 만들기 위한 것. */
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type Probe = {
  id: string;
  /** 이 모델로 자료 재구성을 시도해도 되는가. */
  ok: boolean;
  status: number;
  note: string;
};

async function probe(modelId: string, apiKey: string): Promise<Probe> {
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "ok" },
              { type: "image_url", image_url: { url: TINY_PNG, detail: "low" } },
            ],
          },
        ],
        max_completion_tokens: 16,
      }),
    });

    if (res.ok) {
      return { id: modelId, ok: true, status: res.status, note: "호출 성공" };
    }

    const body = await res.text().catch(() => "");
    let message = body.slice(0, 200);
    try {
      message = JSON.parse(body)?.error?.message ?? message;
    } catch {
      // JSON이 아니면 원문 앞부분을 그대로 쓴다.
    }

    // 400은 "모델은 있는데 파라미터가 안 맞는다"는 뜻이다. 실제 호출 경로에는
    // 파라미터 조합을 바꿔가며 재시도하는 로직이 있으므로 쓸 수 있는 것으로 본다.
    if (res.status === 400) {
      return {
        id: modelId,
        ok: true,
        status: 400,
        note: `모델은 존재함(파라미터만 불일치): ${message}`,
      };
    }

    return { id: modelId, ok: false, status: res.status, note: message };
  } catch (err) {
    return {
      id: modelId,
      ok: false,
      status: 0,
      note: err instanceof Error ? err.message : "요청 실패",
    };
  }
}

export async function GET() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY가 설정되지 않았습니다." },
      { status: 500 },
    );
  }

  // 키로 무엇을 할 수 있는지 드러내는 진단이므로 로그인한 사용자만 볼 수 있게 한다.
  if (isSupabaseConfigured()) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    }
  }

  const candidates = figureModelIds();

  const [listed, probes] = await Promise.all([
    fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
      .then(async (res) =>
        res.ok
          ? ((await res.json())?.data ?? [])
              .map((m: { id?: string }) => m?.id)
              .filter((id: unknown): id is string => typeof id === "string")
              .sort()
          : [`(목록 조회 실패: ${res.status})`],
      )
      .catch((err) => [`(목록 조회 실패: ${err?.message ?? "알 수 없음"})`]),
    // 후보는 몇 개뿐이고 각각 토큰이 거의 안 드니 한꺼번에 찔러본다.
    Promise.all(candidates.map((id) => probe(id, apiKey))),
  ]);

  return NextResponse.json({
    usable: probes.filter((p) => p.ok).map((p) => p.id),
    probes,
    listed,
    hint: "usable에 나온 이름을 OPENAI_FIGURE_MODELS 환경변수에 쉼표로 넣으면 재배포 없이 적용됩니다. listed에 있어도 probe가 실패하면 못 쓰는 모델입니다.",
  });
}
