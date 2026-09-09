import type { Metadata, Viewport } from "next";
import { Space_Grotesk } from "next/font/google";
import "./globals.css";
import FigureJobsProvider from "@/components/FigureJobsProvider";
import FigureJobsPanel from "@/components/FigureJobsPanel";
import AppNav from "@/components/AppNav";

/**
 * 표시용 글꼴 — 로고와 숫자에 쓴다. 지오글·VDIC 과 **같은 글꼴**이다.
 * 본문(Pretendard)은 구글 폰트가 아니라 next/font 로 못 받으므로 아래
 * `<head>` 에서 CDN 으로 가져온다(형제 사이트 둘도 같은 주소를 쓴다).
 */
const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  display: "swap",
});

/** 로고와 같은 모양의 파비콘. 외부 파일 없이 data URI로 넣어 404를 피한다. */
const FAVICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">` +
  `<rect x="7" y="5" width="26" height="30" rx="4" fill="#fff" stroke="#dadce0" stroke-width="2"/>` +
  `<path d="M13 13h9M13 18h14M13 23h6" stroke="#dadce0" stroke-width="2" stroke-linecap="round"/>` +
  `<path d="M27.5 26.5a8 8 0 1 1-2.4-9.2" stroke="#1a73e8" stroke-width="3.2" stroke-linecap="round" fill="none"/>` +
  `<path d="M25.6 11.4v6h-6" stroke="#ea4335" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` +
  `</svg>`;

export const metadata: Metadata = {
  title: "ReprintOCR — 오답프린트 제작",
  description:
    "사진 속 수학 문제를 자동으로 인식해 가독성 좋은 이미지로 재구성하고, 실전모의고사별로 오답을 모아 PDF로 인쇄할 수 있게 해줍니다.",
  icons: {
    icon: [
      {
        url: `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`,
        type: "image/svg+xml",
      },
    ],
  },
};

/** 주소창까지 브랜드 바탕색으로 잇는다(형제 사이트와 같은 처리). */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f6f7f9",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko" className={spaceGrotesk.variable}>
      <head>
        {/* 본문 글꼴 — 지오글·VDIC 과 **같은 주소**를 쓴다. */}
        <link rel="preconnect" href="https://cdn.jsdelivr.net" crossOrigin="" />
        <link
          rel="stylesheet"
          crossOrigin=""
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css"
        />
      </head>
      {/* UI는 Pretendard(globals.css에서 지정), 문제 카드만 font-serif로
          명조를 쓴다 — 인쇄물은 명조가 읽기 좋고 화면 UI는 산세리프가 또렷하다. */}
      {/* AI 작업 큐를 **앱 전체**에 둔다. 실모 페이지 안에 두면 목록으로
          돌아가는 순간 통째로 사라져서, 그리던 것이 요금만 나가고 없어진다.
          진행 상황은 화면 구석의 FigureJobsPanel에서 어디서든 볼 수 있다. */}
      <body className="flex min-h-screen flex-col antialiased">
        <FigureJobsProvider>
          <AppNav />
          <div className="flex-1">{children}</div>
          {/* 만든 곳 표기 — 사이트는 ReprintOCR, 브랜드는 NEPICA.
              형제 사이트(VDIC)와 같은 자리·같은 모양이다. */}
          <footer className="flex justify-center pb-8 pt-6">
            <a
              href="https://nepica.vercel.app"
              target="_blank"
              rel="noreferrer"
              className="nepica-brand text-slate-500"
            >
              NEPICA
            </a>
          </footer>
          <FigureJobsPanel />
        </FigureJobsProvider>
      </body>
    </html>
  );
}
