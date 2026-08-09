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
import DiagramCropModal from "./DiagramCropModal";
import FigurePanel from "./FigurePanel";
import ScaledCard from "./ScaledCard";
import type { Subject } from "@/lib/subject";
import type { DiagramQuota } from "@/app/api/diagram/quota/route";
import BoxRangeEditor from "./BoxRangeEditor";
import LatexEditor from "./LatexEditor";
import DiagramAdjuster, {
  DEFAULT_DIAGRAM_LAYOUT,
  diagramStyleCss,
  type DiagramLayout,
} from "./DiagramAdjuster";
import { ANSWER_TYPE_LABEL, formatAnswer, type AnswerType } from "@/lib/answer";

type DiagramModel = "flash" | "lite";

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
  }) => Promise<void>;
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
   * math면 수학 도형(Gemini), science면 사과탐 자료(OpenAI).
   * 텍스트·수식은 두 모드 모두 Mathpix가 이미 읽어온 뒤라 차이가 없다.
   */
  subject?: Subject;
};

const FONT_SIZES = [
  { label: "보통", px: 20 },
  { label: "크게", px: 24 },
  { label: "아주 크게", px: 30 },
] as const;

// 도형 재구성은 보통 이 정도(초) 안에 끝난다. 실제 진행률을 알 수 없으니
// 이 값을 기준으로 막대를 서서히 채우되(끝나기 전엔 100%를 보여주면 안
// 되므로 90%에서 멈춘다), 정말 오래 걸리면 안내 문구로 이유를 알려준다.
const VECTORIZE_EXPECTED_SEC = 15;

// 정답 입력이 멎고 이만큼 지나면 자동 저장한다. 너무 짧으면 아직 타는 중에
// 저장되고, 너무 길면 자동 저장을 기다리다 답답하다.
const AUTO_SAVE_SEC = 3;

// 모델 선택 UI 문구. 실제 과금·한도는 서버(0010 마이그레이션의 RPC)가 정하고,
// 여기 숫자는 quota 응답으로 채워 넣는다 — 하드코딩하면 서버와 어긋난다.
const MODEL_LABELS: Record<DiagramModel, string> = {
  lite: "lite",
  flash: "flash",
};

function vectorizeProgressPercent(elapsedSec: number): number {
  return Math.min(90, Math.round((elapsedSec / VECTORIZE_EXPECTED_SEC) * 90));
}

