"use client";

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

type Props = {
  label: string;
  layout: DiagramLayout;
  onChange: (next: DiagramLayout) => void;
  onRemove?: () => void;
  /** 본문에서 몇 번째 문단 앞에 놓을지(0 = 맨 위, slotCount = 맨 아래). */
  position?: number;
  /** 놓을 수 있는 자리 이름들. 길이는 문단 수 + 1. */
  slotLabels?: string[];
  onPositionChange?: (next: number) => void;
};

function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[11px] text-slate-500">
      <span className="w-12 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-w-0 flex-1 accent-blue-600"
      />
      <span className="w-12 shrink-0 text-right tabular-nums text-slate-400">
        {value}
        {suffix}
      </span>
    </label>
  );
}

/** 도형 하나의 크기·위치를 조절하는 슬라이더 묶음. */
export default function DiagramAdjuster({
  label,
  layout,
  onChange,
  onRemove,
  position,
  slotLabels,
  onPositionChange,
}: Props) {
  // 위치 조절은 놓을 자리가 둘 이상일 때만 의미가 있다.
  const canMove =
    position !== undefined &&
    slotLabels !== undefined &&
    onPositionChange !== undefined &&
    slotLabels.length > 1;

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-slate-200 px-3 py-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-slate-600">{label}</span>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => onChange(DEFAULT_DIAGRAM_LAYOUT)}
            className="rounded border border-slate-300 px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-slate-100"
          >
            초기화
          </button>
          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              className="rounded border border-slate-300 px-1.5 py-0.5 text-[10px] text-slate-500 hover:border-red-300 hover:bg-red-50 hover:text-red-600"
            >
              삭제
            </button>
          )}
        </div>
      </div>
      {/* 위치는 미리보기에서 그림을 손으로 끌어 옮기는 게 기본이다. 여기
          목록은 지금 어디에 놓였는지 보여주는 표시이자, 손이 아니라 정확히
          몇 번째 문단인지로 고르고 싶을 때 쓰는 보조 수단이다. */}
      {canMove && (
        <div className="flex items-center gap-1.5">
          <span className="w-12 shrink-0 text-[11px] text-slate-500">위치</span>
          <select
            value={position}
            onChange={(e) => onPositionChange(Number(e.target.value))}
            className="min-w-0 flex-1 rounded border border-slate-300 px-1.5 py-0.5 text-[10px] text-slate-600"
          >
            {slotLabels.map((slotLabel, i) => (
              <option key={i} value={i}>
                {slotLabel}
              </option>
            ))}
          </select>
        </div>
      )}
      <Slider
        label="크기"
        value={layout.scale}
        min={15}
        max={100}
        suffix="%"
        onChange={(scale) => onChange({ ...layout, scale })}
      />
      <Slider
        label="좌우"
        value={layout.offsetX}
        min={-300}
        max={300}
        step={4}
        suffix="px"
        onChange={(offsetX) => onChange({ ...layout, offsetX })}
      />
      <Slider
        label="위 여백"
        value={layout.offsetY}
        min={0}
        max={200}
        step={4}
        suffix="px"
        onChange={(offsetY) => onChange({ ...layout, offsetY })}
      />
    </div>
  );
}
