"use client";

import { useState } from "react";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isSupabaseConfigured()) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
        <h1 className="text-xl font-bold text-ink">수학오답프린트 제작</h1>
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Supabase 설정이 아직 완료되지 않아 로그인 기능을 사용할 수 없습니다.
          <br />
          <code>NEXT_PUBLIC_SUPABASE_URL</code>, <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>를
          설정해주세요.
        </p>
      </main>
    );
  }

  async function handleGoogleLogin() {
    setIsLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const { error: signInError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (signInError) throw signInError;
    } catch (err) {
      setError(err instanceof Error ? err.message : "로그인에 실패했습니다.");
      setIsLoading(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-6 px-4 text-center">
      <div>
        <h1 className="text-2xl font-bold text-ink">수학오답프린트 제작</h1>
        <p className="mt-2 text-sm text-slate-500">
          오답과 실전모의고사를 모아 깔끔한 PDF로 인쇄해보세요.
        </p>
      </div>

      {error && (
        <div className="w-full rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={handleGoogleLogin}
        disabled={isLoading}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-ink shadow-sm hover:bg-slate-50 disabled:opacity-50"
      >
        {isLoading ? "이동 중..." : "Google로 로그인"}
      </button>
    </main>
  );
}
