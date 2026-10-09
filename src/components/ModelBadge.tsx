import type { ReactNode } from "react";

/**
 * 어느 AI 모델이 일하는지 로고로 보인다(2026-10-09, 사용자 — "다 Luna 로 합치지 말고 ai 모델들 로고를 이용해서 구체적으로
 * 어떤 모델 쓰는지 잘 보이게"). Claude(Anthropic) 로고는 하이쿠, OpenAI 로고는 luna·sol·sunburst.
 */
export type ModelKey = "haiku" | "luna" | "sol" | "sunburst";

const MODELS: Record<ModelKey, { logo: string; name: string; maker: string }> = {
  haiku: { logo: "/brand/ai/claude.png", name: "claude-haiku-5.5", maker: "Anthropic" },
  luna: { logo: "/brand/ai/openai.png", name: "gpt-6-luna", maker: "OpenAI" },
  sol: { logo: "/brand/ai/openai.png", name: "gpt-6.1-sol", maker: "OpenAI" },
  sunburst: { logo: "/brand/ai/openai.png", name: "gpt-image-2.5-sunburst", maker: "OpenAI" },
};

export function ModelBadge({ model, label = true, className = "" }: { model: ModelKey; label?: boolean; className?: string }) {
  const m = MODELS[model];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 align-middle ${className}`} title={`${m.name} · ${m.maker}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={m.logo} alt={m.maker} width={14} height={14} className="h-3.5 w-3.5 object-contain" />
      {label && <span className="font-semibold">{m.name}</span>}
    </span>
  );
}

/** "luna 가 채점하는 중" 처럼 모델 이름으로 시작하는 문구 앞에 로고를 붙인다(정식 이름으로 바꿔 로고와 함께). */
export function withModelLogo(text: string): ReactNode {
  const hit = /^(haiku|luna|sol|sunburst)(?=[\s가이]|$)/i.exec(text);
  if (!hit) return text;
  return (
    <>
      <ModelBadge model={hit[1].toLowerCase() as ModelKey} className="mr-0.5" />
      {text.slice(hit[1].length)}
    </>
  );
}
