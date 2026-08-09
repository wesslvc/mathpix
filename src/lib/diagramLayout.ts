import type React from "react";

/** 문제 카드 안에서 도형 하나를 어떻게 놓을지. */
export type DiagramLayout = {
  /** 카드 너비 대비 가로 크기(%). */
  scale: number;
  /** 가로 이동(px). 음수면 왼쪽, 양수면 오른쪽. */
  offsetX: number;
  /** 위쪽 여백(px). 문제 본문과의 간격을 조절한다. */
  offsetY: number;
};

export const DEFAULT_DIAGRAM_LAYOUT: DiagramLayout = {
  scale: 60,
  offsetX: 0,
  offsetY: 16,
};

/**
 * 도형을 카드에 앉힐 때 쓰는 인라인 스타일.
 *
 * transform 대신 width/margin만 쓴다 — 결과 카드는 html-to-image로 PNG를
 * 캡처하는데, transform은 캡처 결과에서 어긋나는 경우가 있어서 레이아웃
 * 속성으로만 배치하는 편이 안전하다.
 */
export function diagramStyle(layout: DiagramLayout): React.CSSProperties {
  return {
    width: `${layout.scale}%`,
    marginLeft: `calc(${(100 - layout.scale) / 2}% + ${layout.offsetX}px)`,
    marginTop: layout.offsetY,
  };
}

/**
 * 위와 같은 스타일을 CSS 문자열로. 도형·자료를 본문 문단 **사이**에 끼워
 * 넣으려면 본문 HTML 문자열에 함께 이어붙여야 해서 React 스타일 객체를
 * 쓸 수 없다.
 */
export function diagramStyleCss(layout: DiagramLayout): string {
  return [
    `width:${layout.scale}%`,
    `margin-left:calc(${(100 - layout.scale) / 2}% + ${layout.offsetX}px)`,
    `margin-top:${layout.offsetY}px`,
  ].join(";");
}
