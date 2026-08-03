type Props = {
  /** 로고 높이(px). 글자 크기는 여기에 비례한다. */
  size?: number;
  /** 아이콘만 쓰고 글자는 숨긴다(좁은 화면·파비콘용). */
  iconOnly?: boolean;
  className?: string;
};

/**
 * ReprintOCR 로고.
 *
 * 마크는 "다시 인쇄한다"는 뜻을 담아 종이 한 장 위에 되돌림 화살표를 얹은
 * 모양이다. 구글 제품처럼 파랑·빨강·노랑·초록 네 색을 쓰되, 화살표 획에
 * 그라디언트로 흘려서 조각조각 나뉘어 보이지 않게 했다.
 *
 * SVG로 직접 그린 이유: 외부 이미지로 두면 PNG 캡처(html-to-image)나 인쇄에서
 * 불러오기 실패로 깨질 수 있고, 화면 배율마다 흐려진다.
 */
export default function Logo({ size = 28, iconOnly = false, className }: Props) {
  // 그라디언트 id는 한 화면에 로고가 여러 개 있어도 충돌하지 않아야 한다.
  const gradientId = `reprint-arc-${size}`;

  return (
    <span
      className={`inline-flex items-center gap-2 ${className ?? ""}`}
      aria-label="ReprintOCR"
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 40 40"
        fill="none"
        role="img"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={gradientId} x1="6" y1="8" x2="34" y2="32">
            <stop offset="0%" stopColor="#4285F4" />
            <stop offset="45%" stopColor="#34A853" />
            <stop offset="72%" stopColor="#FBBC05" />
            <stop offset="100%" stopColor="#EA4335" />
          </linearGradient>
        </defs>

        {/* 종이 */}
        <rect
          x="7"
          y="5"
          width="26"
          height="30"
          rx="4"
          fill="#fff"
          stroke="#DADCE0"
          strokeWidth="2"
        />
        {/* 문제의 텍스트 줄 */}
        <path
          d="M13 13h9M13 18h14M13 23h6"
          stroke="#DADCE0"
          strokeWidth="2"
          strokeLinecap="round"
        />
        {/* 되돌림(다시 인쇄) 화살표 */}
        <path
          d="M27.5 26.5a8 8 0 1 1-2.4-9.2"
          stroke={`url(#${gradientId})`}
          strokeWidth="3.2"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M25.6 11.4v6h-6"
          stroke="#EA4335"
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>

      {!iconOnly && (
        <span
          className="font-semibold tracking-tight text-ink dark:text-[#e8eaed]"
          style={{ fontSize: size * 0.62 }}
        >
          Reprint
          <span className="text-[#4285F4]">OCR</span>
        </span>
      )}
    </span>
  );
}
