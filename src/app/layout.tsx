import type { Metadata } from "next";
import "./globals.css";

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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      {/* UI는 시스템 산세리프(globals.css에서 지정), 문제 카드만 font-serif로
          명조를 쓴다 — 인쇄물은 명조가 읽기 좋고 화면 UI는 산세리프가 또렷하다. */}
      <body className="antialiased">{children}</body>
    </html>
  );
}
