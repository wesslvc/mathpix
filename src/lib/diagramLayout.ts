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
 * 표의 기본값.
 *
 * 손대지 않았을 때 예전과 **똑같이** 보여야 한다. 그래서 폭을 100%로 두고 위
 * 여백도 0으로 둔다 — 표 자신의 바깥 여백(.mmd-table의 1.1em)이 그대로 살아
 * 있어서, 껍데기가 생겼다고 간격이 달라지지 않는다.
 */
export const DEFAULT_TABLE_LAYOUT: DiagramLayout = {
  scale: 100,
  offsetX: 0,
  offsetY: 0,
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
export function diagramStyleCss(layout: DiagramLayout, inRow = false): string {
  // 가로로 나란히 놓을 때는 폭을 flex에 맡긴다. width로 잡으면 둘을 합쳐
  // 100%가 넘는 순간 밖으로 삐져나가는데, flex-basis로 주면 남는 만큼만
  // 알아서 줄어든다. 좌우 값은 이때 "가로 순서"를 정하는 데 쓰이므로
  // 여백으로는 반영하지 않는다(반영하면 순서가 바뀌면서 같이 밀린다).
  // 위 여백도 각자 두면 기본값이 다른 둘(그림 16px, 표 0px)이 어긋난 높이로
  // 서더라 나란히 놓은 티가 안 난다. 여백은 줄 전체가 갖고(rowStyleCss),
  // 여기서는 0으로 맞춰 위쪽을 나란히 세운다.
  if (inRow) {
    return [
      `flex:0 1 ${layout.scale}%`,
      "min-width:0",
      "margin-left:0",
      "margin-top:0",
    ].join(";");
  }
  return [
    `width:${layout.scale}%`,
    `margin-left:calc(${(100 - layout.scale) / 2}% + ${layout.offsetX}px)`,
    `margin-top:${layout.offsetY}px`,
  ].join(";");
}

/** 가로로 나란히 놓인 줄 전체의 스타일. 위 여백은 가장 큰 값을 따른다. */
export function rowStyleCss(layouts: DiagramLayout[]): string {
  const top = layouts.reduce((m, l) => Math.max(m, l.offsetY), 0);
  return `margin-top:${top}px`;
}
