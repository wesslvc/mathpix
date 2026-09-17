"use client";

import { useState } from "react";
import type { UserIdentity } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { emailConfirmRedirect } from "@/lib/siteUrl";

/**
 * 로그인 방법을 보여주고 구글 계정을 연결/해제한다.
 *
 * **왜 필요한가**: 로그인 화면의 구글 버튼(`signInWithOAuth`)은 **같은
 * 이메일**로 가입한 사람만 자동으로 기존 계정에 연결된다(Supabase 의
 * Automatic Linking). 구글 계정 이메일이 가입할 때 쓴 이메일과 다르면
 * 그건 그냥 새 계정이 된다. 이미 로그인한 상태에서 명시적으로
 * `linkIdentity()`를 부르면(Manual Linking) 이메일이 달라도 **지금 이
 * 계정에** 구글을 붙일 수 있다 — "기존 이메일 계정을 구글로 옮기고
 * 싶다"는 요청은 이 경로가 아니면 안 된다.
 *
 * **Supabase 대시보드에서 "Allow manual linking"을 켜야 동작한다**
 * (Authentication → Providers). 안 켜져 있으면 `linkIdentity()`가
 * 에러를 돌려주므로 그 문구를 그대로 보여준다.
 */
export default function LinkedAccounts({
  initialIdentities,
}: {
  initialIdentities: UserIdentity[];
}) {
  const [identities, setIdentities] = useState(initialIdentities);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasGoogle = identities.some((i) => i.provider === "google");

  async function linkGoogle() {
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.linkIdentity({
      provider: "google",
      options: { redirectTo: emailConfirmRedirect() },
    });
    // 성공하면 브라우저가 곧바로 구글로 이동하므로 여기서 할 일이 없다.
    if (error) {
      setError(
        /manual linking/i.test(error.message)
          ? "구글 계정 연결 기능이 아직 꺼져 있어요. Supabase 대시보드 Authentication → Providers 에서 'Allow manual linking'을 켜주세요."
          : error.message,
      );
      setBusy(false);
    }
  }

  async function unlink(identity: UserIdentity) {
    // 마지막 남은 로그인 수단은 지울 수 없다 — 버튼 자체를 숨기지만
    // (identities.length > 1 조건) 한 번 더 막아 둔다.
    if (identities.length < 2) return;
    if (!confirm(`${labelFor(identity.provider)} 로그인을 연결 해제할까요?`)) return;
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.unlinkIdentity(identity);
    if (error) {
      setError(error.message);
    } else {
      setIdentities((prev) =>
        prev.filter((i) => i.identity_id !== identity.identity_id),
      );
    }
    setBusy(false);
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="text-base font-semibold text-ink">로그인 방법</h2>

      <ul className="flex flex-col gap-2">
        {identities.map((identity) => (
          <li
            key={identity.identity_id}
            className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-sm"
          >
            <span>{labelFor(identity.provider)}</span>
            {identities.length > 1 && (
              <button
                type="button"
                onClick={() => void unlink(identity)}
                disabled={busy}
                className="text-xs text-red-600 underline underline-offset-2 hover:text-red-700 disabled:opacity-50"
              >
                연결 해제
              </button>
            )}
          </li>
        ))}
      </ul>

      {!hasGoogle && (
        <button
          type="button"
          onClick={() => void linkGoogle()}
          disabled={busy}
          className="self-start rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {busy ? "이동 중..." : "Google 계정 연결하기"}
        </button>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
    </section>
  );
}

function labelFor(provider: string): string {
  if (provider === "google") return "Google";
  if (provider === "email") return "이메일/비밀번호";
  return provider;
}
