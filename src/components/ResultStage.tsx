"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toPng } from "html-to-image";
import {
  blockToHtml,
  renderMathTextWithInfo,
  type BoxOverride,
} from "@/lib/renderMathText";
import type { RecognizeResponse } from "@/lib/types";
import { PROBLEM_CARD_WIDTH } from "@/lib/layout";
import FigurePanel from "./FigurePanel";
import ScaledCard from "./ScaledCard";
import { useFigureJobs } from "./FigureJobsProvider";
import { buildAnchors, buildCardHtml } from "@/lib/cardHtml";
import {
  prepareFigureForModel,
  rasterToSvg,
  trimBlankBorder,
} from "@/lib/figureImage";
import {
  figureCacheKey,
  readFigureCache,
  writeFigureCache,
} from "@/lib/figureCache";
import type { Subject } from "@/lib/subject";
import type { TokenStatus } from "@/app/api/tokens/route";
import BoxRangeEditor from "./BoxRangeEditor";
import TextEditTabs from "./TextEditTabs";
import DiagramAdjuster, {
  DEFAULT_DIAGRAM_LAYOUT,
  diagramStyleCss,
  type DiagramLayout,
} from "./DiagramAdjuster";
import type { AnswerType } from "@/lib/answer";
import AnswerInput from "./AnswerInput";

type Props = {
  result: RecognizeResponse;
  onBack: () => void;
  onRestart: () => void;
  /** 지정하면 "오답으로 저장" 버튼이 나타나고, PNG data URL과 정답 정보를 인자로 호출된다. */
  onSaveToCategory?: (payload: {
    pngDataUrl: string;
    /** 사용자가 손본 최종 본문(mmd). 저장되는 텍스트는 이 값이다. */
    text: string;
    answer: string;
    answerType: AnswerType;
    boxOverride: BoxOverride | undefined;
    /** 이미 저장한 문제면 그 id. 새로 만들지 않고 갱신한다. */
    problemId?: string | null;
  }) => Promise<string>;
  /** 복수 업로드 시 아직 처리하지 않은 이미지 수. */
  remainingCount?: number;
  /** 다음 대기 이미지로 넘어간다. */
  onNext?: () => void;
  /**
   * 저장 후 곧바로 새 사진을 올릴 수 있게 업로드 화면으로 보낸다.
   * 여러 문제를 연달아 넣을 때 목록으로 돌아갔다 다시 들어오는 왕복을 없앤다.
   */
  onAddAnother?: () => void;
  /** Mathpix에 보낸 원본(크롭된) 이미지. 도형 영역을 오려내는 데 쓴다. */
  sourceImage?: string | null;
  /**
   * 과목 모드. 그림을 다루는 도구만 이 값에 따라 갈린다 —
   * 그림을 다시 그리는 도구는 같고 프롬프트와 화면 문구만 갈린다.
   */
  subject?: Subject;
};

/**
 * 카드에 붙은 그림 하나.
 *
 * svg는 **항상 유효한 마크업**이다. AI로 다시 그리기를 골라도 처음에는 오려낸
 * 원본이 들어가 있고, 완성되면 그 자리를 갈아끼운다. 덕분에 처리가 끝나기 전에
 * 저장해도 빈 자리가 아니라 원본이 든 멀쩡한 이미지가 저장된다.
 */
type ManualFigure = {
  id: string;
  svg: string;
  kind: "math" | "figure";
};

const FONT_SIZES = [
  { label: "보통", px: 20 },
  { label: "크게", px: 24 },
  { label: "아주 크게", px: 30 },
] as const;

// 정답 입력이 멎고 이만큼 지나면 자동 저장한다. 너무 짧으면 아직 타는 중에
// 저장되고, 너무 길면 자동 저장을 기다리다 답답하다.
const AUTO_SAVE_SEC = 1;

