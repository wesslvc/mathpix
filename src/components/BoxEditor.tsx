"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 사진 위에 네모를 **그리고 · 옮기고 · 크기를 고치는** 편집기.
 *
 * 자동으로 찾은 자리를 그대로 받아들이는 것 말고 **사람이 고칠 수 있어야**
 * 한다 — 모델이 지문 아래를 조금 잘라 먹거나 선지 한 줄을 놓치는 일이 흔한데,
 * 지금까지는 지우고 다시 하는 수밖에 없었다.
 *
 * 좌표는 전부 **사진 크기 대비 비율(0~1)** 이다. 화면 크기가 바뀌어도, 자를 때
 * 원본 해상도로 되돌려도 그대로 맞는다.
 *
 * **끌기는 window 에서 받는다**(`setPointerCapture` 아님). 사진 **바깥**에서
 * 손을 놓는 일이 흔한데(가장자리 네모를 그릴 때) 그때 pointerup 이 아무 데도
 * 닿지 않으면 그린 게 통째로 사라진다. 이건 이 저장소에서 두 번 물린 자리다
 * (BatchSplitPanel·DraggableCard 주석 참고).
 *
 * **state 갱신 함수 안에서 다른 state 를 바꾸지 않는다.** 갱신 함수는 순수해야
 * 하고 React 가 두 번 부를 수 있다 — 실제로 그렇게 썼다가 끌기 한 번에 네모가
 * 두 개 생긴 적이 있다. 끄는 동안의 값은 ref 로 든다.
 */

export type EditBox = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * 같은 묶음(한 문항)에 속하는 네모끼리 같은 값을 갖는다.
   *
   * **한 문항이 여러 단·여러 쪽에 걸치는 일이 흔하다** — 국어는 발문이 왼쪽
   * 단 아래에서 시작해 오른쪽 단 위로, 심하면 다음 쪽으로 이어진다. 네모
   * 하나만 잡게 두면 그런 문항은 통째로 넣을 수가 없다. 조각마다 네모를
   * 그리고 같은 묶음으로 묶으면 자를 때 세로로 이어 붙인다.
   */
  group: string;
};

/** 이보다 작으면 그리다 만 것으로 본다(사진 크기 대비 비율). */
const MIN_SIZE = 0.02;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** 잡은 손잡이. `move` 는 통째로 옮기기. */
type Grip = "move" | "nw" | "ne" | "sw" | "se";

type Drag =
  | { kind: "draw"; from: { x: number; y: number }; box: EditBox }
  | { kind: "edit"; grip: Grip; id: string; start: EditBox; from: { x: number; y: number } };

