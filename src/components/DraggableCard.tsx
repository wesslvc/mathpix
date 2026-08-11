"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildAnchors, buildCardHtml, type CardFigure } from "@/lib/cardHtml";
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
  draggingRef,
}: Props) {
  const contentRef = useRef<HTMLDivElement>(null);
  const cardWrapRef = useRef<HTMLDivElement>(null);
  // 카드가 화면 폭에 맞춰 축소돼 있으면 손가락이 움직인 화면 거리와 카드
  // 안에서의 거리가 다르다. 드래그 계산에서 되돌리려고 배율을 들고 있는다.
  const scaleRef = useRef(1);
  const handleScaleChange = useCallback((s: number) => {
    scaleRef.current = s;
  }, []);

  const anchors = useMemo(() => buildAnchors(blocks), [blocks]);
  const cardHtml = useMemo(
    () => buildCardHtml(blocks, figures),
    [blocks, figures],
  );

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
  const dragRef = useRef<{
    id: string;
    startX: number;
    startOffsetX: number;
    slot: number;
  } | null>(null);
  /** 드래그 중 "여기로 들어갑니다" 선의 위치(px). null이면 드래그 중이 아니다. */
  const [dropLineTop, setDropLineTop] = useState<number | null>(null);

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

  /** 손을 놓은 높이에서 가장 가까운 자리. */
  function slotAtY(clientY: number): number {
    const points = anchorPoints();
    if (points.length === 0) return 0;
    let best = points[0];
    for (const p of points) {
      if (Math.abs(p.y - clientY) < Math.abs(best.y - clientY)) best = p;
    }
    return best.slot;
  }

  function dropLineFor(slot: number): number | null {
    const wrap = cardWrapRef.current;
    if (!wrap) return null;
    const point = anchorPoints().find((p) => p.slot === slot);
    if (!point) return null;
    // getBoundingClientRect는 화면 좌표(축소된 값)라, 안내선을 놓을 카드
    // 좌표계로 되돌리려면 배율로 나눠야 한다.
    const s = scaleRef.current || 1;
    return (point.y - wrap.getBoundingClientRect().top) / s;
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

  function handlePointerDown(e: React.PointerEvent) {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-fig-id]");
    const id = el?.dataset.figId;
    const fig = id ? figureOf(id) : undefined;
    if (!el || !id || !fig) return;
    e.preventDefault();
    const last = anchors.length - 1;
    const slot = Math.min(Math.max(fig.position, 0), last);
    dragRef.current = {
      id,
      startX: e.clientX,
      startOffsetX: fig.layout.offsetX,
      slot,
    };
    setDragging(true);
    setDropLineTop(dropLineFor(slot));
    window.addEventListener("pointermove", winMove);
    window.addEventListener("pointerup", winUp);
    window.addEventListener("pointercancel", winUp);
  }

  function handleDragMove(e: PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    e.preventDefault();

    // 좌우: 끈 만큼. 화면에서 움직인 거리를 카드 안의 거리로 되돌린다.
    const dx = (e.clientX - drag.startX) / (scaleRef.current || 1);
    const offsetX = Math.max(-300, Math.min(300, drag.startOffsetX + dx));
    const el = figureEl(drag.id);
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

    // 위아래: 놓을 자리를 정하고 안내선을 옮긴다.
    drag.slot = slotAtY(e.clientY);
    setDropLineTop(dropLineFor(drag.slot));
  }

  function handleDragEnd(e: PointerEvent) {
    const drag = dragRef.current;
    window.removeEventListener("pointermove", winMove);
    window.removeEventListener("pointerup", winUp);
    window.removeEventListener("pointercancel", winUp);
    if (!drag) return;
    dragRef.current = null;
    setDragging(false);
    setDropLineTop(null);

    const dx = (e.clientX - drag.startX) / (scaleRef.current || 1);
    const offsetX = Math.max(-300, Math.min(300, drag.startOffsetX + dx));
    const cur = figureOf(drag.id);
    if (cur) onLayoutChange(drag.id, { ...cur.layout, offsetX });
    onPositionChange(drag.id, drag.slot);
  }

  // window에 붙이는 것은 **항상 같은 함수**여야 뗄 수 있다. 실제 동작은 매
  // 렌더마다 새로 만들어지는(=최신 값을 읽는) 함수에 넘긴다.
  const handlers = useRef({ move: handleDragMove, end: handleDragEnd });
  useEffect(() => {
    handlers.current = { move: handleDragMove, end: handleDragEnd };
  });
  const winMove = useCallback((e: PointerEvent) => handlers.current.move(e), []);
  const winUp = useCallback((e: PointerEvent) => handlers.current.end(e), []);
  // 화면을 떠날 때 붙여둔 게 남지 않게 한다.
  useEffect(
    () => () => {
      window.removeEventListener("pointermove", winMove);
      window.removeEventListener("pointerup", winUp);
      window.removeEventListener("pointercancel", winUp);
    },
    [winMove, winUp],
  );

  return (
    // 휴대폰에서도 가로로 밀지 않고 한눈에 보이도록 통째로 축소한다.
    // 카드 너비는 어떤 기기에서도 같으므로 결과물은 달라지지 않는다.
    <ScaledCard width={width} onScaleChange={handleScaleChange}>
      {/* 드래그 안내선을 카드 위에 겹쳐 놓기 위한 껍데기. 안내선은 cardRef
          바깥에 두어야 PNG로 캡처될 때 같이 찍히지 않는다. */}
      <div ref={cardWrapRef} className="relative" style={{ width }}>
        <div ref={cardRef} className={cardClassName} style={{ width }}>
          {/* 본문과 그림·표를 한 덩어리로 만들어 넣는다. React 요소로 따로
              두면 그림을 문단 사이에 놓을 수 없고, 문단마다 감싸는 <div>가
              생겨 ".mmd-paragraph:last-child" 같은 규칙이 어긋나 문단 간격이
              무너진다. */}
          <div
            ref={contentRef}
            className="font-serif leading-relaxed text-ink"
            style={{ fontSize: fontSizePx }}
            onPointerDown={handlePointerDown}
            dangerouslySetInnerHTML={{ __html: cardHtml }}
          />
        </div>

        {/* 놓으면 여기로 들어간다는 안내선. */}
        {dropLineTop !== null && (
          <div
            className="pointer-events-none absolute left-2 right-2 z-10 h-0.5 rounded bg-blue-500"
            style={{ top: dropLineTop }}
          />
        )}
      </div>
    </ScaledCard>
  );
}
