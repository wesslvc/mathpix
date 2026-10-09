// **NVIDIA(build.nvidia.com, OpenAI 호환) 비전 모델 부르기**(2026-10-09, 사용자 — "제미나이가 좋긴 한데 RPD 가 꽤 빡세네, 우리 엔비디아 키에
// 있는 것 중에 비전 괜찮고 빠른 거 좀 찾아봐"). **서버 전용.** 이름은 짐작하지 않는다 — 일꾼 `probe: "nvidia-models"` 로 계정이 부를 수
// 있는 목록을 보고, `probe: "nvidia-vision"` 으로 실제 사진 + JSON 요청을 보내 본 뒤 정한다.
//
// 키 이름이 Vercel 에 셋 있다(`NVIDIA_API_KEY` · 오타로 만든 `NVIDIA_API_KEYY` · `NVIDEA_API_KEY`) — 있는 것을 쓴다.

import type { DetectUsage } from "./detectProblems";

const BASE = "https://integrate.api.nvidia.com/v1";

export function nvidiaKey(): string | null {
  return process.env.NVIDIA_API_KEY || process.env.NVIDIA_API_KEYY || process.env.NVIDEA_API_KEY || null;
}

/** 계정이 부를 수 있는 모델 id 목록(무료 조회). */
export async function listNvidiaModels(): Promise<string[]> {
  const key = nvidiaKey();
  if (!key) throw new Error("NVIDIA 키가 없습니다.");
  const res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { data?: { id?: string }[] };
  return (json.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean).sort();
}

/** 사진 한 장 + 지시 → 글. 429·5xx 는 1초·3초 뒤 두 번 더. */
export async function callNvidiaVision(
  dataUrl: string,
  prompt: string,
  model: string,
  onUsage?: (u: DetectUsage) => void,
  maxTokens = 4096,
): Promise<string> {
  const key = nvidiaKey();
  if (!key) throw new Error("NVIDIA 키가 없습니다.");
  const body = JSON.stringify({
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0,
    max_tokens: maxTokens,
    stream: false,
  });
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt === 1 ? 1000 : 3000));
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      body,
    });
    const text = await res.text();
    if (!res.ok) {
      last = `HTTP ${res.status}: ${text.slice(0, 300)}`;
      if (res.status === 429 || res.status >= 500) continue;
      throw new Error(`${model} ${last}`);
    }
    const json = JSON.parse(text) as {
      choices?: { message?: { content?: string | null; reasoning_content?: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    if (json.usage && onUsage) {
      onUsage({ input: json.usage.prompt_tokens ?? 0, cached: 0, output: json.usage.completion_tokens ?? 0 });
    }
    // 생각하는 모델은 <think>…</think> 를 앞에 붙여 준다 — 떼고 돌려준다.
    return String(json.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  }
  throw new Error(`${model} ${last}`);
}
