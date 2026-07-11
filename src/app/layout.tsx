import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "문제 이미지 재구성기",
  description: "사진 속 수학 문제를 자동으로 인식해 가독성 좋은 이미지로 재구성합니다.",
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
