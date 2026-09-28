"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { pointInPoly, rectPoly, regionFromPoly, type Pt } from "@/lib/polygon";
import type { CropShape } from "@/lib/cropShape";

/**
 * 사진 위에 영역을 **그리고 · 옮기고 · 크기를 고치는** 편집기. 네모와 다각형을
 * 함께 다룬다.
 *
 * 자동으로 찾은 자리를 그대로 받아들이는 것 말고 **사람이 고칠 수 있어야**
 * 한다 — 모델이 지문 아래를 조금 잘라 먹거나 선지 한 줄을 놓치는 일이 흔한데,
 * 지금까지는 지우고 다시 하는 수밖에 없었다.
 *
 * **다각형**(2026-09-28, 사용자 요청 — "사람이 손으로 자를 때 다각형으로, 기본은
 * 사각형인데 설정 가능하게"). `shape="poly"` 면 새로 그리는 것이 다각형이다:
 *  - 빈 곳을 **톡톡 눌러 점을 찍고**, 첫 점을 다시 누르거나 "완료"로 닫는다.
 *  - **끌면 네모로 시작**한다(네 귀퉁이가 점이 된다) — 네모에서 한두 점만
 *    옮기면 되는 경우가 대부분이라 그쪽이 빠르다.
 *  - 고를 때는 점을 끌어 옮기고, 변 가운데의 작은 점을 끌면 점이 하나 늘고,
 *    점을 누르면 그 옆에 뜨는 × 로 지운다.
 * 다각형도 늘 감싸는 네모(`x,y,w,h`)를 함께 든다(`polygon.ts` 참고) — 그래서
 * 이 편집기를 쓰는 쪽은 예전처럼 네모를 보고, 자를 때만 다각형을 쓴다.
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
  /** 다각형이면 그 점들. 있으면 `x,y,w,h` 는 이 점들을 감싸는 네모다. */
  poly?: Pt[];
};

/** 이보다 작으면 그리다 만 것으로 본다(사진 크기 대비 비율). */
const MIN_SIZE = 0.02;
/** 이만큼(px) 안 움직이고 떼면 "누른 것"이지 끈 것이 아니다. */
const TAP_PX = 6;
/** 첫 점에 이만큼(px) 가까이 누르면 다각형을 닫는다. */
const CLOSE_PX = 16;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** 잡은 손잡이. `move` 는 통째로 옮기기. */
type Grip = "move" | "nw" | "ne" | "sw" | "se";

type Drag =
  | { kind: "draw"; from: { x: number; y: number }; px: { x: number; y: number }; box: EditBox; moved: boolean }
  | { kind: "edit"; grip: Grip; id: string; start: EditBox; from: { x: number; y: number } }
  | { kind: "polyMove"; id: string; start: EditBox; from: { x: number; y: number } }
  | { kind: "vertex"; id: string; index: number; start: EditBox };

