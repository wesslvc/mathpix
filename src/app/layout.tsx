import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "수학오답프린트 제작",
  description:
    "사진 속 수학 문제를 자동으로 인식해 가독성 좋은 이미지로 재구성하고, 실전모의고사별로 오답을 모아 PDF로 인쇄할 수 있게 해줍니다.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body className="font-serif antialiased">{children}</body>
    </html>
  );
}
