import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * 이 계정의 NVIDIA_API_KEY로 "실제 호출 가능한" 모델 목록을 보여주는 진단용
 * 엔드포인트.
 *
 * build.nvidia.com 카탈로그에 보이는 것과 계정이 실제로 쓸 수 있는 것이 다를
 * 수 있다 — moonshotai/kimi-k2.6은 카탈로그엄 있는데 호출하면 404
 * "Not found for account"가 났다. 그래서 도형 재구성 모델을 바꾸기 전에
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

  const res = await fetch("https://integrate.api.nvidia.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return NextResponse.json(
      {
        error: `모델 목록 조회 실패 ${res.status} ${res.statusText}`,
        detail: body.slice(0, 1000),
      },
      { status: 502 },
    );
  }

  const json = await res.json();
  const ids: string[] = (json?.data ?? [])
    .map((m: { id?: string }) => m?.id)
    .filter((id: unknown): id is string => typeof id === "string")
    .sort();

  // 이름만 보고 "이미지 입력이 될 법한" 후보를 위로 뽑아준다(확정은 아니고
  // 눈으로 고르기 쉽으라고 추리는 용도).
  const visionCandidates = ids.filter((id) =>
    /vision|vl\b|-vl|multimodal|kimi|llava|pixtral|phi|gemma|qwen.*vl/i.test(id),
  );

  return NextResponse.json({ total: ids.length, visionCandidates, all: ids });
}