export default function ResultStage({
  result,
  onBack,
  onRestart,
  onSaveToCategory,
  remainingCount = 0,
  onNext,
  onAddAnother,
  sourceImage,
  subject = "math",
}: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [fontSizeIdx, setFontSizeIdx] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [textCopied, setTextCopied] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 저장된 문제의 id. null이면 아직 저장 전이다. 저장 후에도 계속 고칠 수
  // 있어야 해서 boolean이 아니라 id를 들고 있는다 — 다시 저장하면 새 문제를
  // 만드는 게 아니라 이 행을 갱신한다.
  const [savedId, setSavedId] = useState<string | null>(null);
  // 마지막 저장 이후 바뀐 게 있는지. 있으면 다시 저장할 거리가 있다는 뜻.
  const [dirty, setDirty] = useState(false);
  const [answer, setAnswer] = useState("");
  // 객관식이면 정답표에 "1" 대신 "①"로 표기한다.
  const [answerType, setAnswerType] = useState<AnswerType>("choice");
  // 조건 박스 범위. undefined면 자동 감지에 맡긴다.
  const [boxOverride, setBoxOverride] = useState<BoxOverride | undefined>(undefined);
  const [showBoxEditor, setShowBoxEditor] = useState(false);
  // 도형별 크기·위치. 키는 raster는 도형 id, 수동 SVG는 "svg:<index>".
  const [layouts, setLayouts] = useState<Record<string, DiagramLayout>>({});

  function layoutOf(key: string): DiagramLayout {
    return layouts[key] ?? DEFAULT_DIAGRAM_LAYOUT;
  }
  function setLayout(key: string, next: DiagramLayout) {
    setLayouts((prev) => ({ ...prev, [key]: next }));
  }
  // Mathpix가 자동 감지한 도형 영역을 원본에서 그대로 오려낸 raster 이미지들
  // (도형 id -> data URL). 무료·자동, AI 재구성과는 별개다.
  const [rasterFallbacks, setRasterFallbacks] = useState<Record<string, string>>({});
  // 사람이 직접 오려내 붙인 그림들. 원본 그대로일 수도, AI가 다시 그린
  // 것일 수도 있다(문제당 여러 개 가능).
  // 크기·위치 설정을 도형별로 따로 들고 있어야 해서 배열 인덱스가 아니라 고정
  // id를 쓴다(인덱스로 키를 잡으면 하나를 지웠을 때 뒤 도형들의 설정이 한 칸씩
  // 밀려 엉뚱한 도형에 적용된다).
  // kind는 조절 목록에 붙는 이름에만 쓴다(수학 도형인지 사과탐 자료인지).
  // 붙는 방식·저장 경로는 둘이 완전히 같다.
  const [manualDiagramSvgs, setManualDiagramSvgs] = useState<ManualFigure[]>([]);

  // AI 그림 작업은 이 화면 바깥(FigureJobsProvider)에서 돈다. 작업이 도는 동안
  // 다음 문제로 넘어가도 계속되어야 하기 때문이다.
  const { jobs, enqueue, retry, putSnapshot } = useFigureJobs();
  /** 이 문제를 가리키는 키. 결과가 바뀔 때마다(=다음 이미지) 새로 만든다. */
  const problemKey = useMemo(() => crypto.randomUUID(), [result]);
  const problemLabel = useMemo(() => {
    const first = (result.text || result.latex || "").trim().split("\n")[0];
    return first.slice(0, 20) || "문제";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);
  const jobOf = (figureId: string) => jobs.find((j) => j.id === figureId);
  /** 남은 토큰과 기능별 소모량. null이면 아직 못 불러온 상태. */
  const [tokenStatus, setTokenStatus] = useState<TokenStatus | null>(null);

  // 남은 토큰을 불러온다. 그림 기능은 원본 사진이 없어도 카메라로 새로 찍어
  // 쓸 수 있으므로 항상 보여주고, 한 번 쓰고 나면 다시 불러 잔량을 갱신한다.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/tokens")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setTokenStatus(data as TokenStatus);
      })
      .catch(() => {
        // 잔량을 못 불러와도 버튼은 눌러볼 수 있게 둔다(서버가 최종 판단한다).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshTokens() {
    try {
      const res = await fetch("/api/tokens");
      if (res.ok) setTokenStatus((await res.json()) as TokenStatus);
    } catch {
      // 갱신 실패는 무시 — 다음 렌더에서 다시 시도된다.
    }
  }

  // 인식 결과를 그 자리에서 고칠 수 있게 한다. 저장 후 갤러리에서 다시 여는
  // 왕복 없이, 잘못 읽힌 수식을 보면서 바로 손보는 게 훨씬 빠르다.
  const [sourceText, setSourceText] = useState(result.text || result.latex);
  const [showTextEditor, setShowTextEditor] = useState(false);

  // 다음 이미지로 넘어가면 새 인식 결과로 갈아끼운다.
  useEffect(() => {
    setSourceText(result.text || result.latex);
    setShowTextEditor(false);
    setBoxOverride(undefined);
  }, [result]);

  // blocks는 최상위 요소(문단/조건 박스/표) 하나씩이다. 도형·자료를 그 사이에
  // 끼워 넣기 위해 경계가 필요하다.
  const { blocks } = useMemo(
    () => renderMathTextWithInfo(sourceText, boxOverride),
    [sourceText, boxOverride],
  );

  /**
   * 그림을 놓을 수 있는 자리들. 위에서부터 순서대로다.
   *
   * 문단 사이뿐 아니라 **조건 박스·보기 박스 안의 줄 사이**도 자리가 된다.
   * 문제집에서는 자료가 박스 안에 들어가는 경우가 흔한데, 예전에는 박스가
   * 통짜라 그 안에 넣을 방법이 없었다.
   *
   * line이 null이면 그 블록 **앞**(박스라면 테두리 바깥), 숫자면 그 박스 안의
   * 몇 번째 줄 앞이다(lines.length면 박스 안 맨 끝).
   */
  const anchors = useMemo(() => buildAnchors(blocks), [blocks]);

  // 도형·자료를 어느 자리에 놓을지(anchors의 인덱스). 지정하지 않으면 맨 아래.
  const [figurePos, setFigurePos] = useState<Record<string, number>>({});

  function positionOf(id: string): number {
    // 본문을 고치면 자리 개수가 달라지므로 항상 현재 범위로 가둔다.
    const last = anchors.length - 1;
    return Math.min(Math.max(figurePos[id] ?? last, 0), last);
  }

  /**
   * 카드에 그릴 것들을 위에서부터 순서대로 늘어놓는다. Mathpix가 자동으로
   * 잡아낸 원본 크롭이 먼저, 사람이 추가한 것이 뒤에 온다.
   */
  const figures = useMemo(
    () => [
      ...(result.diagrams ?? [])
        .filter((d) => rasterFallbacks[d.id])
        .map((d) => ({
          id: d.id,
          markup: `<img src="${rasterFallbacks[d.id]}" alt="" />`,
        })),
      ...manualDiagramSvgs.map((d) => ({ id: d.id, markup: d.svg })),
    ]
      // 마크업이 비어 있으면 카드에 끼워 넣지 않는다. 문자열 조립이라 undefined가
      // 하나만 섞여도 "undefined"라는 글자가 그대로 문제에 인쇄돼 버린다.
      .filter((f) => typeof f.markup === "string" && f.markup.length > 0),
    [result.diagrams, rasterFallbacks, manualDiagramSvgs],
  );

  /** 자리 고르는 목록에 보여줄 이름. 근처 글자를 붙여 어디인지 알아보게 한다. */
  const slotLabels = useMemo(() => {
    const preview = (html: string): string => {
      if (typeof document === "undefined") return "";
      const el = document.createElement("div");
      el.innerHTML = html;
      // KaTeX는 같은 수식을 MathML로도 함께 내보내서, 그냥 textContent를 읽으면
      // 수식이 두 번 나온다. 화면에 안 보이는 쪽을 떼고 읽는다.
      el.querySelectorAll(".katex-mathml").forEach((n) => n.remove());
      return (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 12);
    };

    return anchors.map((a, i) => {
      if (i === 0) return "맨 위";
      if (i === anchors.length - 1) return "맨 아래";

      const block = blocks[a.block];
      if (a.line === null) {
        // 이 블록 앞 = 바로 앞 블록의 뒤.
        const prev = blocks[a.block - 1];
        const text = prev ? preview(blockToHtml(prev)) : "";
        return text ? `${a.block}번째 문단 뒤 · ${text}…` : `${a.block}번째 문단 뒤`;
      }
      if (block?.kind !== "box") return "박스 안";
      if (a.line >= block.lines.length) return "박스 안 · 맨 끝";
      const text = preview(block.lines[a.line]);
      return text ? `박스 안 · ${text}… 앞` : `박스 안 · ${a.line + 1}번째 줄 앞`;
    });
  }, [anchors, blocks]);

  // ── 손으로 끌어 옮기기 ────────────────────────────────────────────────
  // 미리보기의 그림을 그대로 잡아 끌면 좌우로 움직이고, 놓는 높이에 따라
  // 어느 문단 사이로 들어갈지 정해진다.
  //
  // 끄는 동안에는 React state를 건드리지 않고 DOM 스타일만 직접 바꾼다.
  // 본문은 dangerouslySetInnerHTML 한 덩어리라, state가 바뀌어 문자열이
  // 달라지면 React가 innerHTML을 통째로 갈아치우고 — 그러면 지금 잡고 있는
  // 그 요소가 사라져서 포인터 캡처가 끊기고 드래그가 중간에 죽는다.
  // 최종 위치는 손을 뗄 때 한 번만 state에 반영한다.
  const contentRef = useRef<HTMLDivElement>(null);
  const cardWrapRef = useRef<HTMLDivElement>(null);
  // 카드가 화면 폭에 맞춰 축소돼 있으면 손가락이 움직인 화면 거리와 카드
  // 안에서의 거리가 다르다. 드래그 계산에서 되돌리려고 배율을 들고 있는다.
  const scaleRef = useRef(1);
  const handleScaleChange = useCallback((s: number) => {
    scaleRef.current = s;
  }, []);
  const dragRef = useRef<{
    id: string;
    el: HTMLElement;
    startX: number;
    startOffsetX: number;
    slot: number;
  } | null>(null);
  /** 드래그 중 "여기로 들어갑니다" 선의 위치(px). null이면 드래그 중이 아니다. */
  const [dropLineTop, setDropLineTop] = useState<number | null>(null);

  /** 그림이 아닌 자식들. 문서 순서가 곧 구조 순서다. */
  function realChildren(el: Element): HTMLElement[] {
    return Array.from(el.children).filter(
      (c): c is HTMLElement =>
        c instanceof HTMLElement && !c.classList.contains("problem-figure"),
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
      const r = el.getBoundingClientRect();
      out.push({ slot: slot++, y: r.top });
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

  function handleFigurePointerDown(e: React.PointerEvent) {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-fig-id]");
    const id = el?.dataset.figId;
    if (!el || !id) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const slot = positionOf(id);
    dragRef.current = {
      id,
      el,
      startX: e.clientX,
      startOffsetX: layoutOf(id).offsetX,
      slot,
    };
    setDropLineTop(dropLineFor(slot));
  }

  function handleFigurePointerMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    e.preventDefault();

    // 좌우: 끈 만큼. 화면에서 움직인 거리를 카드 안의 거리로 되돌린다.
    const dx = (e.clientX - drag.startX) / (scaleRef.current || 1);
    const offsetX = Math.max(-300, Math.min(300, drag.startOffsetX + dx));
    const scale = layoutOf(drag.id).scale;
    drag.el.style.marginLeft = `calc(${(100 - scale) / 2}% + ${offsetX}px)`;

    // 위아래: 놓을 자리를 정하고 안내선을 옮긴다.
    drag.slot = slotAtY(e.clientY);
    setDropLineTop(dropLineFor(drag.slot));
  }

  function handleFigurePointerUp(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setDropLineTop(null);
    try {
      drag.el.releasePointerCapture(e.pointerId);
    } catch {
      // 이미 풀렸으면 그만이다.
    }

    const dx = (e.clientX - drag.startX) / (scaleRef.current || 1);
    const offsetX = Math.max(-300, Math.min(300, drag.startOffsetX + dx));
    setLayout(drag.id, { ...layoutOf(drag.id), offsetX });
    setFigurePos((prev) => ({ ...prev, [drag.id]: drag.slot }));
  }

  /** 카드에 붙을 그림들을 위치·크기와 함께 정리한다. 저장·재저장에 그대로 쓴다. */
  const cardFigures = useMemo(
    () =>
      figures.map((f) => ({
        id: f.id,
        markup: f.markup,
        layout: layoutOf(f.id),
        position: positionOf(f.id),
      })),
    // layoutOf/positionOf는 아래 두 state를 읽는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [figures, layouts, figurePos, anchors],
  );

  /** 문단 사이와 박스 안 줄 사이에 그림을 끼워 넣은 최종 카드 HTML. */
  const cardHtml = useMemo(
    () => buildCardHtml(blocks, cardFigures),
    [blocks, cardFigures],
  );

  // 정답을 적고 잠시 가만히 있으면 저장 버튼을 누르지 않아도 저장한다.
  // 글자마다 저장하면 "12"를 치는 동안 "1"로 저장되므로 입력이 멎을 때까지 기다린다.
  // 도형·박스를 더 만지려던 참이면 아래 안내에 남은 시간이 보이고, 취소할 수 있다.
  const [autoSaveLeftSec, setAutoSaveLeftSec] = useState<number | null>(null);
  const [autoSaveOff, setAutoSaveOff] = useState(false);

  useEffect(() => {
    if (!onSaveToCategory || autoSaveOff || isSaving) return;
    // 아직 저장한 적이 있고 바뀐 게 없으면 다시 저장할 이유가 없다.
    if (savedId !== null && !dirty) return;
    if (answer.trim() === "") {
      setAutoSaveLeftSec(null);
      return;
    }

    setAutoSaveLeftSec(AUTO_SAVE_SEC);
    const tick = setInterval(() => {
      setAutoSaveLeftSec((v) => (v === null ? null : Math.max(0, v - 1)));
    }, 1000);
    // setTimeout이 아니라 setInterval인 이유: 그림을 끌고 있는 중이면 저장을
    // 미뤄야 하는데(끄는 동안에는 DOM만 바꿔둔 상태라 지금 캡처하면 어중간한
    // 위치가 이미지로 굳는다), 한 번만 재는 타이머로 건너뛰면 영영 저장되지
    // 않는다. 손을 뗄 때까지 같은 간격으로 다시 확인한다.
    const timer = setInterval(() => {
      if (dragRef.current) return;
      clearInterval(timer);
      setAutoSaveLeftSec(null);
      void handleSaveToCategory();
    }, AUTO_SAVE_SEC * 1000);

    // 정답을 더 고치면 타이머를 처음부터 다시 센다.
    return () => {
      clearInterval(tick);
      clearInterval(timer);
    };
    // handleSaveToCategory는 매 렌더 새로 만들어지므로 의존성에 넣지 않는다
    // (넣으면 타이머가 렌더마다 초기화돼 영영 저장되지 않는다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answer, answerType, autoSaveOff, savedId, dirty, isSaving, onSaveToCategory]);

  // Mathpix가 텍스트로 옮길 수 없는 도형(원, 삼각형 등)을 감지하면 그 영역의
  // 좌표를 함께 알려준다. OCR로는 도형을 재구성할 수 없으니, 보낸 원본
  // 이미지에서 그 영역을 그대로 오려내 결과 카드에 이미지로 붙여넣는다.
  useEffect(() => {
    let cancelled = false;
    setRasterFallbacks({});
    if (!sourceImage || !result.diagrams || result.diagrams.length === 0) {
      return;
    }

    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const crops: Record<string, string> = {};
      for (const d of result.diagrams) {
        const canvas = document.createElement("canvas");
        canvas.width = d.width;
        canvas.height = d.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        ctx.drawImage(
          img,
          d.left,
          d.top,
          d.width,
          d.height,
          0,
          0,
          d.width,
          d.height,
        );
        crops[d.id] = canvas.toDataURL("image/png");
      }
      setRasterFallbacks(crops);
    };
    img.src = sourceImage;

    return () => {
      cancelled = true;
    };
  }, [sourceImage, result.diagrams]);

  /** 이 문제에서 아직 처리되지 않은 AI 작업 수. 게이지에 쓴다. */
  const pendingJobCount = jobs.filter(
    (j) =>
      j.problemKey === problemKey &&
      (j.status === "pending" || j.status === "running"),
  ).length;

  /**
   * 자리를 잡는다.
   *
   * 오려낸 원본을 곧바로 카드에 붙인다. AI를 쓰기로 했으면 작업만 걸어두고
   * 바로 돌아온다 — 실제 생성은 아래 일꾼이 순서대로 처리한다. 기다리는 동안
   * 사용자는 본문을 고치거나 다음 그림을 오려낼 수 있다.
   */
  async function addFigure(crop: string, useAi: boolean) {
    const id = crypto.randomUUID();
    const svg = await rasterToSvg(crop);
    setManualDiagramSvgs((prev) => [
      ...prev,
      { id, svg, kind: subject === "math" ? "math" : "figure" },
    ]);
    if (useAi) {
      // 큐는 이 화면 바깥(FigureJobsProvider)에 있다. 그래야 다음 문제로
      // 넘어가도 작업이 계속 돈다.
      enqueue({
        id,
        problemKey,
        label: problemLabel,
        subject,
        crop,
      });
    }
  }


  async function handleExport() {
    if (!cardRef.current) return;
    setIsExporting(true);
    try {
      const dataUrl = await toPng(cardRef.current, {
        pixelRatio: 2,
        backgroundColor: "#ffffff",
      });
      const link = document.createElement("a");
      link.download = "problem.png";
      link.href = dataUrl;
      link.click();
    } finally {
      setIsExporting(false);
    }
  }

  // 뒤에서 돌던 AI 작업이 끝나면 그 자리를 완성된 그림으로 갈아끼운다.
  // 화면이 열려 있는 동안은 여기서 반영되고, dirty로 표시돼 자동으로 다시
  // 저장된다. 화면이 닫혀 있으면 Provider가 저장본을 직접 갱신한다.
  useEffect(() => {
    const done = jobs.filter((j) => j.status === "done" && j.svg);
    if (done.length === 0) return;
    setManualDiagramSvgs((prev) => {
      let changed = false;
      const next = prev.map((f) => {
        const j = done.find((d) => d.id === f.id);
        if (!j?.svg || j.svg === f.svg) return f;
        changed = true;
        return { ...f, svg: j.svg };
      });
      return changed ? next : prev;
    });
  }, [jobs]);

  // 이 문제의 최신 상태를 큐에 계속 알려둔다. 화면을 떠난 뒤 작업이 끝나면
  // Provider가 이 값만으로 카드를 다시 그려 저장본을 갱신한다.
  useEffect(() => {
    putSnapshot(problemKey, {
      problemId: savedId,
      spec: {
        text: sourceText,
        boxOverride,
        fontSizePx: FONT_SIZES[fontSizeIdx].px,
        figures: cardFigures,
      },
    });
  }, [
    putSnapshot,
    problemKey,
    savedId,
    sourceText,
    boxOverride,
    fontSizeIdx,
    cardFigures,
  ]);

  // 저장한 뒤에 무엇이든 바뀌면 "다시 저장할 거리가 있다"고 표시한다.
  // AI가 그림을 완성해 자리를 갈아끼우는 것도 여기에 걸려서, 처리가 끝나면
  // 완성된 그림으로 자동으로 다시 저장된다.
  useEffect(() => {
    if (savedId !== null) setDirty(true);
    // savedId는 일부러 뺀다 — 저장 직후에 곧바로 dirty가 되면 안 된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sourceText,
    answer,
    answerType,
    boxOverride,
    manualDiagramSvgs,
    layouts,
    figurePos,
    fontSizeIdx,
  ]);

  async function handleSaveToCategory() {
    if (!cardRef.current || !onSaveToCategory) return;
    // 자동 저장과 버튼이 겹쳐 동시에 두 번 저장되는 것만 막는다. 이미 저장한
    // 문제를 다시 저장하는 건 막지 않는다 — 그건 "고쳐서 다시 저장"이고,
    // 같은 행을 갱신하므로 문제가 두 개 생기지 않는다.
    if (isSaving) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      const dataUrl = await toPng(cardRef.current, {
        pixelRatio: 2,
        backgroundColor: "#ffffff",
      });
      const id = await onSaveToCategory({
        pngDataUrl: dataUrl,
        text: sourceText,
        answer: answer.trim(),
        answerType,
        boxOverride,
        problemId: savedId,
      });
      setSavedId(id);
      setDirty(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "저장에 실패했습니다.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleCopyLatex() {
    await navigator.clipboard.writeText(result.latex);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  /** 렌더링에 실제로 쓰인 원문(mmd)을 복사한다. 줄바꿈/박스 등 렌더링 문제를
   * 알려줄 때 이 텍스트가 필요하다. */
  async function handleCopyText() {
    await navigator.clipboard.writeText(sourceText);
    setTextCopied(true);
    setTimeout(() => setTextCopied(false), 1500);
  }

  return (
    <div className="flex flex-col gap-4">
      {result.mock && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Mathpix API 키가 설정되어 있지 않아 예시(mock) 결과를 표시하고
          있습니다. <code>.env.local</code>에 <code>MATHPIX_APP_ID</code>,{" "}
          <code>MATHPIX_APP_KEY</code>를 설정하면 실제 인식 결과가
          표시됩니다.
        </div>
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-ink">인식 결과</h2>
        <div className="flex items-center gap-1 rounded-lg border border-slate-300 p-1">
          {FONT_SIZES.map((f, idx) => (
            <button
              key={f.label}
              type="button"
              onClick={() => setFontSizeIdx(idx)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                idx === fontSizeIdx
                  ? "bg-blue-600 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* 휴대폰에서도 가로로 밀지 않고 한눈에 보이도록 통째로 축소한다.
          카드 너비는 어떤 기기에서도 같으므로 결과물은 달라지지 않는다. */}
      <ScaledCard width={PROBLEM_CARD_WIDTH} onScaleChange={handleScaleChange}>
        {/* 드래그 안내선을 카드 위에 겹쳐 놓기 위한 껍데기. 안내선은 cardRef
            바깥에 두어야 PNG로 캡처될 때 같이 찍히지 않는다. */}
        <div
          ref={cardWrapRef}
          className="relative"
          style={{ width: PROBLEM_CARD_WIDTH }}
        >
          <div
            ref={cardRef}
            className="problem-surface rounded-2xl border border-slate-200 bg-white p-8 shadow-sm"
            style={{ width: PROBLEM_CARD_WIDTH }}
          >
            {/* 본문과 도형·자료를 한 덩어리로 만들어 넣는다. React 요소로 따로
                두면 도형을 문단 사이에 놓을 수 없고, 문단마다 감싸는 <div>가
                생겨 ".mmd-paragraph:last-child" 같은 규칙이 어긋나 문단 간격이
                무너진다. */}
            <div
              ref={contentRef}
              className="font-serif leading-relaxed text-ink"
              style={{ fontSize: FONT_SIZES[fontSizeIdx].px }}
              onPointerDown={handleFigurePointerDown}
              onPointerMove={handleFigurePointerMove}
              onPointerUp={handleFigurePointerUp}
              onPointerCancel={handleFigurePointerUp}
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

      {/* 인식 결과를 바로 고친다. 저장 후 갤러리에서 다시 여는 왕복을 없앤다. */}
      <div className="rounded-lg border border-slate-200 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setShowTextEditor((v) => !v)}
          className="flex w-full items-center justify-between text-xs font-medium text-slate-600"
        >
          <span>
            내용 수정
            {sourceText !== (result.text || result.latex) && (
              <span className="ml-1 font-normal text-blue-600">(수정됨)</span>
            )}
          </span>
          <span className="text-slate-400">
            {showTextEditor ? "닫기 ▲" : "열기 ▼"}
          </span>
        </button>
        {showTextEditor && (
          <div className="mt-2 flex flex-col gap-2">
            <TextEditTabs value={sourceText} onChange={setSourceText} />
            <button
              type="button"
              onClick={() => setSourceText(result.text || result.latex)}
              disabled={sourceText === (result.text || result.latex)}
              className="self-start rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100 disabled:opacity-40"
            >
              인식 결과로 되돌리기
            </button>
          </div>
        )}
      </div>

      {/* 조건 박스 범위 조절 — 자동 감지가 어긋났을 때 손으로 고친다. */}
      <div className="rounded-lg border border-slate-200 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setShowBoxEditor((v) => !v)}
          className="flex w-full items-center justify-between text-xs font-medium text-slate-600"
        >
          <span>
            조건 박스 조절
            {boxOverride !== undefined && (
              <span className="ml-1 font-normal text-blue-600">(직접 지정함)</span>
            )}
          </span>
          <span className="text-slate-400">{showBoxEditor ? "닫기 ▲" : "열기 ▼"}</span>
        </button>
        {showBoxEditor && (
          <div className="mt-2">
            <BoxRangeEditor
              text={sourceText}
              value={boxOverride}
              onChange={setBoxOverride}
            />
          </div>
        )}
      </div>

      {/* 도형 크기·위치 조절 — 카드에 실제로 붙은 도형이 있을 때만 보여준다. */}
      {(Object.keys(rasterFallbacks).length > 0 ||
        manualDiagramSvgs.length > 0) && (
        <div className="flex flex-col gap-2 rounded-lg border border-slate-200 px-3 py-2.5">
          <p className="text-xs font-medium text-slate-500">
            {subject === "science" ? "자료 크기·위치" : "도형 크기·위치"}
          </p>
          <p className="text-[11px] text-slate-400">
            위 미리보기에서 그림을 손가락(또는 마우스)으로 잡아 끌면 원하는 문단
            사이로 옮길 수 있어요. 파란 선이 들어갈 자리입니다.
          </p>
          {(result.diagrams ?? [])
            .filter((d) => rasterFallbacks[d.id])
            .map((d, i) => (
              <DiagramAdjuster
                key={d.id}
                label={
                  subject === "science"
                    ? `자동 감지 자료 ${i + 1}`
                    : `자동 감지 도형 ${i + 1}`
                }
                layout={layoutOf(d.id)}
                onChange={(next) => setLayout(d.id, next)}
                position={positionOf(d.id)}
                slotLabels={slotLabels}
                onPositionChange={(p) =>
                  setFigurePos((prev) => ({ ...prev, [d.id]: p }))
                }
              />
            ))}
          {manualDiagramSvgs.map((d, idx) => (
            <DiagramAdjuster
              key={d.id}
              label={
                (d.kind === "figure" ? `자료 ${idx + 1}` : `도형 ${idx + 1}`) +
                (jobOf(d.id)?.status === "running"
                  ? " · AI가 그리는 중…"
                  : jobOf(d.id)?.status === "pending"
                    ? " · 차례 기다리는 중"
                    : jobOf(d.id)?.status === "error"
                      ? " · AI 실패(원본 사용 중)"
                      : "")
              }
              note={jobOf(d.id)?.error}
              busy={
                jobOf(d.id)?.status === "running" ||
                jobOf(d.id)?.status === "pending"
              }
              onRetry={
                jobOf(d.id)?.status === "error" ? () => retry(d.id) : undefined
              }
              layout={layoutOf(d.id)}
              onChange={(next) => setLayout(d.id, next)}
              position={positionOf(d.id)}
              slotLabels={slotLabels}
              onPositionChange={(p) =>
                setFigurePos((prev) => ({ ...prev, [d.id]: p }))
              }
              onRemove={() =>
                setManualDiagramSvgs((prev) => prev.filter((p) => p.id !== d.id))
              }
            />
          ))}
        </div>
      )}




      <FigurePanel
        subject={subject}
        imageSrc={sourceImage ?? null}
        status={tokenStatus}
        queuedCount={pendingJobCount}
        onAdd={addFigure}
      />

      {result.confidence !== null && (
        <p className="text-xs text-slate-400">
          인식 신뢰도: {(result.confidence * 100).toFixed(0)}%
        </p>
      )}

      {saveError && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {saveError}
        </div>
      )}

      {onSaveToCategory && (
        <div className="flex flex-col gap-2">
          <AnswerInput
            answer={answer}
            answerType={answerType}
            onChange={(next, type) => {
              setAnswer(next);
              setAnswerType(type);
            }}
            onSubmit={() => void handleSaveToCategory()}
          />
          {savedId === null && (
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              {autoSaveLeftSec !== null ? (
                <>
                  <span className="text-blue-700">
                    {autoSaveLeftSec}초 후 자동으로 저장돼요.
                  </span>
                  <button
                    type="button"
                    onClick={() => setAutoSaveOff(true)}
                    className="rounded border border-slate-300 px-1.5 py-0.5 text-slate-600 hover:bg-slate-100"
                  >
                    자동 저장 끄기
                  </button>
                </>
              ) : (
                <span className="text-slate-400">
                  정답을 입력하면 잠시 뒤 자동 저장돼요.{" "}
                  <kbd className="rounded border border-slate-300 bg-slate-50 px-1">
                    Enter
                  </kbd>
                  를 누르면 바로 저장됩니다.
                  {autoSaveOff && " (자동 저장 꺼짐)"}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* 보조 도구: 저장 결과를 만드는 액션이 아니라 다시 시작/복사 같은
          부가 기능이라 작고 옅은 스타일로 아래 주요 액션과 구분한다. */}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <button
          type="button"
          onClick={onRestart}
          className="text-xs text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
        >
          새 이미지로 시작
        </button>
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
        >
          크롭 다시하기
        </button>
        <button
          type="button"
          onClick={handleCopyLatex}
          className="text-xs text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
        >
          {copied ? "복사됨!" : "LaTeX 복사"}
        </button>
        <button
          type="button"
          onClick={handleCopyText}
          className="text-xs text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
        >
          {textCopied ? "복사됨!" : "텍스트 복사"}
        </button>
      </div>

      {/* 저장이 끝나면 "다음 문제"를 가장 크게 띄운다 — 여러 개를 연달아 넣는
          것이 이 화면의 기본 사용 패턴이라, 목록으로 돌아갔다 다시 들어오는
          왕복을 없앤다. */}
      {savedId !== null && (onAddAnother || (onNext && remainingCount > 0)) && (
        <div className="flex flex-col gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm font-medium text-emerald-900">
            저장했어요. 이어서 추가할까요?
          </p>
          <div className="flex flex-wrap gap-2">
            {onNext && remainingCount > 0 ? (
              <button
                type="button"
                onClick={onNext}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
              >
                다음 이미지 → ({remainingCount}장 남음)
              </button>
            ) : (
              onAddAnother && (
                <button
                  type="button"
                  onClick={onAddAnother}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
                >
                  + 다음 문제 추가
                </button>
              )
            )}
          </div>
        </div>
      )}

      {/* 주요 액션: 결과를 실제로 저장/출력하는 버튼만 모아 눈에 띄게 둔다. */}
      <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3">
        {onNext && remainingCount > 0 && (
          <button
            type="button"
            onClick={onNext}
            className="g-btn g-btn-primary"
          >
            다음 이미지 → ({remainingCount}장 남음)
          </button>
        )}
        <button
          type="button"
          onClick={handleExport}
          disabled={isExporting}
          className="g-btn g-btn-outline"
        >
          {isExporting ? "저장 중..." : "이미지로 저장"}
        </button>
        {onSaveToCategory && (
          <button
            type="button"
            onClick={handleSaveToCategory}
            disabled={isSaving || (savedId !== null && !dirty)}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {isSaving
              ? "저장 중..."
              : savedId === null
                ? "오답으로 저장"
                : dirty
                  ? "수정 내용 저장"
                  : "저장됨!"}
          </button>
        )}
      </div>
    </div>
  );
}
