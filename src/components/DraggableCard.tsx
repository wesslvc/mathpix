"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { buildAnchors, buildCardHtml, type CardFigure, type FigureOverlay } from "@/lib/cardHtml";
import type { DiagramLayout } from "@/lib/diagramLayout";
import type { RenderedBlock } from "@/lib/renderMathText";
import ScaledCard from "./ScaledCard";

type Props = {
  /** 최상위 요소(문단/조건 박스/표) 하나씩. */
  blocks: RenderedBlock[];
  /** 카드에 붙일 그림·표. 표도 그림과 똑같이 옮길 수 있다. */
  figures: CardFigure[];
  fontSizePx: number;
  width: number;
  /** 카드 자체(=PNG로 캡처되는 요소)의 클래스. 화면마다 다르다. */
  cardClassName?: string;
  /** 캡처 대상 노드를 부모가 잡을 수 있게 한다. */
  cardRef: React.RefObject<HTMLDivElement>;
  onLayoutChange: (id: string, next: DiagramLayout) => void;
  onPositionChange: (id: string, slot: number) => void;
  /** 다른 그림 위에 덧붙인 그림을 옮기거나 크기를 바꿨다(`CardFigure.overlay`). */
  onOverlayChange?: (id: string, overlay: FigureOverlay) => void;
  /**
   * 지금 끌고 있는 중인지 알려준다. 자동 저장은 이때 미뤄야 한다 — 끄는
   * 동안에는 DOM만 바뀐 상태라 지금 캡처하면 어중간한 위치가 이미지로 굳는다.
   */
  draggingRef?: React.MutableRefObject<boolean>;
};

/**
 * 문제 카드 + 손으로 끌어 옮기기.
 *
 * 인식 결과 화면과 "문제 내용 수정" 화면이 **같은 것을 써야 한다.** 양쪽에
 * 따로 구현하면 반드시 어긋난다(자리 계산이 조금만 달라도 그림이 엉뚱한 데
 * 붙는다). 카드 조립은 cardHtml.ts 한 곳, 그걸 화면에 얹고 끌게 하는 건
 * 여기 한 곳이다.
 */
