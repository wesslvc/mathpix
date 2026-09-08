import type { Metadata } from "next";
import "./globals.css";
import FigureJobsProvider from "@/components/FigureJobsProvider";
import FigureJobsPanel from "@/components/FigureJobsPanel";

export const metadata: Metadata = {
  title: "ReprintOCR — 오답프린트 제작",
  description:
    "사진 속 문제를 자동으로 인식해 가독성 좋은 이미지로 재구성하고, 실전모의고사별로 오답을 모아 평가원 판형 PDF로 인쇄할 수 있게 해줍니다. NEPICA.",
  // 파비콘은 로고와 같은 그림(종이를 문 물까치)을 쓴다. 크기별로 세 벌을 두어
  // 탭·홈 화면 어디에서든 뭉개지지 않게 한다.
  icons: {
    icon: [
      { url: "/brand/magpie-paper-64.png", sizes: "64x64", type: "image/png" },
      { url: "/brand/magpie-paper-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/brand/magpie-paper-192.png" }],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      {/* 글꼴 — 지오글(seji)과 같은 짝을 쓴다. 본문은 Pretendard, 로고·숫자
          같은 표시용 글자는 Space Grotesk. 두 사이트가 같은 브랜드로 보이려면
          색보다 글꼴이 먼저다. 둘 다 글꼴이 준비되기 전에는 시스템 글꼴로
          그려지므로(font-display:swap) 첫 글자가 늦게 뜨지 않는다. */}
      <head>
        <link rel="preconnect" href="https://cdn.jsdelivr.net" crossOrigin="" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="stylesheet"
          crossOrigin=""
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css"
        />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&display=swap"
        />
      </head>
      {/* UI는 Pretendard(globals.css에서 지정), 문제 카드만 font-serif로
          명조를 쓴다 — 인쇄물은 명조가 읽기 좋고 화면 UI는 산세리프가 또렷하다. */}
      {/* AI 작업 큐를 **앱 전체**에 둔다. 실모 페이지 안에 두면 목록으로
          돌아가는 순간 통째로 사라져서, 그리던 것이 요금만 나가고 없어진다.
          진행 상황은 화면 구석의 FigureJobsPanel에서 어디서든 볼 수 있다. */}
      <body className="antialiased">
        <FigureJobsProvider>
          {children}
          <FigureJobsPanel />
        </FigureJobsProvider>
      </body>
    </html>
  );
}
