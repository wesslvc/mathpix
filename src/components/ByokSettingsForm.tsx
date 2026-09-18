"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { BYOK_IMAGE_MODEL_CHOICES } from "@/lib/figureImageGen";

/**
 * BYOK(Bring Your Own [OpenAI] Key) 패스 설정 — 본인 OpenAI 키 등록·교체·
 * 삭제, 이미지 생성 모델 선택.
 *
 * **BYOK 패스를 산 사람에게만 보인다**(`/profile`이 `access.byok`로 가른다).
 * 패스가 없는 사람에게 키 입력칸을 보여줘 봐야 아무 효과가 없다 — 서버
 * 라우트가 어차피 `entitlements.byok`를 다시 확인한다(화면 숨김은 우회할
 * 수 있으므로 진짜 게이트는 서버다).
 *
 * **키는 이 화면을 거쳐 한 번도 평문으로 우리 서버에 안 남는다** — 브라우저가
 * `set_byok_openai_key` RPC를 직접 불러 Postgres(Vault)에 곧바로 암호화해
 * 넣는다. 등록 뒤에는 값을 다시 안 보여준다(`has_key`만 안다) — 그래서
 * "키 교체"는 항상 새 값을 다시 입력해야 한다.
 */
export default function ByokSettingsForm() {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [model, setModel] = useState<string>("");
  const [keyInput, setKeyInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("get_byok_status").maybeSingle();
      if (cancelled) return;
      if (error) {
        setError(error.message);
      } else {
        const row = data as { byok: boolean; has_key: boolean; model: string | null } | null;
        setHasKey(row?.has_key === true);
        setModel(row?.model ?? "");
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveKey() {
    if (!keyInput.trim()) {
      setError("키를 입력해주세요.");
      return;
    }
    setSaving(true);
    setSaved(null);
    setError(null);
    try {
      const supabase = createClient();
      const { error } = await supabase.rpc("set_byok_openai_key", {
        p_key: keyInput.trim(),
        p_model: model || null,
      });
      if (error) throw error;
      setHasKey(true);
      setKeyInput("");
      setSaved("키를 등록했어요.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "키 등록에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  }

  async function saveModel(next: string) {
    setModel(next);
    setSaved(null);
    setError(null);
    try {
      const supabase = createClient();
      const { error } = await supabase.rpc("set_byok_model", { p_model: next || null });
      if (error) throw error;
      setSaved("모델을 바꿨어요.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "모델 변경에 실패했습니다.");
    }
  }

  async function clearKey() {
    if (!confirm("등록한 OpenAI 키를 지울까요? 지우면 다시 넣기 전까지 BYOK 기능을 못 씁니다.")) {
      return;
    }
    setSaving(true);
    setSaved(null);
    setError(null);
    try {
      const supabase = createClient();
      const { error } = await supabase.rpc("clear_byok_openai_key");
      if (error) throw error;
      setHasKey(false);
      setSaved("키를 지웠어요.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "키 삭제에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4">
      <div>
        <p className="text-sm font-medium text-slate-700">BYOK 패스 — 본인 OpenAI 키</p>
        <p className="mt-1 text-xs text-slate-400">
          여기 등록한 키로 그림 생성·자동채점·답지 인식·국어 지문 인식을
          부릅니다 — 비용은 이 키의 OpenAI 계정으로 바로 나가고, 우리
          토큰은 전혀 들지 않아요. Mathpix 문제 인식은 이 키와 무관하게
          무제한 무료입니다.
        </p>
      </div>

      <details className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-500">
        <summary className="cursor-pointer select-none font-medium text-slate-600">
          OpenAI API 키는 어디서 받나요?
        </summary>
        <ol className="mt-2 list-decimal space-y-1 pl-4">
          <li>
            <a
              href="https://platform.openai.com/api-keys"
              target="_blank"
              rel="noreferrer"
              className="text-blue-600 underline"
            >
              platform.openai.com/api-keys
            </a>
            에 로그인합니다(OpenAI 계정이 없으면 먼저 만듭니다).
          </li>
          <li>결제 수단을 등록합니다(Billing → Payment methods) — 키를 쓰려면 필요합니다.</li>
          <li>"Create new secret key"를 눌러 키를 만들고, <code>sk-</code>로 시작하는 값을 복사합니다(한 번만 보여주므로 그 자리에서 복사).</li>
          <li>아래 칸에 붙여넣고 저장합니다. 이 키는 이 앱이 여러분 대신 OpenAI를 부르는 데만 쓰입니다.</li>
        </ol>
      </details>

      {loading ? (
        <p className="text-sm text-slate-400">불러오는 중…</p>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-500">
              {hasKey ? "키 교체(등록된 키는 다시 보여줄 수 없어요)" : "OpenAI API 키"}
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="password"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder="sk-..."
                className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
                autoComplete="off"
              />
              <button
                type="button"
                onClick={saveKey}
                disabled={saving}
                className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {hasKey ? "교체" : "등록"}
              </button>
            </div>
            {hasKey && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-emerald-600">✓ 키가 등록돼 있어요.</span>
                <button
                  type="button"
                  onClick={clearKey}
                  disabled={saving}
                  className="text-xs text-red-600 underline disabled:opacity-50"
                >
                  키 지우기
                </button>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-500">
              이미지 생성 모델(그림·자료 재구성 전용)
            </label>
            <select
              value={model}
              onChange={(e) => saveModel(e.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">앱 기본값 사용</option>
              {BYOK_IMAGE_MODEL_CHOICES.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            <p className="text-xs text-slate-400">
              이 키로 실제 접근 가능한 모델만 골라야 해요 — 계정마다 접근
              권한이 다를 수 있습니다.
            </p>
          </div>
        </>
      )}

      {saved && <p className="text-xs text-emerald-600">{saved}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
