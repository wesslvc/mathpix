// **OpenRouter 비전 모델 부르기**(2026-10-09, 사용자 — "엔비디아는 갖다 버리고 오픈라우터들의 무료 모델들 우선 진행"). **서버 전용.**
// OpenAI 호환 `/chat/completions`. 키는 Vercel 환경변수 `OPENROUTER_KEY`. 모델 이름은 짐작하지 않는다 — 일꾼
// `probe: "openrouter-models"` 로 이미지를 받는 모델(과 단가)만 뽑아 본 뒤 정한다. `:free` 모델은 카드 없이도 쓸 수 있다
// (분당 20회, 크레딧 $10 미만이면 하루 50회 — 제3자 안내 기준).

import type { DetectUsage } from "./detectProblems";

const BASE = "https://openrouter.ai/api/v1";

export function openrouterKey(): string | null {
  return process.env.OPENROUTER_KEY || process.env.OPENROUTER_API_KEY || null;
}

export type OpenRouterModel = { id: string; free: boolean; promptUsd: number; completionUsd: number };

/** 이미지 입력을 받는 모델 목록(무료 조회, 키 없어도 된다). 100만 토큰당 달러. */
export async function listOpenRouterVisionModels(): Promise<OpenRouterModel[]> {
  const res = await fetch(`${BASE}/models`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as {
    data?: { id?: string; architecture?: { input_modalities?: string[] }; pricing?: { prompt?: string; completion?: string } }[];
  };
  const out: OpenRouterModel[] = [];
  for (const m of json.data ?? []) {
    if (!m.id || !m.architecture?.input_modalities?.includes("image")) continue;
    const p = Number(m.pricing?.prompt ?? 0) * 1e6;
    const c = Number(m.pricing?.completion ?? 0) * 1e6;
    out.push({ id: m.id, free: m.id.endsWith(":free") || (p === 0 && c === 0), promptUsd: p, completionUsd: c });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** 사진 한 장 + 지시 → 글. 429·5xx 는 3·8·15초 뒤 세 번 더(제공사가 잠깐 막는 일이 흔하다 — 같은 모델에 지면 여러 장이 동시에 가면 더). */
export async function callOpenRouterVision(
  dataUrl: string,
  prompt: string,
  model: string,
  onUsage?: (u: DetectUsage) => void,
  maxTokens = 4096,
  signal?: AbortSignal,
): Promise<string> {
  const key = openrouterKey();
  if (!key) throw new Error("OPENROUTER_KEY 가 없습니다.");
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
    usage: { include: true }, // 응답에 실제 청구액(usage.cost, USD)을 실어 준다
  });
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, [0, 3000, 8000, 15000][attempt]));
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://reprintocr.vercel.app",
        "X-Title": "ReprintOCR",
      },
      body,
      signal,
    });
    const text = await res.text();
    if (!res.ok) {
      last = `HTTP ${res.status}: ${text.slice(0, 300)}`;
      if (res.status === 429 || res.status >= 500) continue;
      throw new Error(`${model} ${last}`);
    }
    const json = JSON.parse(text) as {
      choices?: { message?: { content?: string | null } }[];
      error?: { message?: string };
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    if (json.error && !json.choices?.length) {
      last = String(json.error.message ?? "오류").slice(0, 300);
      continue;
    }
    if (json.usage && onUsage) {
      onUsage({
        input: json.usage.prompt_tokens ?? 0,
        cached: 0,
        output: json.usage.completion_tokens ?? 0,
        ...(typeof json.usage.cost === "number" ? { costUsd: json.usage.cost } : {}),
      });
    }
    return String(json.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  }
  throw new Error(`${model} ${last}`);
}
