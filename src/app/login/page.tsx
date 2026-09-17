"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/client";
import { emailConfirmRedirect } from "@/lib/siteUrl";
import Logo from "@/components/Logo";

/**
 * 화면은 둘뿐이다.
 * - "google": 첫 화면. 구글 버튼 하나만 보인다 — 새 가입도 이걸로 한다
 *   (Google OAuth 는 계정이 없으면 자동으로 만든다). 이메일/비밀번호 칸은
 *   여기 없다 — 처음부터 보이면 사람들이 예전 습관대로 그걸 쓴다.
 * - "migrate": "예전 계정 마이그레이션"을 눌렀을 때만 나타난다. 이메일/
 *   비밀번호로 **로그인만** 한다(회원가입은 없다 — 새 계정은 구글로 만들면
 *   되므로 여기 있을 이유가 없다). 로그인에 성공하면 **곧바로**
 *   `linkIdentity()`로 구글 계정 연결을 이어간다 — 로그인 한 번으로
 *   "예전 계정 확인 + 구글 연결"이 한 흐름이 된다.
 */
type View = "google" | "migrate";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [view, setView] = useState<View>("google");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
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
      setView("migrate");
      return;
    }
    setError(fromLink);
    setCanResend(true);
    // 이메일 관련 링크에서 왔다는 뜻이라 이메일/비밀번호 칸이 필요하다.
    setView("migrate");
  }, [params]);

  /**
   * 구글로 로그인/가입한다. 이메일이 이미 비밀번호 계정으로 가입돼 있으면
   * Supabase 가 **같은 이메일 + 확인된 상태**일 때 자동으로 같은 계정에
   * 구글 로그인 수단을 연결해 준다(Automatic Linking). 이메일이 다르면
   * "예전 계정 마이그레이션"(아래 `handleMigrate`)을 거쳐야 한다.
   */
  async function signInWithGoogle() {
    setIsGoogleLoading(true);
    setError(null);
    setNotice(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: emailConfirmRedirect() },
    });
    // 성공하면 브라우저가 곧바로 구글로 이동하므로 여기서 할 일이 없다.
    if (error) {
      setError(error.message);
      setIsGoogleLoading(false);
    }
  }

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

  /**
   * 예전 이메일/비밀번호 계정으로 로그인한 뒤 **그 자리에서 곧바로** 구글
   * 계정 연결로 이어간다. 회원가입은 없다 — 이 칸은 "이미 있는 계정을
   * 확인하는" 용도뿐이다.
   */
  async function handleMigrate(e: React.FormEvent) {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    setNotice(null);

    const supabase = createClient();
    const { error: loginError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (loginError) {
      // Supabase 는 영어로 준다. 자주 나오는 것만 우리말로 바꾸고 재발송을 연다.
      if (/email not confirmed/i.test(loginError.message)) {
        setError(
          "아직 이메일 확인이 끝나지 않았어요. 메일함의 확인 링크를 눌러주세요.",
        );
        setCanResend(true);
      } else if (/invalid login credentials/i.test(loginError.message)) {
        setError("이메일 또는 비밀번호가 올바르지 않습니다.");
      } else {
        setError(loginError.message);
      }
      setIsLoading(false);
      return;
    }

    // 로그인 성공 — 곧바로 구글 계정 연결로 이어간다. 여기서 실패해도
    // (이미 연결돼 있음, 대시보드에서 manual linking을 안 켬 등) 로그인
    // 자체는 이미 끝났으니 그냥 들여보낸다. 구글 연결은 프로필에서 다시
    // 시도할 수 있다.
    const { error: linkError } = await supabase.auth.linkIdentity({
      provider: "google",
      options: { redirectTo: emailConfirmRedirect() },
    });
    if (linkError) {
      router.push("/");
      router.refresh();
      return;
    }
    // 성공하면 브라우저가 곧바로 구글로 이동하므로 여기서 할 일이 없다.
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

      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-emerald-600">{notice}</p>}

      {view === "google" ? (
        <>
          <button
            type="button"
            onClick={() => void signInWithGoogle()}
            disabled={isGoogleLoading}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
              <path
                fill="#4285F4"
                d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
              />
              <path
                fill="#34A853"
                d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.87-3.04.87-2.34 0-4.32-1.58-5.03-3.71H.96v2.33A9 9 0 0 0 9 18z"
              />
              <path
                fill="#FBBC05"
                d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z"
              />
              <path
                fill="#EA4335"
                d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.59-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
              />
            </svg>
            {isGoogleLoading ? "이동 중..." : "Google로 계속하기"}
          </button>

          <button
            type="button"
            onClick={() => {
              setView("migrate");
              setError(null);
              setNotice(null);
            }}
            className="text-sm text-slate-500 hover:text-slate-700"
          >
            예전 이메일 계정이 있으신가요? 계정 마이그레이션
          </button>
        </>
      ) : (
        <>
          <form onSubmit={handleMigrate} className="flex w-full flex-col gap-3">
            <p className="text-left text-xs text-slate-500">
              예전에 쓰던 이메일과 비밀번호로 로그인하면, 그 계정에 구글
              로그인을 바로 연결해드려요. 다음부터는 구글로 로그인할 수
              있습니다.
            </p>
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
              placeholder="비밀번호"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
            />

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
              {isLoading ? "처리 중..." : "로그인하고 Google 연결하기"}
            </button>
          </form>

          <button
            type="button"
            onClick={() => {
              setView("google");
              setError(null);
              setNotice(null);
              setCanResend(false);
            }}
            className="text-sm text-slate-500 hover:text-slate-700"
          >
            ← 돌아가기
          </button>
        </>
      )}

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
