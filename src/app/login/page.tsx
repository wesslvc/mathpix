"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/client";
import { emailConfirmRedirect } from "@/lib/siteUrl";
import Logo from "@/components/Logo";

type Mode = "login" | "signup";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 확인 메일을 다시 보낼 수 있는 상태인가(미확인 계정으로 걸렸을 때). */
  const [canResend, setCanResend] = useState(false);

  // 확인 링크가 실패하면 그 이유를 들고 여기로 돌아온다. 조용히 넘기면
  // 사용자는 왜 안 되는지 알 수 없다.
  useEffect(() => {
    const fromLink = params.get("error");
    if (!fromLink) return;
    // **확인은 끝났는데 자동 로그인만 실패한 경우**(`confirmed=1`)는 실패가
    // 아니다. 빨간 글씨로 보여주고 "확인 메일 다시 보내기"를 띄우면 이미 끝난
    // 일을 다시 하게 만들 뿐이고, 다시 받아도 같은 자리에서 또 막힌다.
    // 이때 필요한 것은 그냥 로그인이다.
    if (params.get("confirmed")) {
      setNotice(fromLink);
      return;
    }
    setError(fromLink);
    setCanResend(true);
  }, [params]);

  /** 확인 메일을 다시 보낸다. 메일을 잃었거나 만료됐을 때 쓸 길이 필요하다. */
  async function resend() {
    if (!email) {
      setError("이메일을 입력한 뒤 다시 눌러주세요.");
      return;
    }
    setIsLoading(true);
    setError(null);
    setNotice(null);
    const supabase = createClient();
    const { error } = await supabase.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: emailConfirmRedirect() },
    });
    if (error) setError(error.message);
    else
      setNotice(
        "확인 메일을 다시 보냈습니다. 메일함(스팸함 포함)을 확인해주세요.",
      );
    setIsLoading(false);
  }

  async function signInWithGoogle() {
    setIsLoading(true);
    setError(null);
    setNotice(null);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        // Supabase가 Google 인증 뒤 이 경로에 PKCE code를 전달하고,
        // 서버가 이를 세션으로 교환한다.
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      setError(error.message);
      setIsLoading(false);
    }
  }


  if (!isSupabaseConfigured()) {
    return (
      <main className="mx-auto flex max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
        <Logo size={40} />
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Supabase 설정이 아직 완료되지 않아 로그인 기능을 사용할 수 없습니다.
          <br />
          <code>NEXT_PUBLIC_SUPABASE_URL</code>,{" "}
          <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>를 설정해주세요.
        </p>
      </main>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    setNotice(null);

    const supabase = createClient();

    if (mode === "login") {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) {
        // Supabase 는 영어로 준다. 자주 나오는 것만 우리말로 바꾸고 재발송을 연다.
        if (/email not confirmed/i.test(error.message)) {
          setError(
            "아직 이메일 확인이 끝나지 않았어요. 메일함의 확인 링크를 눌러주세요.",
          );
          setCanResend(true);
        } else {
          setError(error.message);
        }
      } else {
        router.push("/");
        router.refresh();
        return;
      }
    } else {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: emailConfirmRedirect(),
        },
      });
      if (error) {
        setError(error.message);
      } else if (data.user && data.user.identities?.length === 0) {
        // **이미 가입된 이메일이면 Supabase 는 성공을 돌려준다**(누가 가입했는지
        // 알아내지 못하게 하려는 것이다). 메일은 오지 않으므로 "보냈습니다"라고
        // 하면 오지 않는 메일을 하염없이 기다리게 된다. identities 가 비어 있는
        // 것으로 이 경우를 알 수 있다.
        setError(
          "이미 가입된 이메일입니다. 로그인하거나 확인 메일을 다시 받아주세요.",
        );
        setCanResend(true);
      } else {
        setNotice(
          "가입 확인 메일을 보냈습니다. 메일함(스팸함 포함)을 확인해주세요.",
        );
        setCanResend(true);
      }
    }

    setIsLoading(false);
  }

  return (
    <main className="mx-auto flex max-w-sm flex-col items-center justify-center gap-6 px-4 text-center">
      {/* 첫 화면 — 지오글 랜딩과 같은 짜임(마크 · 워드마크 · 영문 표어 ·
          우리말 한 줄). 같은 브랜드의 두 사이트가 첫인상부터 닮게 둔다. */}
      <div className="flex flex-col items-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/magpie-paper-512.png"
          alt=""
          width={96}
          height={96}
          className="h-24 w-24 select-none"
          draggable={false}
        />
        <span className="mt-2 font-display text-3xl font-semibold tracking-tight text-ink">
          Reprint<span className="text-gblue">OCR</span>
        </span>
        <p className="mt-2 font-display text-[0.7rem] font-medium uppercase tracking-[0.2em] text-slate-500">
          Print what you got wrong
        </p>
        <p className="mt-1 text-sm text-slate-500">
          틀린 문제를 모아 실제 시험지 판형으로 인쇄합니다.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex w-full flex-col gap-3">
        <input
          type="email"
          required
          placeholder="이메일"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
        />
        <input
          type="password"
          required
          minLength={6}
          placeholder="비밀번호 (6자 이상)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
        />

        {error && <p className="text-sm text-red-600">{error}</p>}
        {notice && <p className="text-sm text-emerald-600">{notice}</p>}
        {canResend && (
          <button
            type="button"
            onClick={() => void resend()}
            disabled={isLoading}
            className="text-xs text-slate-500 underline underline-offset-2 hover:text-slate-700 disabled:opacity-50"
          >
            확인 메일 다시 보내기
          </button>
        )}

        <button
          type="submit"
          disabled={isLoading}
          className="mt-1 rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {isLoading ? "처리 중..." : mode === "login" ? "로그인" : "회원가입"}
        </button>
      </form>

      <div className="flex w-full items-center gap-3 text-xs text-slate-400" aria-hidden="true">
        <span className="h-px flex-1 bg-slate-200" />
        또는
        <span className="h-px flex-1 bg-slate-200" />
      </div>

      <button
        type="button"
        onClick={() => void signInWithGoogle()}
        disabled={isLoading}
        className="flex w-full items-center justify-center gap-3 rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5">
          <path fill="#4285F4" d="M21.8 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.8 3.2-4.4 3.2-7.3Z" />
          <path fill="#34A853" d="M12 22c2.7 0 5-0.9 6.6-2.5l-3.2-2.5c-.9.6-2 .9-3.4.9-2.6 0-4.8-1.7-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22Z" />
          <path fill="#FBBC05" d="M6.4 13.8a6 6 0 0 1 0-3.6V7.6H3.1a10 10 0 0 0 0 8.8l3.3-2.6Z" />
          <path fill="#EA4335" d="M12 6.1c1.5 0 2.9.5 3.9 1.5l2.9-2.9A10 10 0 0 0 3.1 7.6l3.3 2.6C7.2 7.8 9.4 6.1 12 6.1Z" />
        </svg>
        Google로 계속하기
      </button>

      <button
        type="button"
        onClick={() => {
          setMode(mode === "login" ? "signup" : "login");
          setError(null);
          setNotice(null);
        }}
        className="text-sm text-slate-500 hover:text-slate-700"
      >
        {mode === "login"
          ? "계정이 없으신가요? 회원가입"
          : "이미 계정이 있으신가요? 로그인"}
      </button>

      {/* 만든 곳 표기 — 사이트는 ReprintOCR, 브랜드는 NEPICA. 지오글의
          랜딩 아래에 있는 것과 같은 표기다. */}
      <a
        href="https://nepica.vercel.app"
        target="_blank"
        rel="noreferrer"
        className="nepica-brand mt-2"
      >
        NEPICA
      </a>
    </main>
  );
}

/**
 * `useSearchParams` 는 Suspense 경계 안에서만 쓸 수 있다(정적 렌더 때문에).
 * 확인 링크가 실패하고 `?error=` 를 달고 돌아오는 것을 읽어야 해서 필요하다.
 */
export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