export default function BoxEditor({
  image,
  boxes,
  onChange,
  color = "#2563eb",
  colorOf,
  labelOf,
  picked,
  onPick,
  newGroup,
  shape = "rect",
  single = false,
  fit = "width",
  onImageLoad,
  onImageError,
}: {
  image: string;
  boxes: EditBox[];
  onChange: (boxes: EditBox[]) => void;
  color?: string;
  /** 묶음마다 다른 색(지문 단계의 지문/그림 구분). 없으면 `color`. */
  colorOf?: (groupId: string) => string;
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
  /** 새로 그리는 것이 네모인가 다각형인가. 이미 있는 것은 제 모양대로 다룬다. */
  shape?: CropShape;
  /** 영역이 하나뿐인 화면(한 문제 자르기). 새로 그리면 있던 것을 갈아 끼운다. */
  single?: boolean;
  /**
   * `width` 는 사진을 폭에 맞춰 그린다(지면 한 장). `contain` 은 화면 높이의
   * 70% 안에 들어오게 줄인다 — 세로로 긴 사진을 PC 에서 볼 때 스크롤하지 않고
   * 한눈에 자를 수 있게(한 문제 자르기가 쓰던 크기와 같다).
   */
  fit?: "width" | "contain";
  onImageLoad?: (img: HTMLImageElement) => void;
  onImageError?: () => void;
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
  /** 찍고 있는 다각형의 점들(아직 닫지 않았다). */
  const [path, setPath] = useState<Pt[] | null>(null);
  const pathRef = useRef<Pt[] | null>(null);
  /** 찍는 중에 다음 점이 갈 자리(미리보기 선). */
  const [hover, setHover] = useState<Pt | null>(null);
  /** 손잡이를 보여 줄 다각형(마지막으로 만진 것). 다 보이면 어지럽다. */
  const [activeId, setActiveId] = useState<string | null>(null);
  /** 고른 점(× 로 지울 수 있다). */
  const [selVertex, setSelVertex] = useState<{ id: string; index: number } | null>(null);

  const setPathBoth = (p: Pt[] | null) => {
    pathRef.current = p;
    setPath(p);
  };

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

  /** 두 비율 좌표 사이의 화면 거리(px). 가로세로 비가 달라 비율끼리 재면 틀린다. */
  const pxDist = useCallback((a: Pt, b: Pt) => {
    const r = frameRef.current?.getBoundingClientRect();
    if (!r) return Infinity;
    return Math.hypot((a.x - b.x) * r.width, (a.y - b.y) * r.height);
  }, []);

  /** 새로 만든 영역을 넣는다(하나뿐인 화면이면 갈아 끼운다). */
  const commit = useCallback(
    (box: EditBox) => {
      onChange(single ? [box] : [...boxes, box]);
      if (box.poly) setActiveId(box.id);
    },
    [boxes, onChange, single],
  );

  function finishPath() {
    const pts = pathRef.current;
    setPathBoth(null);
    setHover(null);
    if (!pts || pts.length < 3) return;
    const box = regionFromPoly(
      { id: crypto.randomUUID(), group: newGroup ?? crypto.randomUUID() },
      pts,
    ) as EditBox;
    if (box.w < MIN_SIZE || box.h < MIN_SIZE) return;
    commit(box);
  }

  /** 최신 handler 를 ref 에 담아 두고 window 에는 얇은 래퍼만 건다. */
  const moveRef = useRef<(e: PointerEvent) => void>(() => {});
  const upRef = useRef<(e: PointerEvent) => void>(() => {});
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});

  moveRef.current = (e: PointerEvent) => {
    const drag = dragRef.current;
    const at = ratio(e.clientX, e.clientY);
    if (!at) return;
    if (!drag) {
      // 찍는 중이면 다음 점까지 선을 미리 보여 준다(마우스일 때만 뜻이 있다).
      if (pathRef.current) setHover(at);
      return;
    }
    e.preventDefault();

    if (drag.kind === "draw") {
      if (!drag.moved) {
        const r = frameRef.current?.getBoundingClientRect();
        const dx = r ? Math.abs(e.clientX - drag.px.x) : 0;
        const dy = r ? Math.abs(e.clientY - drag.px.y) : 0;
        // 다각형을 찍는 중에는 끌어도 네모를 시작하지 않는다(손이 떨린 것이다).
        if (Math.max(dx, dy) < TAP_PX || pathRef.current) return;
        drag.moved = true;
      }
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

    if (drag.kind === "vertex") {
      const poly = (drag.start.poly ?? []).map((p, i) => (i === drag.index ? at : p));
      const box = regionFromPoly(drag.start, poly) as EditBox;
      currentRef.current = box;
      setPreview(box);
      return;
    }

    const dx = at.x - drag.from.x;
    const dy = at.y - drag.from.y;
    const s = drag.start;

    if (drag.kind === "polyMove") {
      // 통째로 옮길 때는 모양을 지키고 사진 밖으로 나가지 않게만 막는다.
      const mx = Math.min(Math.max(-s.x, dx), 1 - s.x - s.w);
      const my = Math.min(Math.max(-s.y, dy), 1 - s.y - s.h);
      const poly = (s.poly ?? []).map((p) => ({ x: p.x + mx, y: p.y + my }));
      const box = regionFromPoly(s, poly) as EditBox;
      currentRef.current = box;
      setPreview(box);
      return;
    }

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

  upRef.current = (e: PointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    const box = currentRef.current;
    currentRef.current = null;
    setPreview(null);
    if (!drag) return;

    if (drag.kind === "draw") {
      if (!drag.moved) {
        // 누른 것이다. 다각형 모드면 점을 하나 찍는다.
        if (shape !== "poly") return;
        const at = ratio(e.clientX, e.clientY) ?? drag.from;
        const pts = pathRef.current ?? [];
        if (pts.length >= 3 && pxDist(at, pts[0]) <= CLOSE_PX) {
          finishPath();
          return;
        }
        setPathBoth([...pts, at]);
        setSelVertex(null);
        return;
      }
      // 손가락이 살짝 떨린 것은 네모가 아니다.
      if (!box || box.w < MIN_SIZE || box.h < MIN_SIZE) return;
      // 다각형 모드에서 끌어 그린 것은 네 귀퉁이를 점으로 가진 다각형이 된다 —
      // 그다음 한두 점만 옮기면 되는 경우가 대부분이다.
      commit(shape === "poly" ? { ...box, poly: rectPoly(box) } : box);
      return;
    }
    if (!box) return;
    if (box.w < MIN_SIZE || box.h < MIN_SIZE) return;
    onChange(boxes.map((b) => (b.id === drag.id ? box : b)));
  };

  keyRef.current = (e: KeyboardEvent) => {
    if (!pathRef.current) return;
    if (e.key === "Escape") {
      setPathBoth(null);
      setHover(null);
    } else if (e.key === "Enter") {
      e.preventDefault();
      finishPath();
    } else if (e.key === "Backspace") {
      e.preventDefault();
      const pts = pathRef.current;
      setPathBoth(pts.length > 1 ? pts.slice(0, -1) : null);
    }
  };

  useEffect(() => {
    const move = (e: PointerEvent) => moveRef.current(e);
    const up = (e: PointerEvent) => upRef.current(e);
    const key = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key);
    };
  }, []);

  // 모양을 네모로 바꾸면 찍던 점은 버린다.
  useEffect(() => {
    if (shape !== "poly") {
      setPathBoth(null);
      setHover(null);
    }
  }, [shape]);

  function startDraw(e: React.PointerEvent) {
    // 네모 위에서 시작한 것은 그리기가 아니다(그쪽에서 이미 멈춰 세웠다).
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const at = ratio(e.clientX, e.clientY);
    if (!at) return;
    setSelVertex(null);
    const box: EditBox = {
      id: crypto.randomUUID(),
      x: at.x,
      y: at.y,
      w: 0,
      h: 0,
      group: newGroup ?? crypto.randomUUID(),
    };
    dragRef.current = { kind: "draw", from: at, px: { x: e.clientX, y: e.clientY }, box, moved: false };
    currentRef.current = box;
    // 네모 모드에서는 누르자마자 그리기 시작한 것처럼 보여 준다(예전과 같다).
    if (shape !== "poly") setPreview(box);
  }

  function startEdit(e: React.PointerEvent, id: string, grip: Grip) {
    // 다각형을 찍는 중이면 기존 영역 위를 눌러도 점을 찍게 둔다.
    if (pathRef.current) return;
    e.stopPropagation();
    const at = ratio(e.clientX, e.clientY);
    const start = boxes.find((b) => b.id === id);
    if (!at || !start) return;
    dragRef.current = { kind: "edit", grip, id, start, from: at };
    currentRef.current = start;
    setPreview(start);
  }

  function startPolyMove(e: React.PointerEvent, id: string) {
    if (pathRef.current) return;
    e.stopPropagation();
    const at = ratio(e.clientX, e.clientY);
    const start = boxes.find((b) => b.id === id);
    if (!at || !start?.poly) return;
    // 다각형 안쪽을 눌렀을 때만 옮긴다 — 감싸는 네모 안이라도 다각형 바깥이면
    // 그 자리에 새로 그리려는 것일 수 있다.
    if (!pointInPoly(at, start.poly)) return;
    setActiveId(id);
    setSelVertex(null);
    dragRef.current = { kind: "polyMove", id, start, from: at };
    currentRef.current = start;
    setPreview(start);
  }

  function startVertex(e: React.PointerEvent, id: string, index: number, insert: boolean) {
    e.stopPropagation();
    const start = boxes.find((b) => b.id === id);
    if (!start?.poly) return;
    let s = start;
    let i = index;
    if (insert) {
      // 변 가운데 점을 끌면 그 자리에 점이 하나 생기고 곧바로 그 점을 끈다.
      const a = start.poly[index];
      const b = start.poly[(index + 1) % start.poly.length];
      const poly = [...start.poly];
      poly.splice(index + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      s = { ...start, poly };
      i = index + 1;
    } else {
      setSelVertex({ id, index });
    }
    setActiveId(id);
    dragRef.current = { kind: "vertex", id, index: i, start: s };
    currentRef.current = s;
    setPreview(s);
  }

  function removeVertex(id: string, index: number) {
    const b = boxes.find((q) => q.id === id);
    if (!b?.poly || b.poly.length <= 3) return;
    const next = regionFromPoly(b, b.poly.filter((_, i) => i !== index)) as EditBox;
    onChange(boxes.map((q) => (q.id === id ? next : q)));
    setSelVertex(null);
  }

  const shown = preview
    ? boxes.some((b) => b.id === preview.id)
      ? boxes.map((b) => (b.id === preview.id ? preview : b))
      : [...(single ? [] : boxes), preview]
    : boxes;

  const pct = (v: number) => `${v * 100}%`;
  const colorFor = (b: EditBox) => colorOf?.(b.group) ?? color;
  const showLabels = !single;

  const labelChip = (b: EditBox, i: number) =>
    showLabels && (
      <span
        className="absolute -top-0.5 left-0 z-10 flex -translate-y-full items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-px text-[11px] font-semibold text-white shadow-sm"
        style={{
          background: colorFor(b),
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
          aria-label="이 영역 지우기"
          title="이 영역만 지웁니다"
          className="rounded px-1 leading-none hover:bg-white/25"
        >
          ×
        </button>
      </span>
    );

  return (
    <div className={fit === "contain" ? "flex flex-col items-center gap-2" : "flex flex-col gap-2"}>
      <div
        ref={frameRef}
        onPointerDown={startDraw}
        onDoubleClick={() => {
          if (pathRef.current && pathRef.current.length >= 3) finishPath();
        }}
        className={
          (fit === "contain" ? "relative inline-block max-w-full " : "relative w-full ") +
          "select-none overflow-hidden rounded-lg " +
          (shape === "poly" ? "cursor-crosshair" : "cursor-crosshair")
        }
        // 터치가 스크롤로 먹히면 네모를 그릴 수가 없다.
        style={{ touchAction: "none" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={image}
          alt="자를 사진"
          draggable={false}
          onLoad={(e) => onImageLoad?.(e.currentTarget)}
          onError={() => onImageError?.()}
          className={fit === "contain" ? "block max-h-[58vh] w-auto max-w-full sm:max-h-[70vh]" : "block w-full"}
        />

        {/* 다각형은 SVG 로 그린다. 비율 좌표를 그대로 쓰도록 viewBox 를 0~1 로 둔다. */}
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
        >
          {/* 하나뿐인 화면에서는 다각형 바깥을 어둡게 — 네모일 때와 같은 표시다. */}
          {single &&
            shown
              .filter((b) => b.poly)
              .map((b) => (
                <path
                  key={`mask-${b.id}`}
                  d={`M0 0H1V1H0Z M${b.poly!.map((p) => `${p.x} ${p.y}`).join(" L")} Z`}
                  fillRule="evenodd"
                  fill="rgba(15, 18, 24, 0.45)"
                  style={{ pointerEvents: "none" }}
                />
              ))}
          {shown
            .filter((b) => b.poly)
            .map((b) => (
              <polygon
                key={b.id}
                points={b.poly!.map((p) => `${p.x},${p.y}`).join(" ")}
                fill={`${colorFor(b)}22`}
                stroke={colorFor(b)}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
                style={{ pointerEvents: "visiblePainted", cursor: "move" }}
                onPointerDown={(e) => startPolyMove(e as unknown as React.PointerEvent, b.id)}
              />
            ))}
          {path && (
            <polyline
              points={[...path, ...(hover ? [hover] : [])].map((p) => `${p.x},${p.y}`).join(" ")}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeDasharray="6 4"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>

        {shown.map((b, i) =>
          b.poly ? (
            <div key={b.id}>
              {/* 이름표는 감싸는 네모의 왼쪽 위에 둔다. */}
              <div
                className="pointer-events-none absolute"
                style={{ left: pct(b.x), top: pct(b.y), width: pct(b.w), height: 0 }}
              >
                <div className="pointer-events-auto">{labelChip(b, i)}</div>
              </div>
              {(single || activeId === b.id) &&
                b.poly.map((p, vi) => {
                  const q = b.poly![(vi + 1) % b.poly!.length];
                  const sel = selVertex?.id === b.id && selVertex.index === vi;
                  return (
                    <span key={vi}>
                      {/* 변 가운데 — 끌면 점이 하나 는다. */}
                      <span
                        onPointerDown={(e) => startVertex(e, b.id, vi, true)}
                        className="absolute z-10 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 cursor-copy items-center justify-center"
                        style={{ left: pct((p.x + q.x) / 2), top: pct((p.y + q.y) / 2) }}
                        title="끌어서 점 추가"
                      >
                        <span
                          className="h-2.5 w-2.5 rounded-full border bg-white/80"
                          style={{ borderColor: colorFor(b) }}
                        />
                      </span>
                      {/* 점 — 끌어 옮긴다. 누르면 골라지고 × 가 뜬다. */}
                      <span
                        onPointerDown={(e) => startVertex(e, b.id, vi, false)}
                        className="absolute z-20 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center"
                        style={{ left: pct(p.x), top: pct(p.y) }}
                      >
                        <span
                          className={`h-3.5 w-3.5 rounded-full border-2 bg-white shadow ${sel ? "scale-125" : ""}`}
                          style={{ borderColor: colorFor(b) }}
                        />
                      </span>
                      {sel && b.poly!.length > 3 && (
                        <button
                          type="button"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            removeVertex(b.id, vi);
                          }}
                          className="absolute z-30 flex h-6 w-6 -translate-y-1/2 translate-x-2 items-center justify-center rounded-full bg-slate-900 text-xs text-white shadow-md hover:bg-red-600"
                          style={{ left: pct(p.x), top: pct(p.y) }}
                          aria-label="이 점 지우기"
                          title="이 점 지우기"
                        >
                          ×
                        </button>
                      )}
                    </span>
                  );
                })}
            </div>
          ) : (
            <div
              key={b.id}
              onPointerDown={(e) => startEdit(e, b.id, "move")}
              className="absolute cursor-move"
              style={{
                left: pct(b.x),
                top: pct(b.y),
                width: pct(b.w),
                height: pct(b.h),
                border: `2px solid ${colorFor(b)}`,
                background: `${colorFor(b)}18`,
                // 하나뿐인 화면에서는 바깥을 어둡게 해 잘릴 자리를 또렷하게 한다.
                boxShadow: single ? "0 0 0 9999px rgba(15, 18, 24, 0.45)" : undefined,
              }}
            >
              {/* 이름표와 지우기를 **한 줄로 묶어 네모 위에** 둔다.
                  지우기를 네모의 오른쪽 위 바깥에 두었더니 그 자리의 크기 손잡이가
                  덮어 버려 눌리지 않았다(실제 브라우저에서 클릭이 가로막혔다). */}
              {labelChip(b, i)}
              {(["nw", "ne", "sw", "se"] as const).map((g) => (
                <span
                  key={g}
                  onPointerDown={(e) => startEdit(e, b.id, g)}
                  className="absolute h-4 w-4 rounded-full border-2 bg-white shadow"
                  style={{
                    borderColor: colorFor(b),
                    cursor: g === "nw" || g === "se" ? "nwse-resize" : "nesw-resize",
                    left: g === "nw" || g === "sw" ? -8 : undefined,
                    right: g === "ne" || g === "se" ? -8 : undefined,
                    top: g === "nw" || g === "ne" ? -8 : undefined,
                    bottom: g === "sw" || g === "se" ? -8 : undefined,
                  }}
                />
              ))}
            </div>
          ),
        )}

        {/* 찍은 점들. 첫 점은 크게 — 다시 누르면 닫힌다는 표시다. */}
        {path?.map((p, i) => (
          <span
            key={i}
            className={`pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-white ${
              i === 0 && path.length >= 3 ? "h-5 w-5 animate-pulse" : "h-3 w-3"
            }`}
            style={{ left: pct(p.x), top: pct(p.y), borderColor: color }}
          />
        ))}
      </div>

      {shape === "poly" && (
        <div className="flex min-h-8 flex-wrap items-center gap-2 text-xs text-slate-500">
          {path ? (
            <>
              <span className="font-medium text-slate-700">점 {path.length}개</span>
              <button
                type="button"
                onClick={finishPath}
                disabled={path.length < 3}
                className="g-btn g-btn-primary g-btn-xs"
              >
                완료
              </button>
              <button
                type="button"
                onClick={() => setPathBoth(path.length > 1 ? path.slice(0, -1) : null)}
                className="g-btn g-btn-outline g-btn-xs"
              >
                점 하나 취소
              </button>
              <button
                type="button"
                onClick={() => {
                  setPathBoth(null);
                  setHover(null);
                }}
                className="g-btn g-btn-ghost g-btn-xs"
              >
                그만 그리기
              </button>
            </>
          ) : (
            <span>
              빈 곳을 눌러 점을 찍고 첫 점을 다시 누르면 닫혀요 · 끌면 네모로 시작 · 점을
              끌어 옮기고, 변 가운데 작은 점을 끌면 점이 늘어요
            </span>
          )}
        </div>
      )}
    </div>
  );
}
