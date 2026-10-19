/**
 * 변형문제 batch 공통 도구 — 표 두 개(`variant_batch_items`: 최초 생성, `variant_ops`: 후속 수정·재검수)가 같이 쓴다.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { OPENAI_TEXT_MODEL } from "./gradeExam";
import { logAiCost } from "./costLog";
import { gradingEstKrw } from "./tokens";

export const OPENAI = "https://api.openai.com/v1";
/** 한 batch 에 담는 줄 수 — 그림 단계 결과(줄마다 그림 1장)를 한 번에 받아 처리할 수 있는 크기. */
export const CHUNK = 20;
export const BATCH_DISCOUNT = 0.5;
export const TERMINAL = new Set(["completed", "failed", "expired", "cancelled"]);

export const key = () => {
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new Error("OPENAI_API_KEY 가 없어요.");
  return k;
};
export const s = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

export async function uploadJsonl(text: string): Promise<string> {
  const form = new FormData();
  form.append("purpose", "batch");
  form.append("file", new Blob([text], { type: "application/jsonl" }), "variant.jsonl");
  const res = await fetch(`${OPENAI}/files`, { method: "POST", headers: { Authorization: `Bearer ${key()}` }, body: form });
  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (!res.ok || !body.id) throw new Error(`batch 파일을 올리지 못했어요 (HTTP ${res.status}) ${body.error?.message ?? ""}`);
  return body.id;
}

export async function createBatch(fileId: string, endpoint: string): Promise<string> {
  const res = await fetch(`${OPENAI}/batches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input_file_id: fileId, endpoint, completion_window: "24h" }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (!res.ok || !body.id) throw new Error(`batch 를 걸지 못했어요 (HTTP ${res.status}) ${body.error?.message ?? ""}`);
  return body.id;
}

export function solBody(prompt: string, images: string[], tail: string, effort: string) {
  return {
    model: OPENAI_TEXT_MODEL,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          ...images.map((url) => ({ type: "input_image", image_url: url, detail: "high" })),
          { type: "input_text", text: tail },
        ],
      },
    ],
    text: { format: { type: "json_object" } },
    reasoning: { effort },
  };
}

export type OutLine = { custom_id?: string; response?: { status_code?: number; body?: Record<string, unknown> } | null; error?: { message?: string } | null };

export async function readFile(fileId: unknown): Promise<OutLine[]> {
  if (typeof fileId !== "string") return [];
  const res = await fetch(`${OPENAI}/files/${encodeURIComponent(fileId)}/content`, { headers: { Authorization: `Bearer ${key()}` } });
  if (!res.ok) throw new Error(`batch 결과를 받지 못했어요 (HTTP ${res.status})`);
  const out: OutLine[] = [];
  for (const l of (await res.text()).split("\n")) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l) as OutLine);
    } catch {
      /* 깨진 줄은 건너뛴다 */
    }
  }
  return out;
}

export function lineError(line: OutLine | undefined): string | null {
  if (!line) return "batch 결과에 이 줄이 없어요.";
  if (line.error) return line.error.message ?? "실패";
  const code = line.response?.status_code ?? 0;
  if (code !== 200) {
    const m = (line.response?.body?.error as { message?: string } | undefined)?.message;
    return `HTTP ${code} ${m ?? ""}`.trim();
  }
  return null;
}

export function solUsage(body: Record<string, unknown>) {
  const u = body.usage as { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } | undefined;
  if (!u) return undefined;
  return { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cachedInputTokens: u.input_tokens_details?.cached_tokens ?? 0 };
}

/** sol batch 호출 하나의 원가(반값)를 장부에 적고 원 단위로 돌려준다. */
export async function logSolCost(admin: SupabaseClient, who: { userId: string; jobId: string }, what: string, body: Record<string, unknown>) {
  const usage = solUsage(body);
  const krw = usage ? (gradingEstKrw(usage, String(body.model ?? OPENAI_TEXT_MODEL)) ?? 0) * BATCH_DISCOUNT : 0;
  if (krw > 0) {
    await logAiCost(admin, { userId: who.userId, jobId: who.jobId, kind: "problem", what, krw, tokens: usage ? { input: usage.inputTokens, cached: usage.cachedInputTokens, output: usage.outputTokens } : undefined });
  }
  return krw;
}
