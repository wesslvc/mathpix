"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import Logo from "./Logo";

/**
 * 전역 내비게이션.
 *
 * **없어서 생긴 문제였다.** 예전에는 전역 헤더가 아예 없어서 화면마다
 * "← 목록으로" 링크를 따로 만들고 있었고(대시보드·실모·내보내기·프로필·
 * 채점 기록이 각자), 그래서 지금 어디에 있는지·어디로 갈 수 있는지가 화면을
 * 옮길 때마다 달라졌다. 사용자가 "PC 스럽지도 않다"고 한 것의 절반이 이것이다
 * — 앱이 아니라 낱장 페이지 묶음처럼 보였다.
 *
 * 모양은 형제 사이트(VDIC 의 `NavBar`)와 **같은 규칙**이다: 위에 붙어 따라
 * 오고, 아래 테두리 한 줄, 반투명 배경에 블러, 링크는 알약 모양이며 지금
 * 있는 곳은 색을 뒤집어 표시한다. 폭만 이 앱에 맞게 넓혔다(VDIC 은 단어장
 * 이라 `max-w-2xl` 이지만 여기는 실모 목록·문제 격자가 들어간다).
 *
 * **로그인 화면에서는 안 보인다.** 아직 들어오지 않은 사람에게 앱 안쪽으로
 * 가는 링크를 늘어놓아 봐야 전부 로그인으로 되돌아온다.
 */
const LINKS = [
  { href: "/", label: "실모" },
  { href: "/grade", label: "채점" },
  { href: "/profile", label: "성적" },
  { href: "/answer-sheet", label: "정답표" },
] as const;

export default function AppNav() {
  const pathname = usePathname();

  // 로그인·인증 콜백에서는 감춘다.
  if (pathname.startsWith("/login") || pathname.startsWith("/auth")) return null;

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <nav className="sticky top-0 z-30 border-b border-slate-200 bg-white/85 backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-2 px-4 py-2.5">
        <Link href="/" className="mr-1 shrink-0" aria-label="ReprintOCR 홈">
          {/* 좁은 화면에서는 마크만 — 워드마크까지 두면 링크가 밀려 잘린다. */}
          <span className="hidden sm:inline-flex">
            <Logo size={26} />
          </span>
          <span className="inline-flex sm:hidden">
            <Logo size={26} iconOnly />
          </span>
        </Link>

        {/* 링크가 많아지면 좁은 화면에서 가로로 민다(잘리지 않는다). */}
        <div className="flex flex-1 gap-1 overflow-x-auto">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              aria-current={isActive(l.href) ? "page" : undefined}
              className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                isActive(l.href)
                  ? "bg-slate-900 text-white"
                  : "text-slate-500 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </div>
      </div>
    </nav>
  );
}
