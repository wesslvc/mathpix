"use client";

import {
  DEFAULT_DIAGRAM_LAYOUT,
  DEFAULT_TABLE_LAYOUT,
  diagramStyle,
  diagramStyleCss,
  type DiagramLayout,
} from "@/lib/diagramLayout";

// 예전 import 경로를 쓰던 곳들이 있어 그대로 다시 내보낸다.
export {
  DEFAULT_DIAGRAM_LAYOUT,
  DEFAULT_TABLE_LAYOUT,
  diagramStyle,
  diagramStyleCss,
  type DiagramLayout,
};

type Props = {
  label: string;
  layout: DiagramLayout;
  onChange: (next: DiagramLayout) => void;
  /** "초기화"가 되돌릴 값. 표는 그림과 기본값이 다르다. */
  defaultLayout?: DiagramLayout;
  onRemove?: () => void;
  /** 본문에서 몇 번째 문단 앞에 놓을지(0 = 맨 위, slotCount = 맨 아래). */
  position?: number;
  /** 놓을 수 있는 자리 이름들. 길이는 문단 수 + 1. */
  slotLabels?: string[];
  onPositionChange?: (next: number) => void;
  /** 라벨 아래에 덧붙일 안내(주로 실패 사유). */
  note?: string;
  /** 실패한 AI 작업을 다시 시도한다. */
  onRetry?: () => void;
  /** AI가 처리 중이면 라벨을 옅게 깜빡여 알린다. */
  busy?: boolean;
  /** 같은 자리에 놓인 것과 가로로 나란히 놓을지. */
  row?: boolean;
  onRowChange?: (next: boolean) => void;
  /** 같은 자리에 놓인 다른 것의 개수. 0이면 나란히 세울 상대가 없다. */
  rowMates?: number;
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
  defaultLayout = DEFAULT_DIAGRAM_LAYOUT,
  onRemove,
  position,
  slotLabels,
  onPositionChange,
  note,
  onRetry,
  busy = false,
  row = false,
  onRowChange,
  rowMates = 0,
}: Props) {
  // 위치 조절은 놓을 자리가 둘 이상일 때만 의미가 있다.
  const canMove =
    position !== undefined &&
    slotLabels !== undefined &&
    onPositionChange !== undefined &&
    slotLabels.length > 1;
  /** 나란히 놓기가 실제로 작동 중인가(상대가 있어야 뜻이 있다). */
  const rowActive = row && rowMates > 0;

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-slate-200 px-3 py-2">
      <div className="flex items-center justify-between">
        <span
          className={`text-[11px] font-medium text-slate-600 ${busy ? "animate-soft-pulse" : ""}`}
        >
          {label}
        </span>
        <div className="flex gap-1">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="rounded border border-blue-300 bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700 hover:bg-blue-100"
            >
              다시 시도
            </button>
          )}
          <button
            type="button"
            onClick={() => onChange(defaultLayout)}
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
      {note && (
        <p className="text-[10px] leading-snug text-amber-700">{note}</p>
      )}

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
      {/* 같은 자리에 놓인 것끼리 가로로 나란히. 표 옆에 지도·그래프를 세우는
          경우가 흔해서 필요하다. 상대가 없으면 켜도 달라지지 않으므로 그
          사실을 그대로 알려준다. */}
      {onRowChange && (
        <label className="flex items-start gap-1.5 text-[11px] text-slate-500">
          <input
            type="checkbox"
            checked={row}
            onChange={(e) => onRowChange(e.target.checked)}
            className="mt-0.5 accent-blue-600"
          />
          <span>
            옆으로 나란히
            {row && rowMates === 0 && (
              <span className="ml-1 text-amber-700">
                — 같은 자리에 다른 게 없어요. 표나 그림을 같은 자리로 옮기면
                나란히 놓입니다.
              </span>
            )}
          </span>
        </label>
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
        // 나란히 놓였을 때는 좌우로 밀 자리가 없다. 대신 이 값이 가로 순서를
        // 정한다 — 미리보기에서 옆으로 끌면 이 값이 바뀌어 자리가 바뀐다.
        label={rowActive ? "가로 순서" : "좌우"}
        value={layout.offsetX}
        min={-300}
        max={300}
        step={4}
        suffix={rowActive ? "" : "px"}
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
