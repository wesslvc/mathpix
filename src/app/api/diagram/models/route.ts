import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
// 후보 모델들을 실제로 호출해보므로 기본 제한 시간으로는 부족하다.
export const maxDuration = 60;

const NVIDIA_BASE = "https://integrate.api.nvidia.com/v1";

/** 1x1 흰색 PNG. 이미지 입력을 받아주는지만 보려는 것이라 내용은 의미 없다. */
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** 후보를 무한정 찌르면 분당 요청 한도(RPM)에 걸리니 이 개수까지만 본다. */
const MAX_PROBES = 14;
/** 모델 하나가 느려도 전체가 타임아웃 나지 않도록 개별 호출을 끕는다. */
const PROBE_TIMEOUT_MS = 12_000;

/** 이름만 보고 이미지 입력이 될 법한 모델을 추린다(확정은 프로브 결과로 한다). */
const VISION_NAME_HINT =
  /vision|vlm?\b|-vl|multimodal|llava|pixtral|cosmos|nemotron.*(vl|vision)|kimi|gemma|qwen.*vl|phi/i;

type ProbeResult = {
  model: string;
  acceptsImage: boolean;
  status: number;
  note: string;
};

/**
 * 모델 하나에 "텍스트 + 1x1 이미지"를 보내 이미지 입력을 받아주는지 확인한다.
 * 200이면 비전 입력이 되는 것이고, 404면 계정 미제공, 400/422면 이 모델이
 * 이미지 형식을 안 받는 것이다.
 */
async function probeModel(apiKey: string, model: string): Promise<ProbeResult> {
  try {
    const res = await fetch(`${NVIDIA_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hi" },
              { type: "image_url", image_url: { url: TINY_PNG } },
            ],
          },
        ],
        max_tokens: 16,
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (res.ok) {
      return { model, acceptsImage: true, status: res.status, note: "이미지 입력 OK" };
    }
    const body = await res.text().catch(() => "");
    return {
      model,
      acceptsImage: false,
      status: res.status,
      note: body.slice(0, 200),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      model,
      acceptsImage: false,
      status: 0,
      // 12초 안에 응답이 없으면 도형 재구성엣 어차피 너무 느린 모델이다.
      note: /timeout|abort/i.test(message)
        ? `${PROBE_TIMEOUT_MS}ms 내 무응답(너무 느림)`
        : message,
    };
  }
}

/**
 * 이 계정의 NVIDIA_API_KEY로 실제 호출 가능한 모델을 나열하고, 그중 비전
 * 후보들에 진짜 이미지를 보내 "도형 재구성에 쓸 수 있는 모델"을 가려낸다.
 *
 * 카탈로그에 보이는 것과 계정이 쓸 수 있는 것이 다르고(kimi-k2.6이 404
 * "Not found for account"였다), 이름에 vision이 있어도 실제로는 이미지를 안
 * 받는 경우가 있어서 이름 추측 대신 실제 호출로 확인한다.
 * 키를 쓰는 엔드포인트라 로그인한 사용자만 볼 수 있게 한다.
 *
 * ?q=nemotron 처럼 필터를 주면 그 문자열이 들어간 모델만 프로브한다.
 */
export async function GET(req: Request) {
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

  const listRes = await fetch(`${NVIDIA_BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!listRes.ok) {
    const body = await listRes.text().catch(() => "");
    return NextResponse.json(
      { error: `모델 목록 조회 실패 ${listRes.status}`, detail: body.slice(0, 500) },
      { status: 502 },
    );
  }

  const json = await listRes.json();
  const all: string[] = (json?.data ?? [])
    .map((m: { id?: string }) => m?.id)
    .filter((id: unknown): id is string => typeof id === "string")
    .sort();

  const filter = new URL(req.url).searchParams.get("q")?.toLowerCase();
  const candidates = (
    filter
      ? all.filter((id) => id.toLowerCase().includes(filter))
      : all.filter((id) => VISION_NAME_HINT.test(id))
  )
    // NVIDIA 계열을 먼저 보고 싶다는 요구가 있어 nvidia/로 시작하는 걸 앞에 둔다.
    .sort((a, b) => Number(b.startsWith("nvidia/")) - Number(a.startsWith("nvidia/")))
    .slice(0, MAX_PROBES);

  const probes = await Promise.all(
    candidates.map((model) => probeModel(apiKey, model)),
  );

  const usable = probes.filter((p) => p.acceptsImage).map((p) => p.model);

  return NextResponse.json({
    // 도형 재구성에 바로 쓸 수 있는 모델(이미지 입력 확인됨).
    usableForDiagram: usable,
    nvidiaUsable: usable.filter((m) => m.startsWith("nvidia/")),
    probes,
    totalModels: all.length,
    all,
  });
}