function vectorizeStatusText(elapsedSec: number): string {
  if (elapsedSec < 4) return "이미지를 서버로 보내는 중...";
  if (elapsedSec < 10) return "도형을 분석하고 있어요...";
  if (elapsedSec < 20) return "벡터 이미지로 다시 그리는 중이에요...";
  return "생각보다 오래 걸리네요. 조금만 더 기다려주세요...";
}

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
  const [saved, setSaved] = useState(false);
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
  // (도형 id -> data URL). 무료·자동, Gemini 재구성과는 별개다.
  const [rasterFallbacks, setRasterFallbacks] = useState<Record<string, string>>({});
  // "도형 추가인식"으로 사람이 직접 오려내 Gemini가 재구성한 SVG들. 클릭할
  // 때마다 하나씩 쌓인다(문제당 여러 도형이 있으면 여러 번 실행 가능).
  // 크기·위치 설정을 도형별로 따로 들고 있어야 해서 배열 인덱스가 아니라 고정
  // id를 쓴다(인덱스로 키를 잡으면 하나를 지웠을 때 뒤 도형들의 설정이 한 칸씩
  // 밀려 엉뚱한 도형에 적용된다).
  // kind는 조절 목록에 붙는 이름에만 쓴다(수학 도형인지 사과탐 자료인지).
  // 붙는 방식·저장 경로는 둘이 완전히 같다.
  const [manualDiagramSvgs, setManualDiagramSvgs] = useState<
    { id: string; svg: string; kind: "math" | "figure" }[]
  >([]);
  const [showDiagramCrop, setShowDiagramCrop] = useState(false);
  const [isVectorizing, setIsVectorizing] = useState(false);
  const [vectorizeError, setVectorizeError] = useState<string | null>(null);
  // 실패는 아니지만 알려야 하는 일(예: flash 전역 한도가 차서 lite로 그림).
  const [vectorizeNotice, setVectorizeNotice] = useState<string | null>(null);
  // 도형 재구성 API는 스트리밍 응답이 아니라 실제 진행률을 알 방법이 없다.
  // 대신 경과 시간을 세서 "멈춘 게 아니라 원래 오래 걸린다"를 보여준다.
  const [vectorizeElapsedSec, setVectorizeElapsedSec] = useState(0);
  // 어떤 모델로 도형을 재구성할지. 기본은 사진인식권만 쓰는 lite로 둔다
  // (플래시쿠폰은 하루 5장뿐이라 사용자가 의식하고 골라 쓰게 한다).
  const [diagramModel, setDiagramModel] = useState<DiagramModel>("lite");
  // 결제 여부와 남은 수량. null이면 아직 못 불러온 상태.
  const [quota, setQuota] = useState<DiagramQuota | null>(null);

  // 결제 상태와 남은 수량을 불러온다. 도형 기능은 원본 사진이 없어도 카메라로
  // 새로 찍어 쓸 수 있으므로 항상 보여주고, 한 번 쓰고 나면 다시 불러
  // 남은 수량을 갱신한다(refreshQuota).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/diagram/quota")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setQuota(data as DiagramQuota);
      })
      .catch(() => {
        // 잔량을 못 불러와도 버튼은 눌러볼 수 있게 둔다(서버가 최종 판단한다).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshQuota() {
    try {
      const res = await fetch("/api/diagram/quota");
      if (res.ok) setQuota((await res.json()) as DiagramQuota);
    } catch {
      // 갱신 실패는 무시 — 다음 렌더에서 다시 시도된다.
    }
  }

  useEffect(() => {
    if (!isVectorizing) {
      setVectorizeElapsedSec(0);
      return;
    }
    const startedAt = Date.now();
    const id = setInterval(() => {
      setVectorizeElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [isVectorizing]);

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
  const anchors = useMemo(() => {
    const out: { block: number; line: number | null }[] = [];
    blocks.forEach((b, bi) => {
      out.push({ block: bi, line: null });
      if (b.kind === "box") {
        for (let li = 0; li <= b.lines.length; li++) {
          out.push({ block: bi, line: li });
        }
      }
    });
    out.push({ block: blocks.length, line: null });
    return out;
  }, [blocks]);

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

  /** 문단 사이와 박스 안 줄 사이에 도형·자료를 끼워 넣은 최종 카드 HTML. */
  const cardHtml = useMemo(() => {
    const atSlot = (slot: number) =>
      figures
        .filter((f) => positionOf(f.id) === slot)
        .map(
          (f) =>
            `<div class="problem-figure" data-fig-id="${f.id}" style="${diagramStyleCss(
              layoutOf(f.id),
            )}">${f.markup}</div>`,
        )
        .join("");

    // anchors와 정확히 같은 순서로 훑어야 자리 번호가 어긋나지 않는다.
    let slot = 0;
    let out = "";
    for (const block of blocks) {
      out += atSlot(slot++);
      if (block.kind === "plain") {
        out += block.html;
        continue;
      }
      let inner = "";
      for (const line of block.lines) {
        inner += atSlot(slot++) + line;
      }
      inner += atSlot(slot++); // 박스 안 맨 끝
      out += `<div class="mmd-box">${inner}</div>`;
    }
    out += atSlot(slot);
    return out;
    // positionOf/layoutOf는 아래 두 state를 읽는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, anchors, figures, figurePos, layouts]);

  // 정답을 적고 잠시 가만히 있으면 저장 버튼을 누르지 않아도 저장한다.
  // 글자마다 저장하면 "12"를 치는 동안 "1"로 저장되므로 입력이 멎을 때까지 기다린다.
  // 도형·박스를 더 만지려던 참이면 아래 안내에 남은 시간이 보이고, 취소할 수 있다.
  const [autoSaveLeftSec, setAutoSaveLeftSec] = useState<number | null>(null);
  const [autoSaveOff, setAutoSaveOff] = useState(false);

  useEffect(() => {
    if (!onSaveToCategory || autoSaveOff || saved || isSaving) return;
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
  }, [answer, answerType, autoSaveOff, saved, isSaving, onSaveToCategory]);

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

  /**
   * 사람이 오려낸 도형 영역을 Gemini로 보내 깨끗한 SVG로 재구성한다.
   * 과금은 서버가 한다 — lite는 사진인식권 5장, flash는 플래시쿠폰 1장.
   */
  async function handleDiagramCropConfirm(croppedDataUrl: string) {
    setShowDiagramCrop(false);
    setIsVectorizing(true);
    setVectorizeError(null);
    setVectorizeNotice(null);
    try {
      const res = await fetch("/api/diagram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: croppedDataUrl, model: diagramModel }),
      });
      let json: {
        svg?: string;
        error?: string;
        /** 서버가 실제로 쓴 모델. 전역 예산이 바닥나면 flash 대신 lite가 온다. */
        model?: DiagramModel;
        /** 요청한 모델과 다르게 처리했을 때의 안내. */
        notice?: string | null;
      };
      try {
        json = await res.json();
      } catch {
        // Vercel이 함수 실행시간 초과 등으로 요청을 강제 종료하면 JSON이 아니라
        // 자체 에러 페이지(HTML/텍스트)를 돌려준다 — 그걸 그대로 파싱하려다
        // 나는 원본 파싱 에러 대신 원인을 짐작할 수 있는 메시지로 바꿔준다.
        throw new Error(
          "서버에서 정상적인 응답을 받지 못했어요. 시간이 너무 오래 걸려 요청이 중단됐을 수 있습니다. 잠시 후 다시 시도해주세요.",
        );
      }
      if (!res.ok) throw new Error(json.error ?? "도형 재구성에 실패했습니다.");
      setManualDiagramSvgs((prev) => [
        ...prev,
        { id: crypto.randomUUID(), svg: json.svg as string, kind: "math" },
      ]);
      // 실패는 아니지만 알려야 하는 경우(flash 전역 한도 소진 → lite로 대체).
      setVectorizeNotice(json.notice ?? null);
    } catch (err) {
      setVectorizeError(
        err instanceof Error ? err.message : "도형 재구성에 실패했습니다.",
      );
    } finally {
      setIsVectorizing(false);
      // 성공이든 실패(=환불)든 서버 잔량이 바뀌었을 수 있으니 다시 읽는다.
      void refreshQuota();
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

  async function handleSaveToCategory() {
    if (!cardRef.current || !onSaveToCategory) return;
    // 자동 저장과 버튼이 겹쳐 두 번 저장되면 같은 문제가 두 개 생긴다.
    if (isSaving || saved) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      const dataUrl = await toPng(cardRef.current, {
        pixelRatio: 2,
        backgroundColor: "#ffffff",
      });
      await onSaveToCategory({
        pngDataUrl: dataUrl,
        text: sourceText,
        answer: answer.trim(),
        answerType,
        boxOverride,
      });
      setSaved(true);
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
            <LatexEditor value={sourceText} onChange={setSourceText} rows={10} />
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
                d.kind === "figure"
                  ? `탐구 자료 ${idx + 1}`
                  : `추가인식 도형 ${idx + 1}`
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

      {/* 수학 모드에서만 보이는 도형 도구(Gemini). 사과탐 모드에서는 아래
          FigurePanel이 대신 나온다 — 두 도구를 같이 두면 어느 걸 눌러야
          할지 헷갈리고 엉뚱한 모델에 크레딧을 쓰게 된다. */}
      {subject === "math" && !isVectorizing && (
        <div className="flex flex-col gap-2 rounded-lg border border-slate-200 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-slate-500">도형 화질</span>
            {(["lite", "flash"] as const).map((m) => {
              const selected = diagramModel === m;
              // flash는 결제자 전용이라 미결제 상태면 아예 고를 수 없게 막는다.
              const locked = m === "flash" && quota !== null && !quota.paid;
              const exhausted =
                quota !== null &&
                (m === "flash"
                  ? quota.flashRemaining <= 0 || quota.flashGlobalRemaining <= 0
                  : !quota.liteFree && quota.credits < quota.liteCost);
              return (
                <button
                  key={m}
                  type="button"
                  disabled={locked}
                  onClick={() => setDiagramModel(m)}
                  className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${
                    selected
                      ? "border-blue-600 bg-blue-50 text-blue-700"
                      : "border-slate-300 text-slate-600 hover:bg-slate-100"
                  } ${locked || exhausted ? "opacity-50" : ""}`}
                >
                  {MODEL_LABELS[m]}
                  {m === "flash" ? " (고화질)" : " (기본)"}
                  {locked && " 🔒"}
                </button>
              );
            })}
          </div>

          <p className="text-[11px] text-slate-500">
            {diagramModel === "flash" ? (
              quota && !quota.paid ? (
                <>flash는 이용권을 구매한 분만 쓸 수 있어요.</>
              ) : (
                <>
                  {quota?.unlimited
                    ? "무제한 계정이라 쿠폰은 차감되지 않아요."
                    : "플래시쿠폰 1장을 씁니다."}
                  {quota && !quota.unlimited &&
                    ` 오늘 ${quota.flashRemaining}/${quota.flashDailyLimit}장 남음 (매일 자정 초기화)`}
                </>
              )
            ) : quota?.unlimited ? (
              <>무제한 계정이라 차감 없이 쓸 수 있어요.</>
            ) : quota?.liteFree ? (
              <>이용권 구매자는 lite를 무료로 쓸 수 있어요.</>
            ) : (
              <>
                사진인식권 {quota?.liteCost ?? 5}장을 씁니다.
                {quota && ` 남은 사진인식권 ${quota.credits}장`}
              </>
            )}
          </p>

          {/* 전역 예산은 개인 잔량과 무관하게 flash를 막으므로 따로 알린다.
              무제한 계정도 예외가 아니다 — 이건 우리 지갑이 아니라 Gemini의
              하루 요청 수 제한이라서 운영자라고 넘길 수 있는 게 아니다. */}
          {diagramModel === "flash" && quota && quota.paid && (
            <p
              className={`text-[11px] ${
                quota.flashGlobalRemaining <= 0
                  ? "text-amber-700"
                  : quota.flashGlobalRemaining <= 3
                    ? "text-amber-600"
                    : "text-slate-400"
              }`}
            >
              {quota.flashGlobalRemaining <= 0
                ? "오늘 flash 전 세대의 사용량이 한도에 찼어요. 지금 누르면 lite로 그려집니다."
                : `오늘 전체 flash 잔여 ${quota.flashGlobalRemaining}/${quota.flashGlobalLimit}건 (모든 사용자 합계)` +
                  (quota.currentFlashModel ? ` · 현재 ${quota.currentFlashModel}` : "")}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowDiagramCrop(true)}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
            >
              도형 추가인식
            </button>
            {quota && !quota.paid && (
              <a
                href="/api/checkout"
                className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
              >
                이용권 구매 (lite 무료 + flash 사용)
              </a>
            )}
            {vectorizeError && (
              <p className="text-xs text-red-600">{vectorizeError}</p>
            )}
            {vectorizeNotice && (
              <p className="text-xs text-amber-700">{vectorizeNotice}</p>
            )}
          </div>
        </div>
      )}

      {isVectorizing && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-600">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
            <span>{vectorizeStatusText(vectorizeElapsedSec)}</span>
            <span className="ml-auto tabular-nums text-slate-400">
              {vectorizeElapsedSec}초 경과
            </span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full rounded-full bg-blue-600 transition-all duration-1000 ease-linear"
              style={{ width: `${vectorizeProgressPercent(vectorizeElapsedSec)}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-slate-400">
            도형 재구성은 보통 10~20초 정도 걸려요. 화면을 벗어나지 말고 잠시만 기다려주세요.
          </p>
        </div>
      )}

      {subject === "math" && showDiagramCrop && (
        <DiagramCropModal
          imageSrc={sourceImage ?? null}
          onConfirm={handleDiagramCropConfirm}
          onCancel={() => setShowDiagramCrop(false)}
        />
      )}

      {/* 사과탐 자료. 위의 수학 도형과 완전히 별개 경로(다른 API, 다른 모델)지만
          결과가 같은 SVG 문자열이라 manualDiagramSvgs에 그대로 합류한다 —
          크기·위치 조절, PNG 캡처, 저장이 전부 그대로 따라온다. */}
      {subject === "science" && (
        <FigurePanel
          imageSrc={sourceImage ?? null}
          credits={quota?.credits ?? null}
          unlimited={quota?.unlimited ?? false}
          onAdd={(svg) =>
            setManualDiagramSvgs((prev) => [
              ...prev,
              { id: crypto.randomUUID(), svg, kind: "figure" },
            ])
          }
          onCreditsUsed={() => void refreshQuota()}
        />
      )}

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
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-sm font-medium text-slate-700">
              정답 유형
            </span>
            <div className="flex gap-1">
              {(["choice", "short"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setAnswerType(t)}
                  disabled={saved}
                  className={`rounded-lg border px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
                    answerType === t
                      ? "border-blue-600 bg-blue-50 text-blue-700"
                      : "border-slate-300 text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {ANSWER_TYPE_LABEL[t]}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <span className="shrink-0 font-medium">정답</span>
            <input
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              // 정답을 치고 Enter를 누르면 저장 버튼을 따로 누르지 않아도 저장된다.
              // 글자를 칠 때마다 저장하지 않는 이유: 저장은 PNG를 굽고 업로드까지
              // 하는 무거운 동작이라 "12"를 치는 동안 "1"로 저장돼 버린다.
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (answer.trim() === "") return;
                void handleSaveToCategory();
              }}
              disabled={saved}
              placeholder={
                answerType === "choice"
                  ? "예: 3 → 정답표에 ③으로 표기됩니다"
                  : "예: 12 (PDF 맨 뒤 정답표에 표기됩니다)"
              }
              className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:bg-slate-100"
            />
          </label>
          {!saved && (
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
          {answer.trim() !== "" && (
            <p className="text-[11px] text-slate-500">
              정답표 표기:{" "}
              <span className="text-sm font-medium text-ink">
                {formatAnswer(answer, answerType)}
              </span>
            </p>
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
      {saved && (onAddAnother || (onNext && remainingCount > 0)) && (
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
        {!saved && onNext && remainingCount > 0 && (
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
            disabled={isSaving || saved}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {saved ? "저장됨!" : isSaving ? "저장 중..." : "오답으로 저장"}
          </button>
        )}
      </div>
    </div>
  );
}