export default function DraggableCard({
  blocks,
  figures,
  fontSizePx,
  width,
  cardClassName = "",
  cardRef,
  onLayoutChange,
  onPositionChange,
  onOverlayChange,
  draggingRef,
}: Props) {
  const contentRef = useRef<HTMLDivElement>(null);
  const cardWrapRef = useRef<HTMLDivElement>(null);
  // 카드가 화면 폭에 맞춰 축소돼 있으면 손가락이 움직인 화면 거리와 카드
  // 안에서의 거리가 다르다. 드래그 계산에서 되돌리려고 배율을 들고 있는다.
  const scaleRef = useRef(1);
  const [scaleTick, setScaleTick] = useState(0);
  const handleScaleChange = useCallback((s: number) => {
    scaleRef.current = s;
    setScaleTick((n) => n + 1);
  }, []);

  /**
   * **옮기기·크기 조절은 "조절" 버튼을 눌렀을 때만 된다**(2026-10-02, 사용자 — "크기조절이랑 위치이동은 항상 되는 게
   * 아니라 버튼 누르면 되게"). 늘 켜져 있으면 휴대폰에서 카드를 스크롤하려다 그림을 끌어 버린다. 꺼져 있을 때는
   * 그림이 손가락을 받지 않는다(`figures-locked` — 터치가 스크롤로 간다).
   */
  const [editMode, setEditMode] = useState(false);
  /** 고른 그림. 크기 손잡이가 그 둘레에 붙는다. */
  const [selected, setSelected] = useState<string | null>(null);
  /** 고른 그림의 상자(카드 좌표). 손잡이를 그 네 귀퉁이에 놓는다. */
  const [selBox, setSelBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  const anchors = useMemo(() => buildAnchors(blocks), [blocks]);
  const cardHtml = useMemo(
    () => buildCardHtml(blocks, figures),
    [blocks, figures],
  );

  /**
   * `{ __html }` 객체를 **한 번만** 만든다. 이 앱의 React(Next 14 앱 라우터에 실린 것)는 `dangerouslySetInnerHTML`
   * 을 글자가 아니라 **객체가 바뀌었는지**로 견준다 — 렌더마다 새 객체를 주면 글자가 같아도 본문 innerHTML 을 통째로
   * 다시 넣는다. 그래서 그림을 누르기만 해도(고른 것 표시로 다시 그림) 카드 전체가 갈아 끼워지고 그림을 다시 풀었다
   * (실제 브라우저로 확인 — pointerdown 한 번에 본문 교체 2번). 위 주석의 "누르자마자 자식이 교체된다"도 이것이었다.
   */
  const cardHtmlProp = useMemo(() => ({ __html: cardHtml }), [cardHtml]);

  const figureOf = (id: string) => figures.find((f) => f.id === id);

  // ── 손으로 끌어 옮기기 ────────────────────────────────────────────────
  // 끄는 동안에는 놓을 자리를 state에 반영하지 않고 DOM 스타일만 직접 바꾼다.
  // 본문은 dangerouslySetInnerHTML 한 덩어리라, 다시 그려질 때마다 React가
  // 자식들을 통째로 갈아끼우기 때문이다.
  //
  // **그래서 잡고 있는 요소를 붙들고 있으면 안 된다.** 안내선이 나타나는 것만으로
  // 도 카드가 한 번 다시 그려져서, 처음에 잡은 그 DOM 노드는 곧 떨어져 나간다
  // (실제 브라우저에서 확인 — pointerdown 직후 자식 전체가 교체된다). 그래서
  //  · 움직일 때마다 id로 지금 화면에 있는 요소를 다시 찾고,
  //  · setPointerCapture 대신 window에서 pointermove/up을 받는다.
  // 예전에는 캡처에 기대다 보니 카드 바깥(여백)에서 손을 놓으면 pointerup이
  // 어디에도 닿지 않아 옮긴 게 통째로 무시됐다.
  const dragRef = useRef<
    | {
        kind: "move";
        id: string;
        startX: number;
        startOffsetX: number;
        slot: number;
      }
    | {
        /** 덧붙인 그림 옮기기 — 받침 그림 상자 안에서 % 로 움직인다. */
        kind: "overlayMove";
        id: string;
        startX: number;
        startY: number;
        start: FigureOverlay;
        hostW: number;
        hostH: number;
        next: FigureOverlay;
      }
    | {
        /** 모서리 손잡이로 크기 바꾸기. sx·sy 는 잡은 귀퉁이(오른쪽/아래가 +1). */
        kind: "resize";
        id: string;
        sx: 1 | -1;
        sy: 1 | -1;
        startX: number;
        startY: number;
        w0: number;
        h0: number;
        /** 덧붙인 그림이 아니면: 폭 % 의 기준(부모 안쪽 폭)과 처음 layout. */
        base?: number;
        layout0?: DiagramLayout;
        inRow?: boolean;
        /** 덧붙인 그림이면: 받침 상자와 처음 자리(px). */
        hostW?: number;
        hostH?: number;
        l0?: number;
        t0?: number;
        nextLayout?: DiagramLayout;
        nextOverlay?: FigureOverlay;
      }
    | null
  >(null);
  /**
   * **끄는 동안에는 React 를 다시 그리지 않는다**(2026-10-09, 사용자 — "그림 덧붙이고 움직일 때 뚝뚝 끊긴다").
   * 예전에는 pointermove 마다 안내선·고른 상자를 state 로 바꿔 컴포넌트 전체가 다시 그려지고, 그때마다 자리 전부의
   * getBoundingClientRect 를 다시 재서(강제 레이아웃) 한 번 움직일 때 레이아웃이 여러 번 돌았다. 지금은
   *  · 안내선·고른 상자를 ref 로 잡고 style 만 바꾸고,
   *  · 자리 높이는 끌기 시작할 때 한 번만 재 두고(`anchorCacheRef`, 카드 기준 좌표라 스크롤해도 맞다),
   *  · pointermove 는 화면 한 프레임에 한 번만 처리한다(`requestAnimationFrame`).
   */
  const dropLineRef = useRef<HTMLDivElement>(null);
  const selBoxRef = useRef<HTMLDivElement>(null);
  const anchorCacheRef = useRef<{ slot: number; y: number }[] | null>(null);
  function showDropLine(top: number | null) {
    const el = dropLineRef.current;
    if (!el) return;
    el.style.display = top === null ? "none" : "block";
    if (top !== null) el.style.top = `${top}px`;
  }

  /**
   * 그림·표가 아닌 자식들. 문서 순서가 곧 구조 순서다.
   * 나란히 놓기용 껍데기(problem-figure-row)도 본문이 아니므로 함께 뺀다.
   */
  function realChildren(el: Element): HTMLElement[] {
    return Array.from(el.children).filter(
      (c): c is HTMLElement =>
        c instanceof HTMLElement &&
        !c.classList.contains("problem-figure") &&
        !c.classList.contains("problem-figure-row"),
    );
  }

  /**
   * 각 자리가 화면 세로 어디쯤인지. cardHtml을 만들 때와 **똑같은 순서로**
   * DOM을 훑어야 자리 번호가 어긋나지 않는다.
   */
  function anchorPoints(): { slot: number; y: number }[] {
    const c = contentRef.current;
    if (!c) return [];
    const out: { slot: number; y: number }[] = [];
    const blockEls = realChildren(c);
    let slot = 0;
    for (const el of blockEls) {
      out.push({ slot: slot++, y: el.getBoundingClientRect().top });
      if (el.classList.contains("mmd-box")) {
        const lineEls = realChildren(el);
        for (const lineEl of lineEls) {
          out.push({ slot: slot++, y: lineEl.getBoundingClientRect().top });
        }
        const last = lineEls[lineEls.length - 1];
        out.push({
          slot: slot++,
          y: (last ?? el).getBoundingClientRect().bottom,
        });
      }
    }
    const lastBlock = blockEls[blockEls.length - 1];
    out.push({ slot, y: lastBlock ? lastBlock.getBoundingClientRect().bottom : 0 });
    return out;
  }

  /** 자리 높이를 카드 좌표(축소 배율을 되돌린 값)로. 끌기 시작할 때 한 번만 잰다. */
  function cardAnchorPoints(): { slot: number; y: number }[] {
    const wrap = cardWrapRef.current;
    if (!wrap) return [];
    const top = wrap.getBoundingClientRect().top;
    const s = scaleRef.current || 1;
    return anchorPoints().map((p) => ({ slot: p.slot, y: (p.y - top) / s }));
  }

  /** 손을 놓은 높이에서 가장 가까운 자리. */
  function slotAtY(clientY: number): number {
    const wrap = cardWrapRef.current;
    const points = anchorCacheRef.current ?? cardAnchorPoints();
    if (points.length === 0 || !wrap) return 0;
    clientY = (clientY - wrap.getBoundingClientRect().top) / (scaleRef.current || 1);
    let best = points[0];
    for (const p of points) {
      if (Math.abs(p.y - clientY) < Math.abs(best.y - clientY)) best = p;
    }
    return best.slot;
  }

  function dropLineFor(slot: number): number | null {
    const point = (anchorCacheRef.current ?? cardAnchorPoints()).find((p) => p.slot === slot);
    return point ? point.y : null;
  }

  /** 지금 화면에 있는 그 요소. 카드가 다시 그려져도 id로 찾으면 늘 최신이다. */
  function figureEl(id: string): HTMLElement | null {
    return (
      contentRef.current?.querySelector<HTMLElement>(
        `[data-fig-id="${CSS.escape(id)}"]`,
      ) ?? null
    );
  }

  function setDragging(v: boolean) {
    if (draggingRef) draggingRef.current = v;
  }

  /** 고른 그림의 상자를 다시 잰다(카드 좌표 — 화면 좌표를 배율로 나눈다). */
  const measureSel = useCallback(() => {
    const wrap = cardWrapRef.current;
    const id = selectedRef.current;
    const el = id ? figureEl(id) : null;
    if (!wrap || !el) {
      setSelBox(null);
      return;
    }
    const s = scaleRef.current || 1;
    const w = wrap.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const box = { left: (r.left - w.left) / s, top: (r.top - w.top) / s, width: r.width / s, height: r.height / s };
    // 끄는 중이면 state 를 안 건드리고 상자 style 만 바꾼다(다시 그리기 없음).
    const sel = selBoxRef.current;
    if (dragRef.current && sel) {
      sel.style.left = `${box.left}px`;
      sel.style.top = `${box.top}px`;
      sel.style.width = `${box.width}px`;
      sel.style.height = `${box.height}px`;
      return;
    }
    setSelBox(box);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  // 카드가 다시 그려지거나(값이 바뀜) 고른 것·배율이 바뀌면 상자를 다시 잰다.
  useLayoutEffect(() => {
    selectedRef.current = selected;
    if (!editMode) setSelBox(null);
    else measureSel();
  }, [cardHtml, selected, editMode, scaleTick, measureSel]);
  // 고른 그림이 없어졌으면(지웠다) 고르기를 푼다.
  useEffect(() => {
    if (selected && !figures.some((f) => f.id === selected)) setSelected(null);
  }, [figures, selected]);

  function startListening() {
    window.addEventListener("pointermove", winMove);
    window.addEventListener("pointerup", winUp);
    window.addEventListener("pointercancel", winUp);
  }

  function handlePointerDown(e: React.PointerEvent) {
    if (!editMode) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-fig-id]");
    const id = el?.dataset.figId;
    const fig = id ? figureOf(id) : undefined;
    if (!el || !id || !fig) {
      setSelected(null);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    setSelected(id);
    selectedRef.current = id;
    const host = fig.overlay ? el.parentElement?.closest<HTMLElement>("[data-fig-id]") : null;
    if (fig.overlay && host) {
      dragRef.current = {
        kind: "overlayMove",
        id,
        startX: e.clientX,
        startY: e.clientY,
        start: fig.overlay,
        hostW: host.offsetWidth || 1,
        hostH: host.offsetHeight || 1,
        next: fig.overlay,
      };
      setDragging(true);
      startListening();
      return;
    }
    const last = anchors.length - 1;
    const slot = Math.min(Math.max(fig.position, 0), last);
    dragRef.current = {
      kind: "move",
      id,
      startX: e.clientX,
      startOffsetX: fig.layout.offsetX,
      slot,
    };
    setDragging(true);
    anchorCacheRef.current = cardAnchorPoints();
    showDropLine(dropLineFor(slot));
    startListening();
  }

  /** 모서리 손잡이를 잡았다. */
  function handleResizeDown(e: React.PointerEvent, sx: 1 | -1, sy: 1 | -1) {
    const id = selectedRef.current;
    const fig = id ? figureOf(id) : undefined;
    const el = id ? figureEl(id) : null;
    if (!id || !fig || !el) return;
    e.preventDefault();
    e.stopPropagation();
    const base = {
      kind: "resize" as const,
      id,
      sx,
      sy,
      startX: e.clientX,
      startY: e.clientY,
      w0: el.offsetWidth || 1,
      h0: el.offsetHeight || 1,
    };
    const host = fig.overlay ? el.parentElement?.closest<HTMLElement>("[data-fig-id]") : null;
    if (fig.overlay && host) {
      const hostW = host.offsetWidth || 1;
      const hostH = host.offsetHeight || 1;
      dragRef.current = {
        ...base,
        hostW,
        hostH,
        l0: (fig.overlay.x / 100) * hostW,
        t0: (fig.overlay.y / 100) * hostH,
        nextOverlay: fig.overlay,
      };
    } else {
      const parent = el.parentElement;
      const inRow = parent?.classList.contains("problem-figure-row") ?? false;
      let inner = parent?.clientWidth ?? el.offsetWidth;
      if (parent) {
        const cs = getComputedStyle(parent);
        inner -= (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      }
      dragRef.current = { ...base, base: Math.max(1, inner), layout0: fig.layout, inRow, nextLayout: fig.layout };
    }
    setDragging(true);
    startListening();
  }

  function handleDragMove(e: PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const s = scaleRef.current || 1;
    const dx = (e.clientX - drag.startX) / s;
    const dy = (e.clientY - ("startY" in drag ? drag.startY : 0)) / s;
    const el = figureEl(drag.id);

    if (drag.kind === "overlayMove") {
      const next: FigureOverlay = {
        ...drag.start,
        x: round1(clampNum(drag.start.x + (dx / drag.hostW) * 100, -50, 100)),
        y: round1(clampNum(drag.start.y + (dy / drag.hostH) * 100, -50, 100)),
      };
      drag.next = next;
      if (el) {
        el.style.left = `${next.x}%`;
        el.style.top = `${next.y}%`;
      }
      measureSel();
      return;
    }

    if (drag.kind === "resize") {
      const aspect = drag.w0 / drag.h0;
      // 잡은 귀퉁이 쪽으로 더 많이 움직인 방향을 따른다(비율은 그림이 지킨다).
      const gx = drag.sx * dx;
      const gy = drag.sy * dy * aspect;
      const g = Math.abs(gx) >= Math.abs(gy) ? gx : gy;
      if (drag.hostW !== undefined && drag.hostH !== undefined && drag.l0 !== undefined && drag.t0 !== undefined) {
        const w = clampNum(drag.w0 + g, drag.hostW * 0.05, drag.hostW * 1.5);
        const h = w / aspect;
        const left = drag.sx > 0 ? drag.l0 : drag.l0 + drag.w0 - w;
        const top = drag.sy > 0 ? drag.t0 : drag.t0 + drag.h0 - h;
        const next: FigureOverlay = {
          ...(figureOf(drag.id)?.overlay as FigureOverlay),
          x: round1((left / drag.hostW) * 100),
          y: round1((top / drag.hostH) * 100),
          w: round1((w / drag.hostW) * 100),
        };
        drag.nextOverlay = next;
        if (el) {
          el.style.left = `${next.x}%`;
          el.style.top = `${next.y}%`;
          el.style.width = `${next.w}%`;
        }
      } else if (drag.base !== undefined && drag.layout0) {
        const w = clampNum(drag.w0 + g, drag.base * 0.1, drag.base);
        const scale = round1((w / drag.base) * 100);
        // 잡은 귀퉁이의 **반대쪽 변이 제자리에** 있게 좌우 값을 함께 민다(사진 자를 때처럼).
        // 나란히 놓인 것은 좌우 값이 "가로 순서"라 건드리지 않는다.
        const offsetX = drag.inRow
          ? drag.layout0.offsetX
          : clampNum(drag.layout0.offsetX + (drag.sx * (w - drag.w0)) / 2, -300, 300);
        const next: DiagramLayout = { ...drag.layout0, scale, offsetX };
        drag.nextLayout = next;
        if (el) {
          if (drag.inRow) el.style.flex = `0 1 ${scale}%`;
          else {
            el.style.width = `${scale}%`;
            el.style.marginLeft = `calc(${(100 - scale) / 2}% + ${offsetX}px)`;
          }
        }
      }
      measureSel();
      return;
    }

    // 좌우: 끈 만큼. 화면에서 움직인 거리를 카드 안의 거리로 되돌린다.
    const offsetX = Math.max(-300, Math.min(300, drag.startOffsetX + dx));
    if (el) {
      // 나란히 놓인 것은 폭을 flex가 잡고 있어서 가운데 맞춤용 %를 더하면 안 된다
      // (더하면 손을 대는 순간 옆으로 훌쩍 뛴다). 끈 만큼만 밀어 보여준다.
      const inRow =
        el.parentElement?.classList.contains("problem-figure-row") ?? false;
      const scale = figureOf(drag.id)?.layout.scale ?? 100;
      el.style.marginLeft = inRow
        ? `${offsetX}px`
        : `calc(${(100 - scale) / 2}% + ${offsetX}px)`;
    }

    // 위아래: 놓을 자리를 정하고 안내선을 옮긴다(자리가 바뀔 때만).
    const slot = slotAtY(e.clientY);
    if (slot !== drag.slot) {
      drag.slot = slot;
      showDropLine(dropLineFor(slot));
    }
    measureSel();
  }

  function handleDragEnd(e: PointerEvent) {
    const drag = dragRef.current;
    window.removeEventListener("pointermove", winMove);
    window.removeEventListener("pointerup", winUp);
    window.removeEventListener("pointercancel", winUp);
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    // 아직 그리지 못한 마지막 움직임을 반영하고 끝낸다(손을 뗀 자리와 저장되는 자리가 같게).
    const pending = pendingMoveRef.current;
    pendingMoveRef.current = null;
    if (drag && pending) handleDragMove(pending);
    if (!drag) return;
    dragRef.current = null;
    anchorCacheRef.current = null;
    setDragging(false);
    showDropLine(null);
    measureSel();

    if (drag.kind === "overlayMove") {
      onOverlayChange?.(drag.id, drag.next);
      return;
    }
    if (drag.kind === "resize") {
      if (drag.nextOverlay) onOverlayChange?.(drag.id, drag.nextOverlay);
      else if (drag.nextLayout) onLayoutChange(drag.id, drag.nextLayout);
      return;
    }
    const dx = (e.clientX - drag.startX) / (scaleRef.current || 1);
    // 그냥 누르기만 했으면(고르기) 아무것도 안 바꾼다 — 자리를 다시 써서 저장이 도는 일이 없게.
    const cur = figureOf(drag.id);
    if (Math.abs(dx) < 2 && cur && drag.slot === Math.min(Math.max(cur.position, 0), anchors.length - 1)) return;
    const offsetX = Math.max(-300, Math.min(300, drag.startOffsetX + dx));
    if (cur) onLayoutChange(drag.id, { ...cur.layout, offsetX });
    onPositionChange(drag.id, drag.slot);
  }

  // window에 붙이는 것은 **항상 같은 함수**여야 뗄 수 있다. 실제 동작은 매
  // 렌더마다 새로 만들어지는(=최신 값을 읽는) 함수에 넘긴다.
  const handlers = useRef({ move: handleDragMove, end: handleDragEnd });
  useEffect(() => {
    handlers.current = { move: handleDragMove, end: handleDragEnd };
  });
  const rafRef = useRef<number | null>(null);
  const pendingMoveRef = useRef<PointerEvent | null>(null);
  const winMove = useCallback((e: PointerEvent) => {
    // 스크롤을 막는 건 그 자리에서(나중에 하면 늦다). 실제 처리는 한 프레임에 한 번.
    if (e.cancelable) e.preventDefault();
    pendingMoveRef.current = e;
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const ev = pendingMoveRef.current;
      pendingMoveRef.current = null;
      if (ev) handlers.current.move(ev);
    });
  }, []);
  const winUp = useCallback((e: PointerEvent) => handlers.current.end(e), []);
  // 화면을 떠날 때 붙여둔 게 남지 않게 한다.
  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      window.removeEventListener("pointermove", winMove);
      window.removeEventListener("pointerup", winUp);
      window.removeEventListener("pointercancel", winUp);
    },
    [winMove, winUp],
  );

  const handleSize = 16 / (scaleRef.current || 1);
  const corners: [1 | -1, 1 | -1, string][] = [
    [-1, -1, "nwse-resize"],
    [1, -1, "nesw-resize"],
    [-1, 1, "nesw-resize"],
    [1, 1, "nwse-resize"],
  ];

  return (
    <div>
      {figures.some((f) => f.markup) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 px-2 py-1.5">
          <button
            type="button"
            onClick={() => {
              setEditMode((v) => !v);
              setSelected(null);
            }}
            className={`rounded-md border px-2 py-1 text-[11px] font-medium ${
              editMode
                ? "border-blue-600 bg-blue-600 text-white"
                : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
            }`}
          >
            {editMode ? "조절 끝내기" : "그림 크기·위치 조절"}
          </button>
          <span className="text-[11px] text-slate-500">
            {editMode
              ? "그림을 눌러 고르고 끌어 옮기세요. 파란 모서리를 끌면 크기가 바뀌어요."
              : "버튼을 눌러야 그림을 옮기거나 크기를 바꿀 수 있어요."}
          </span>
        </div>
      )}
      {/* 휴대폰에서도 가로로 밀지 않고 한눈에 보이도록 통째로 축소한다.
          카드 너비는 어떤 기기에서도 같으므로 결과물은 달라지지 않는다. */}
      <ScaledCard width={width} onScaleChange={handleScaleChange}>
        {/* 드래그 안내선·고른 상자를 카드 위에 겹쳐 놓기 위한 껍데기. 이것들은 cardRef
            바깥에 두어야 PNG로 캡처될 때 같이 찍히지 않는다. */}
        <div ref={cardWrapRef} className="relative" style={{ width }}>
          <div ref={cardRef} className={cardClassName} style={{ width }}>
            {/* 본문과 그림·표를 한 덩어리로 만들어 넣는다. React 요소로 따로
                두면 그림을 문단 사이에 놓을 수 없고, 문단마다 감싸는 <div>가
                생겨 ".mmd-paragraph:last-child" 같은 규칙이 어긋나 문단 간격이
                무너진다. */}
            <div
              ref={contentRef}
              className={`font-serif leading-relaxed text-ink ${editMode ? "" : "figures-locked"}`}
              style={{ fontSize: fontSizePx }}
              onPointerDown={handlePointerDown}
              // 그림이 늦게 열리면 상자 높이가 바뀐다 — 손잡이를 다시 맞춘다.
              onLoadCapture={() => editMode && measureSel()}
              dangerouslySetInnerHTML={cardHtmlProp}
            />
          </div>

          {/* 놓으면 여기로 들어간다는 안내선. */}
          <div
            ref={dropLineRef}
            className="pointer-events-none absolute left-2 right-2 z-10 h-0.5 rounded bg-blue-500"
            style={{ display: "none" }}
          />

          {/* 고른 그림의 테두리와 크기 손잡이(사진 자를 때처럼 네 귀퉁이). */}
          {editMode && selBox && (
            <div
              ref={selBoxRef}
              className="pointer-events-none absolute z-20 border-2 border-blue-500"
              style={{
                left: selBox.left,
                top: selBox.top,
                width: selBox.width,
                height: selBox.height,
              }}
            >
              {corners.map(([sx, sy, cursor]) => (
                <div
                  key={`${sx}${sy}`}
                  onPointerDown={(e) => handleResizeDown(e, sx, sy)}
                  className="pointer-events-auto absolute rounded-sm border-2 border-white bg-blue-600 shadow"
                  style={{
                    width: handleSize,
                    height: handleSize,
                    left: sx < 0 ? -handleSize / 2 : undefined,
                    right: sx > 0 ? -handleSize / 2 : undefined,
                    top: sy < 0 ? -handleSize / 2 : undefined,
                    bottom: sy > 0 ? -handleSize / 2 : undefined,
                    cursor,
                    touchAction: "none",
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </ScaledCard>
    </div>
  );
}

function clampNum(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
