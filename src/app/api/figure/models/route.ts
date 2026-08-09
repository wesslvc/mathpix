import { NextResponse } from "next/server";
import { figureImageModelIds } from "@/lib/figureImageGen";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * 이 키로 실제로 부를 수 있는 이미지 생성 모델을 알아내는 진단 엔드포인트.
 *
 * **모델 이름을 기억이나 웹 검색으로 고르지 말 것.** 이 저장소에서 그러다
 * 404를 여러 번 맞았다(phi-3.5는 카탈로그에 아예 없었고, kimi-k2.6은 키를
 * 새로 발급해도 계정 해시가 같아 계속 404, gemini-2.5-flash-lite는 목록에는
 * 있는데 호출하면 "신규 사용자에게 제공 안 함"이었다). 제공 여부가 키가 아니라
 * **계정**에 묶여 있어서 목록만 봐서는 알 수 없다.
 *
 * 두 가지를 같이 돌려준다:
 *   - listed : GET /v1/models 목록 (참고용, 이것만 믿으면 안 됨)
 *   - probes : 후보 모델마다 아주 작은 이미지로 **실제 편집 요청을 보내본** 결과
 *
 * 이미지 생성은 파라미터(size/quality/input_fidelity)도 모델마다 달라서, 프로브가
 * 400을 받으면 그 메시지를 그대로 실어준다 — 어떤 값이 거부됐는지 바로 보인다.
 */

/** 8×8 흰색 PNG. 프로브 비용을 최소로 만들기 위한 것. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVR42mP8/58BDzCOKhhVMDwUAADbfxoDlvpRBAAAAABJRU5ErkJggg==";

type Probe = {
  id: string;
  ok: boolean;
  status: number;
  note: string;
};

async function probeImageModel(modelId: string, apiKey: string): Promise<Probe> {
  try {
    const bytes = Buffer.from(TINY_PNG_BASE64, "base64");
    const form = new FormData();
    form.append("model", modelId);
    form.append(
      "image",
      new Blob([new Uint8Array(bytes)], { type: "image/png" }),
      "probe.png",
    );
    form.append("prompt", "make the background white");
    form.append("n", "1");

    const res = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (res.ok) {
      return { id: modelId, ok: true, status: res.status, note: "호출 성공" };
    }

    const body = await res.text().catch(() => "");
    let message = body.slice(0, 300);
    try {
      message = JSON.parse(body)?.error?.message ?? message;
    } catch {
      // JSON이 아니면 원문 앞부분을 그대로 쓴다.
    }

    // 400은 "모델은 있는데 이 요청 형태가 안 맞는다"는 뜻이다. 실제 호출
    // 경로에는 파라미터 조합을 바꿔가며 재시도하는 로직이 있으므로 쓸 수
    // 있는 것으로 보되, 어떤 값이 거부됐는지는 그대로 보여준다.
    if (res.status === 400) {
      return {
        id: modelId,
        ok: true,
        status: 400,
        note: `모델은 존재함(요청 형태 불일치): ${message}`,
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

  const candidates = figureImageModelIds();

  const [listed, probes] = await Promise.all([
    fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
      .then(async (res) =>
        res.ok
          ? ((await res.json())?.data ?? [])
              .map((m: { id?: string }) => m?.id)
              .filter((id: unknown): id is string => typeof id === "string")
              .filter((id: string) => id.includes("image"))
              .sort()
          : [`(목록 조회 실패: ${res.status})`],
      )
      .catch((err) => [`(목록 조회 실패: ${err?.message ?? "알 수 없음"})`]),
    // 후보가 몇 개뿐이라 한꺼번에 찔러본다. 8×8 이미지라 비용이 거의 없다.
    Promise.all(candidates.map((id) => probeImageModel(id, apiKey))),
  ]);

  return NextResponse.json({
    usable: probes.filter((p) => p.ok).map((p) => p.id),
    probes,
    listedImageModels: listed,
    hint: "usable에 나온 이름을 OPENAI_FIGURE_IMAGE_MODELS 환경변수에 쉼표로 넣으면 재배포 없이 적용됩니다. listed에 있어도 probe가 실패하면 못 쓰는 모델입니다. status가 400이면 모델은 있으니 note에 적힌 거부 사유를 보세요.",
  });
}
