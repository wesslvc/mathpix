"use client";

import { runAiTask } from "@/lib/aiTask";
import { useEffect, useRef, useState } from "react";

export type SolChatPlan = { text: string; understood: string; count: number };

type Msg = { role: "user" | "assistant"; text: string };

/**
 * **sol 과 대화로 수정 사항을 정한다**(사용자 — "수정모드 때는 sol 과 LLM 형태로 대화해서 수정사항을 최종 확정시키자").
 * 사용자가 고칠 곳을 말하면 sol 이 원본과 지금 그림을 보며 되묻거나 "이렇게 고칠게요"를 정리해 준다(`plan`). 사용자가 그 정리를 보고
 * **[이 내용으로 확정]** 을 눌러야 부모가 실제 수정·다시 그리기를 시작한다 — 이 컴포넌트는 그림 모델을 부르지 않는다.
 *
 * - 그림은 `jobId`(서버 작업) 또는 `getImages()`(수정 창처럼 화면이 가진 원본·지금 그림 두 장)로 준다.
 * - 추론 강도는 설정하지 않는다(서버가 값을 아예 안 보낸다).
 * - 매 마디마다 쓴 만큼 토큰이 든다(무제한·BYOK 는 안 든다) — 일반 계정에는 지금까지 쓴 토큰을 보여 준다.
 */
export function SolChat({
  goal,
  jobId,
  getImages,
  confirmLabel,
  busy,
  onConfirm,
  placeholder,
}: {
  goal: "patch" | "redraw";
  jobId?: string;
  getImages?: () => Promise<string[]>;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: (plan: SolChatPlan) => void;
  placeholder?: string;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [plan, setPlan] = useState<SolChatPlan | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [spent, setSpent] = useState(0);
  const imagesRef = useRef<string[] | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [msgs, sending]);

  async function send() {
    const t = text.trim();
    if (!t || sending) return;
    setError(null);
    const next: Msg[] = [...msgs, { role: "user", text: t }];
    setMsgs(next);
    setText("");
    setSending(true);
    try {
      let images: string[] | undefined;
      if (!jobId) {
        // 화면이 가진 그림은 처음 한 번만 준비해 두고 재사용한다(줄이고 대비를 올리는 일이라 매번 하면 느리다).
        if (!imagesRef.current && getImages) imagesRef.current = await getImages();
        images = imagesRef.current ?? undefined;
      }
      // **서버 대기열에서 답한다**(`runAiTask` — 대기열 패널에 "sol 이 답하는 중"으로 뜬다).
      let json: { reply?: string; plan?: SolChatPlan | null; chargedTokens?: number | null };
      try {
        const { result, chargedTokens } = await runAiTask<{ reply?: string; plan?: SolChatPlan | null }>("chat", {
          label: "sol 수정 대화",
          images: jobId ? [] : images,
          params: { goal, jobId, messages: next },
        });
        json = { ...result, chargedTokens };
      } catch (err) {
        json = {};
        setError(err instanceof Error ? err.message : "sol 이 답하지 못했어요.");
      }
      if (!json.reply) {
        setError((e) => e ?? "sol 이 답하지 못했어요.");
        // 보낸 말은 입력칸으로 돌려놓는다 — 다시 보낼 수 있게.
        setMsgs(msgs);
        setText(t);
        return;
      }
      setMsgs([...next, { role: "assistant", text: json.reply }]);
      // 되묻는 답(plan 없음)이면 이전에 합의한 정리를 그대로 둔다 — 사용자가 마음을 바꾸지 않은 한 지우지 않는다.
      if (json.plan) setPlan(json.plan);
      if (typeof json.chargedTokens === "number") setSpent((n) => n + (json.chargedTokens ?? 0));
    } catch (err) {
      setError(err instanceof Error ? err.message : "네트워크 오류로 보내지 못했어요.");
      setMsgs(msgs);
      setText(t);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-white">
      <div className="max-h-56 space-y-1.5 overflow-y-auto px-2 py-2 text-[12px]">
        {msgs.length === 0 && (
          <p className="text-slate-500">
            sol 과 대화하며 고칠 곳을 정해요. 원본과 지금 그림을 sol 이 같이 보니 <b>&quot;B 점이 원본보다 왼쪽이야&quot;</b> 처럼 편하게 말해 주세요. 모호하면
            sol 이 되물어요. 다 정해지면 <b>확정</b>을 눌러요.
          </p>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-2 py-1 leading-snug ${
                m.role === "user" ? "bg-amber-100 text-slate-800" : "bg-slate-100 text-slate-800"
              }`}
            >
              {m.role === "assistant" && <span className="mb-0.5 block text-[10px] font-medium text-slate-400">sol</span>}
              {m.text}
            </div>
          </div>
        ))}
        {sending && <p className="text-[11px] text-slate-400">sol 이 원본과 지금 그림을 보고 있어요…</p>}
        <div ref={endRef} />
      </div>
      {plan && (
        <div className="border-t border-amber-200 bg-amber-50/70 px-2 py-1.5 text-[11px] text-slate-700">
          <p className="font-medium">지금까지 정리된 수정 사항 ({plan.count}곳)</p>
          <p className="mt-0.5 leading-snug">{plan.understood || "sol 이 수정 사항을 정리했어요."}</p>
          <details className="mt-0.5">
            <summary className="cursor-pointer text-slate-500">그림 모델에 가는 지시 보기</summary>
            <pre className="mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-white px-1.5 py-1 text-[10px] leading-snug text-slate-600">
              {plan.text}
            </pre>
          </details>
        </div>
      )}
      {error && <p className="border-t border-red-100 bg-red-50 px-2 py-1 text-[11px] text-red-700">{error}</p>}
      <div className="flex items-end gap-1.5 border-t border-slate-200 px-2 py-1.5">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 1000))}
          onKeyDown={(e) => {
            // 한글 조합 중 Enter 는 글자 확정이다 — 보내면 안 된다.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          disabled={sending || busy}
          placeholder={placeholder ?? "고칠 곳을 말해 주세요 (Enter 로 보내기, Shift+Enter 줄바꿈)"}
          className="min-w-0 flex-1 resize-none rounded border border-slate-300 px-2 py-1 text-xs text-slate-800 placeholder:text-slate-400 focus:border-amber-500 focus:outline-none disabled:opacity-50"
        />
        <div className="flex shrink-0 flex-col gap-1">
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending || busy || !text.trim()}
            className="rounded border border-slate-300 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            보내기
          </button>
          <button
            type="button"
            onClick={() => plan && onConfirm(plan)}
            disabled={!plan || sending || busy}
            className="rounded bg-amber-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-40"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
      {spent > 0 && <p className="px-2 pb-1 text-[10px] text-slate-400">대화에 지금까지 {spent.toLocaleString()}토큰을 썼어요.</p>}
    </div>
  );
}