export default function BoxEditor({
  image,
  boxes,
  onChange,
  color = "#2563eb",
  labelOf,
  picked,
  onPick,
  newGroup,
}: {
  image: string;
  boxes: EditBox[];
  onChange: (boxes: EditBox[]) => void;
  color?: string;
  /** 네모 위에 찍을 글자. 묶음 id 를 받는다. */
  labelOf?: (groupId: string) => string;
  /** 고른 묶음들. 이름표를 눌러 고른다(합치기·풀기에 쓴다). */
  picked?: Set<string>;
  onPick?: (groupId: string) => void;
  /**
   * 새로 그린 네모가 가질 묶음 id. 지문 단계처럼 **그린 것이 전부 한 덩어리**
   * 여야 하는 곳에서는 고정값을 준다. 없으면 네모마다 새 묶음이다.
   */
  newGroup?: string;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  /** 끄는 중인 네모(화면에만 그린다). 손을 뗄 때 한 번만 onChange 한다. */
  const [preview, setPreview] = useState<EditBox | null>(null);
  /**
   * 끄는 중인 네모의 **최신 값**. 손을 뗄 때는 이걸 읽는다.
   *
   * state 를 읽으면 안 된다 — 손을 떼는 handler 는 렌더 때 만들어지므로 그때의
   * `preview` 를 붙들고 있는데, **움직임과 뗌이 한 프레임 안에 들어오면**
   * React 가 다시 그리기 전이라 옛 값(크기 0)을 보고 그린 것을 통째로 버린다.
   * 실제로 터치 입력을 한 묶음으로 보냈더니 네모가 하나도 안 생겼다.
   */
  const currentRef = useRef<EditBox | null>(null);

  /** 화면 좌표 → 사진 안의 비율. */
  const ratio = useCallback((clientX: number, clientY: number) => {
    const el = frameRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return {
      x: clamp01((clientX - r.left) / r.width),
      y: clamp01((clientY - r.top) / r.height),
    };
  }, []);

  /** 최신 handler 를 ref 에 담아 두고 window 에는 얇은 래퍼만 건다. */
  const moveRef = useRef<(e: PointerEvent) => void>(() => {});
  const upRef = useRef<(e: PointerEvent) => void>(() => {});

  moveRef.current = (e: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const at = ratio(e.clientX, e.clientY);
    if (!at) return;
    e.preventDefault();

    if (drag.kind === "draw") {
      const box: EditBox = {
        id: drag.box.id,
        group: drag.box.group,
        x: Math.min(drag.from.x, at.x),
        y: Math.min(drag.from.y, at.y),
        w: Math.abs(at.x - drag.from.x),
        h: Math.abs(at.y - drag.from.y),
      };
      drag.box = box;
      currentRef.current = box;
      setPreview(box);
      return;
    }

    const dx = at.x - drag.from.x;
    const dy = at.y - drag.from.y;
    const s = drag.start;
    let box: EditBox;
    if (drag.grip === "move") {
      // 옮길 때는 크기를 지키고 사진 밖으로 나가지 않게만 막는다.
      box = {
        ...s,
        x: Math.min(Math.max(0, s.x + dx), 1 - s.w),
        y: Math.min(Math.max(0, s.y + dy), 1 - s.h),
      };
    } else {
      const left = drag.grip === "nw" || drag.grip === "sw";
      const top = drag.grip === "nw" || drag.grip === "ne";
      const x0 = clamp01(left ? s.x + dx : s.x);
      const y0 = clamp01(top ? s.y + dy : s.y);
      const x1 = clamp01(left ? s.x + s.w : s.x + s.w + dx);
      const y1 = clamp01(top ? s.y + s.h : s.y + s.h + dy);
      box = {
        ...s,
        x: Math.min(x0, x1),
        y: Math.min(y0, y1),
        w: Math.abs(x1 - x0),
        h: Math.abs(y1 - y0),
      };
    }
    currentRef.current = box;
    setPreview(box);
  };

  upRef.current = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    const box = currentRef.current;
    currentRef.current = null;
    setPreview(null);
    if (!drag) return;

    if (drag.kind === "draw") {
      // 손가락이 살짝 떨린 것은 네모가 아니다.
      if (!box || box.w < MIN_SIZE || box.h < MIN_SIZE) return;
      onChange([...boxes, box]);
      return;
    }
    if (!box) return;
    if (box.w < MIN_SIZE || box.h < MIN_SIZE) return;
    onChange(boxes.map((b) => (b.id === drag.id ? box : b)));
  };

  useEffect(() => {
    const move = (e: PointerEvent) => moveRef.current(e);
    const up = (e: PointerEvent) => upRef.current(e);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);

  function startDraw(e: React.PointerEvent) {
    // 네모 위에서 시작한 것은 그리기가 아니다(그쪽에서 이미 멈춰 세웠다).
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const at = ratio(e.clientX, e.clientY);
    if (!at) return;
    const box: EditBox = {
      id: crypto.randomUUID(),
      x: at.x,
      y: at.y,
      w: 0,
      h: 0,
      group: newGroup ?? crypto.randomUUID(),
    };
    dragRef.current = { kind: "draw", from: at, box };
    currentRef.current = box;
    setPreview(box);
  }

  function startEdit(e: React.PointerEvent, id: string, grip: Grip) {
    e.stopPropagation();
    const at = ratio(e.clientX, e.clientY);
    const start = boxes.find((b) => b.id === id);
    if (!at || !start) return;
    dragRef.current = { kind: "edit", grip, id, start, from: at };
    currentRef.current = start;
    setPreview(start);
  }

  const shown = preview
    ? boxes.some((b) => b.id === preview.id)
      ? boxes.map((b) => (b.id === preview.id ? preview : b))
      : [...boxes, preview]
    : boxes;

  const pct = (v: number) => `${v * 100}%`;

  return (
    <div
      ref={frameRef}
      onPointerDown={startDraw}
      className="relative w-full select-none overflow-hidden rounded border border-slate-200"
      // 터치가 스크롤로 먹히면 네모를 그릴 수가 없다.
      style={{ touchAction: "none" }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image} alt="지면" className="w-full" draggable={false} />

      {shown.map((b, i) => (
        <div
          key={b.id}
          onPointerDown={(e) => startEdit(e, b.id, "move")}
          className="absolute cursor-move"
          style={{
            left: pct(b.x),
            top: pct(b.y),
            width: pct(b.w),
            height: pct(b.h),
            border: `2px solid ${color}`,
            background: `${color}18`,
          }}
        >
          {/* 이름표와 지우기를 **한 줄로 묶어 네모 위에** 둔다.
              지우기를 네모의 오른쪽 위 바깥에 두었더니 그 자리의 크기 손잡이가
              덮어 버려 눌리지 않았다(실제 브라우저에서 클릭이 가로막혔다). */}
          <span
            className="absolute -top-0.5 left-0 z-10 flex -translate-y-full items-center gap-1 whitespace-nowrap rounded px-1 text-[11px] font-medium text-white"
            style={{
              background: color,
              // 고른 묶음은 테두리로 표시한다(색을 바꾸면 지문/문제 구분과 섞인다).
              outline: picked?.has(b.group) ? "2px solid #f59e0b" : undefined,
            }}
          >
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onPick?.(b.group);
              }}
              className={onPick ? "hover:underline" : "cursor-default"}
            >
              {labelOf ? labelOf(b.group) : String(i + 1)}
            </button>
            <button
              type="button"
              // 지우려고 누른 것이 새 네모를 그리기 시작하면 안 된다.
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onChange(boxes.filter((q) => q.id !== b.id));
              }}
              aria-label="이 네모 지우기"
              title="이 네모만 지웁니다"
              className="rounded px-1 leading-none hover:bg-white/25"
            >
              ×
            </button>
          </span>
          {(["nw", "ne", "sw", "se"] as const).map((g) => (
            <span
              key={g}
              onPointerDown={(e) => startEdit(e, b.id, g)}
              className="absolute h-4 w-4 rounded-sm bg-white ring-1 ring-slate-400"
              style={{
                cursor: g === "nw" || g === "se" ? "nwse-resize" : "nesw-resize",
                left: g === "nw" || g === "sw" ? -8 : undefined,
                right: g === "ne" || g === "se" ? -8 : undefined,
                top: g === "nw" || g === "ne" ? -8 : undefined,
                bottom: g === "sw" || g === "se" ? -8 : undefined,
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
