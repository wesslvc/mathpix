type Props = {
  /** 로고 높이(px). 글자 크기는 여기에 비례한다. */
  size?: number;
  /** 마크만 쓰고 글자는 숨긴다(좁은 화면·파비콘용). */
  iconOnly?: boolean;
  className?: string;
};

/**
 * ReprintOCR 로고.
 *
 * 마크는 **종이를 물고 나는 물까치**다. 같은 브랜드(NEPICA)의 지오글은 같은
 * 새가 지구본을 물고 있고, 브랜드 자체는 아무것도 물지 않은 새를 쓴다 —
 * 무엇을 물고 있느냐로 제품을 가른다.
 *
 * 그림 파일을 쓰는 이유: 이 마크는 그라디언트가 겹겹이 들어간 그림이라
 * 손으로 그린 SVG로는 같은 모양이 안 나온다. 대신 **투명 배경 PNG**로
 * 만들어 두어(검은 바탕을 지우면 새의 검은 두건까지 잘려 나가므로, 가장자리
 * 에서 시작하는 채우기로 바깥 검정만 지웠다) 밝은 화면·어두운 화면 어디에
 * 얹어도 새만 떠 있는다.
 *
 * `<img>` 를 그대로 쓴다 — next/image 는 로고 하나를 위해 최적화 왕복을
 * 더할 뿐이고, 이 파일은 이미 크기별로 세 벌을 만들어 두었다.
 */
export default function Logo({ size = 28, iconOnly = false, className }: Props) {
  return (
    <span
      className={`inline-flex items-center gap-2.5 ${className ?? ""}`}
      aria-label="ReprintOCR"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/magpie-paper-512.png"
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
        decoding="async"
        draggable={false}
      />

      {!iconOnly && (
        <span
          className="font-display font-semibold tracking-tight text-ink"
          style={{ fontSize: size * 0.52, letterSpacing: "0.01em" }}
        >
          Reprint<span className="text-gblue">OCR</span>
        </span>
      )}
    </span>
  );
}
