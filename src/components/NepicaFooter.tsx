/**
 * 만든 곳 표기 — 사이트는 ReprintOCR, 브랜드는 NEPICA.
 *
 * 세 사이트(지오글 · 리프린트OCR · VDIC)가 **똑같은 모양**으로 바닥에 단다.
 * 마크는 **아무것도 물지 않은 물까치**다 — 제품 마크(종이·지구본·책)가 아니라
 * 브랜드 마크라, 어느 사이트에서 보든 같은 새여야 "같은 곳"이라는 말이 선다.
 * 그래서 파일도 제품 로고와 따로 둔다(`nepica-64.png`) — 제품 로고를 나중에
 * 갈아 끼워도 이 자리는 안 흔들린다.
 *
 * 루트 레이아웃에 한 번만 두어 **모든 화면 맨 밑**에 붙는다(예전에는 대시보드와
 * 로그인 두 곳에만 있었다).
 */
export default function NepicaFooter() {
  return (
    <footer className="flex justify-center px-4 pb-8 pt-10">
      <a
        href="https://nepica.vercel.app"
        target="_blank"
        rel="noreferrer"
        className="nepica-brand"
        aria-label="NEPICA 브랜드 사이트로 이동"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/nepica-64.png" alt="" width={22} height={22} decoding="async" draggable={false} />
        <span>NEPICA</span>
      </a>
    </footer>
  );
}
