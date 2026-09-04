import Logo from "./Logo";

/**
 * 화면 전환 중에 보여 줄 뼈대.
 *
 * **왜 필요한가**: 이 앱의 화면은 전부 서버 컴포넌트라 Supabase 왕복이
 * 끝나야 HTML 이 나온다. 그런데 `loading.tsx` 가 한 개도 없어서 Next 가
 * **서버 응답을 다 받을 때까지 화면을 바꾸지 않았다** — 누르면 아무 일도
 * 안 일어나다가 몇백 ms~몇 초 뒤에 갑자기 다음 화면이 나타난다. 사용자가
 * "뚜둑뚜둑 끊긴 다음 다음 화면이 뜬다"고 한 게 정확히 이것이다.
 *
 * `loading.tsx` 를 두면 Next 가 그 라우트를 Suspense 로 감싸서 **누르는
 * 즉시** 이 뼈대를 그리고 진짜 내용을 뒤이어 흘려보낸다. 기다리는 시간이
 * 줄어드는 건 아니지만 **누른 것이 먹혔다는 게 즉시 보인다** — 체감이
 * 완전히 달라지는 자리다.
 *
 * 곁다리 이득이 하나 더 있다: `<Link>` 프리페치가 **동적 라우트에서는
 * loading 경계까지만** 미리 받아 두는데, 그 경계가 없으면 프리페치가 아무
 * 것도 못 한다. 이 파일들이 생기면서 프리페치도 비로소 일을 한다.
 *
 * 뼈대는 **실제 화면과 같은 폭·같은 자리**여야 한다. 다르면 내용이 도착할
 * 때 통째로 튀어(layout shift) 오히려 더 어수선해 보인다.
 */
export default function PageSkeleton({
  /** 실제 화면의 `max-w-*` 와 맞춘다. */
  maxWidth = "max-w-6xl",
  /** 제목 줄에 로고를 그릴지(대시보드 계열) 아니면 회색 막대만 그릴지. */
  logo = false,
  /** 본문 자리에 그릴 카드 개수. */
  rows = 3,
}: {
  maxWidth?: string;
  logo?: boolean;
  rows?: number;
}) {
  return (
    <main
      className={`mx-auto flex min-h-screen w-full ${maxWidth} flex-col gap-6 px-4 py-10`}
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">불러오는 중…</span>

      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          {logo ? (
            <Logo size={44} />
          ) : (
            <div className="h-7 w-44 rounded bg-slate-200 animate-soft-pulse" />
          )}
          <div className="h-4 w-64 rounded bg-slate-100 animate-soft-pulse" />
        </div>
        <div className="hidden shrink-0 gap-2 sm:flex">
          <div className="h-9 w-24 rounded-lg bg-slate-100 animate-soft-pulse" />
          <div className="h-9 w-24 rounded-lg bg-slate-100 animate-soft-pulse" />
        </div>
      </header>

      {/* 진행률을 알 수 없으니 흘러가는 막대로 "멈춘 게 아니다"를 알린다. */}
      <div className="h-1 w-full overflow-hidden rounded bg-slate-100">
        <div className="h-full w-1/4 rounded bg-slate-300 animate-loading-sweep" />
      </div>

      <div className="flex flex-col gap-3">
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="h-24 w-full rounded-xl border border-slate-200 bg-white"
          >
            <div className="flex h-full flex-col justify-center gap-2 px-4">
              <div className="h-4 w-1/3 rounded bg-slate-200 animate-soft-pulse" />
              <div className="h-3 w-1/2 rounded bg-slate-100 animate-soft-pulse" />
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
