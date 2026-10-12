"use client";

import { runAiTask } from "@/lib/aiTask";
import { inkMapFromImage } from "@/lib/snapBoxes";
import { snapRegions } from "@/lib/pageRefine";
import { attachNumberAndAnswer, readNumberWithMathpix } from "@/lib/quickProblem";
import type { AnswerByNumber } from "@/lib/answerMap";
import { useRef, useState } from "react";
import { NO_CROP_LIMIT, cropImageToDataUrl, fileToDataUrl, isHeicFile, loadImage, openPageSource, type PageSource } from "@/lib/cropImage";
import {
  DETECT_INPUT_DIM,
  MAX_UPLOAD_CHARS,
  prepareProblemForModel,
  rasterToSvg,
  stitchVertically,
} from "@/lib/figureImage";
import { renderCardOffscreen } from "@/lib/renderCardOffscreen";
import { toStoredFigures, type StoredBoxRange } from "@/lib/storedFigures";
import type { CardFigure } from "@/lib/cardHtml";
import { DEFAULT_FONT_PT, ptToPx } from "@/lib/fontSize";
import type { DiagramLayout } from "@/lib/diagramLayout";
import type { DetectedKoreanRegion } from "@/lib/detectProblems";
import type { ProblemBox } from "@/lib/problemBoxes";
import { enhanceContrast } from "@/lib/autoContrast";
import type { PassageFigureInput } from "@/lib/passageFigures";
import { PASSAGE_MARKS_DEPOSIT, PASSAGE_READ_TOKENS } from "@/lib/tokens";
import { useFigureJobs } from "./FigureJobsProvider";
import BoxEditor, { type EditBox } from "./BoxEditor";
import CropShapeToggle from "./CropShapeToggle";
import { useCropShape } from "@/lib/cropShape";
import { cropRegionToDataUrl, type Region } from "@/lib/polygon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/**
 * **국어 모드** — 지문 한 편과 그에 딸린 문항들을 한 세트로 넣는다.
 *
 * 국어가 다른 과목과 다른 점은 **지문**이다. 문항을 낱개로 넣으면 지문이 어느
 * 문제 것인지 알 수 없고, 인쇄할 때 지문과 문제가 다른 쪽으로 갈라져 앞뒤로
 * 넘겨 가며 풀어야 한다. 그래서 같은 `setId` 로 묶어 두고(`koreanSet.ts`),
 * 내보낼 때 **짝수 쪽 지문 · 홀수 쪽 문제**로 펼침면에 나란히 놓는다.
 *
 * **지문과 문제를 따로따로 잡는다**(사용자 요청). 한 화면에서 한꺼번에
 * 받으면 자리를 고칠 수가 없다 — 모델이 지문 아래를 조금 잘라 먹거나 선지
 * 한 줄을 놓치는 일이 흔한데, 그때 지우고 다시 하는 수밖에 없었다.
 *
 *   ① 지문 자리 잡기 → ② 문제 자리 잡기 → ③ 제목 확인하고 저장
 *
 * **한 문항이 여러 단·여러 쪽에 걸친다**(사용자 지적). 국어는 발문이 왼쪽 단
 * 아래에서 시작해 오른쪽 단 위로, 심하면 다음 쪽으로 이어진다. 그래서
 *  - 사진을 **여러 장** 받고,
 *  - 조각마다 네모를 그린 뒤 **같은 문항으로 묶는다**(이름표를 눌러 고르고
 *    "고른 것 한 문제로 묶기"). 자를 때 읽는 차례로 세로로 이어 붙인다.
 *
 * **지문은 그린 것이 전부 한 덩어리**다. 단을 넘든 쪽을 넘든 지문은 어차피
 * 글이라 이어 붙여도 티가 안 난다 — 그래서 묶는 수고를 시키지 않는다.
 *
 * **자동으로 찾기는 시작점일 뿐이다.** 눌러도 되고 안 눌러도 된다 — 손으로만
 * 그려도 되므로 무제한 계정이 아니어도 국어 모드를 쓸 수 있다. 사진 한 장에
 * 한 번씩만 부른다(그 결과를 두 단계가 나눠 쓴다).
 */

/** 통째로 그린 문제 이미지의 배치(다른 패널과 같은 값). */
const WHOLE_PROBLEM_LAYOUT: DiagramLayout = { scale: 100, offsetX: 0, offsetY: 0 };

/**
 * 자동으로 찾은 자리를 자를 때 사방으로 더 주는 여유(지면 크기 대비 비율).
 * **손으로 고친 자리에는 주지 않는다** — 사용자가 정한 자리를 우리가 몰래
 * 넓히면 보이는 것과 잘리는 것이 달라진다.
 */
const PAD = 0;

/** 하이쿠가 잡은 자리를 보정하지 않는다(2026-10-12, 사용자 — "보정하지 말고 쟤가 알아서"). 되살리려면 true. */
const KOREAN_SNAP = false;

/** 지문 네모는 전부 이 묶음에 들어간다(그린 것이 곧 한 지문이다). */
const PASSAGE_GROUP = "passage";

/**
 * 지문 안 **그림** 네모. 지문 단계에서 함께 그린다(luna 가 자동으로 찾아 주기도
 * 한다). 네모마다 따로 잘라 sol 에게 알려 주고 sunburst 로 다시 그려 붙인다
 * (`passageFigures.ts`).
 */
const FIGURE_GROUP = "figure";

type Step = "pick" | "passage" | "questions" | "review";
type StagedSet = { name: string; pieces: Piece[]; title: string; loose: boolean };

type Page = { id: string; file: File | null; dataUrl: string };

type Piece = {
  id: string;
  kind: "passage" | "question";
  crop: string;
  parts: number;
  /** 지문 안 그림들(읽는 차례). 지문 조각에만 있다. */
  figures?: PassageFigureInput[];
  /** luna·하이쿠가 찍힌 그대로 읽은 문제 번호(문제 조각에만). */
  no?: number | null;
  /** 이 조각을 자른 자리(다시 자르기에서 사람이 고친다). */
  boxes?: { pageId: string; box: EditBox }[];
};

/** 쪽마다 자동으로 찾은 결과. 지문과 문제를 **따로** 부르므로 따로 든다. */
type Detected = {
  passages?: DetectedKoreanRegion[];
  figures?: ProblemBox[];
  questions?: DetectedKoreanRegion[];
};

type Props = {
  /** 문제 하나를 저장하고 그 행 id를 돌려준다(AddProblemFlow가 준다). */
  onSave: (args: {
    pngDataUrl: string;
    text: string;
    answer: string;
    answerType: "choice";
    boxRange: StoredBoxRange;
  }) => Promise<string>;
  unlimited?: boolean;
  /**
   * BYOK 패스 계정인가. 본인 키로 직접 내므로 "모두 AI로 다시 그리기"에
   * 토큰 비용을 붙여 보여주면 안 된다(실제로도 안 든다).
   */
  byok?: boolean;
  /** 문제 하나를 다시 그리는 데 드는 토큰. 서버가 알려준 값을 그대로 쓴다. */
  figureCost?: number | null;
  /** 번호 → 정답(연결된 채점·답지). 문제 번호를 읽으면 정답을 함께 붙인다. */
  answerByNumber?: AnswerByNumber;
  onDone?: () => void;
};

export default function KoreanModePanel({
  onSave,
  unlimited = false,
  byok = false,
  figureCost,
  answerByNumber = {},
  onDone,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const { enqueue } = useFigureJobs();

  const [step, setStep] = useState<Step>("pick");
  /** 자동으로 자른 세트들 — 사용자가 확인하기 전에는 저장하지 않는다. */
  const [staged, setStaged] = useState<StagedSet[] | null>(null);
  /** 다시 자르기 중인 조각 — AI 가 자른 자리를 바탕으로 사람이 고친다. */
  const [recut, setRecut] = useState<{ si: number; pid: string; kind: "passage" | "question"; boxes: Record<string, EditBox[]> } | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  /** 쪽(사진) id → 그 쪽에 그린 네모들. */
  const [passageBoxes, setPassageBoxes] = useState<Record<string, EditBox[]>>({});
  /** 손으로 그릴 모양(사각형/다각형). 자르는 화면 어디서든 같은 기본값을 쓴다. */
  const [shape, setShape] = useCropShape();
  const [questionBoxes, setQuestionBoxes] = useState<Record<string, EditBox[]>>({});
  /** 합치기용으로 고른 묶음들. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  /** 자동으로 찾은 결과(쪽마다). 지문·문제를 따로 부르고 각자 한 번만 부른다. */
  const detectedRef = useRef<Record<string, Detected>>({});
  /** 이번 자동 찾기에서 테두리를 글자에 맞춰 다듬은 네모 수(`snapBoxes.ts`). */
  const snappedRef = useRef(0);
  /** 지문 단계에서 새로 그리는 네모가 지문인가 그림인가. */
  const [drawKind, setDrawKind] = useState<"passage" | "figure">("passage");
  /** 자동으로 찾은 자리를 사람이 안 건드렸으면 여유(PAD)를 준다. */
  const autoIdsRef = useRef<Set<string>>(new Set());
  /** 문항 묶음 id → luna 가 읽은 문제 번호. */
  const noByGroupRef = useRef<Map<string, number>>(new Map());

  const [pieces, setPieces] = useState<Piece[]>([]);
  const piecesState = pieces;
  const [title, setTitle] = useState("");
  const titleState = title;
  const [titleNote, setTitleNote] = useState<string | null>(null);
  /** 제목을 짓는 중인가. 다 되기 전에 저장하면 제목 없이 저장된다. */
  const [titling, setTitling] = useState(false);
  /** 제목을 지을 재료(지문 크롭). 다시 짓기 버튼이 쓴다. */
  const passageCropRef = useRef<string | null>(null);
  const [noPassage, setNoPassage] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** 지문 인식 진행 상황. 지문이 없거나 아직 안 돌면 null. */

  function reset() {
    setStep("pick");
    setPages([]);
    setPassageBoxes({});
    setQuestionBoxes({});
    setPicked(new Set());
    detectedRef.current = {};
    autoIdsRef.current = new Set();
    setPieces([]);
    setTitle("");
    setTitleNote(null);
    setError(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function pickFiles(files: File[]) {
    setError(null);
    setNote(null);
    if (files.length === 0) return;
    const bad = files.find(isHeicFile);
    if (bad) {
      setError("HEIC 사진은 아직 읽지 못합니다. JPG/PNG로 저장해 다시 올려주세요.");
      return;
    }
    try {
      const added: Page[] = [];
      for (const file of files) {
        added.push({ id: crypto.randomUUID(), file, dataUrl: await fileToDataUrl(file) });
      }
      setPages((prev) => [...prev, ...added]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "사진을 읽지 못했습니다.");
    }
  }

  /** 자를 재료. 원본이 있으면 원본에서 잘라야 조각이 흐려지지 않는다. */
  async function openSource(page: Page): Promise<PageSource> {
    const s = await openPageSource(page.file, page.dataUrl);
    // 원본을 못 열어 축소본으로 내려갔으면 알린다 — 말없이 흐려지면 원인을 모른다.
    if (s.degraded) {
      setError(
        `"${page.file?.name ?? "사진"}" 원본을 열지 못해 화면용 축소본(${s.width}×${s.height})에서 잘랐어요. 조각이 흐릴 수 있어요 — 사진을 캡처하거나 갤러리에서 다시 저장해 올려주세요.`,
      );
    }
    return s;
  }

  function cutBox(img: HTMLImageElement | ImageBitmap, b: Region, pad: number): string {
    // 손으로 그린 다각형이면 바깥을 흰색으로 지우고 자른다(`polygon.ts`).
    return cropRegionToDataUrl(img, b, pad, NO_CROP_LIMIT);
  }

  /**
   * 영역을 찾을 때 보낼 이미지. **원본에서 만들되 요청 상한에 맞춰 줄인다**
   * (Vercel 4.5MB). 배치 패널과 같은 방식이다.
   */
  async function detectImage(src: PageSource): Promise<string> {
    const img = src.img;
    const whole = { x: 0, y: 0, width: src.width, height: src.height };
    let last = "";
    for (const dim of [DETECT_INPUT_DIM, 2400, 2000, 1600, 1200]) {
      last = cropImageToDataUrl(img, whole, { maxWidth: dim, maxHeight: dim });
      if (last.length <= MAX_UPLOAD_CHARS) break;
    }
    const enhanced = await enhanceContrast(last);
    return enhanced.length <= MAX_UPLOAD_CHARS ? enhanced : last;
  }

  /**
   * 자동으로 찾아 네모를 채워 준다.
   *
   * **지문 먼저, 문제는 따로**(2026-09-25, 사용자 지시 — "지문이랑 문제 같이
   * 보지 말고"). 지문 단계에서는 지문 자리와 그 안의 그림 자리를, 문제 단계에서는
   * 문제 자리만 찾는다. 문제를 찾을 때는 **지문 단계에서 정해진 네모**(사람이
   * 고친 것까지)를 함께 보내 그 자리를 비켜 가게 한다. 쪽마다 단계마다 한 번만 부른다.
   */
  async function autoFill(
    kind: "passage" | "question",
    passageOverride?: Record<string, EditBox[]>,
    pgs: Page[] = pages,
  ): Promise<Record<string, EditBox[]> | null> {
    setError(null);
    let failed = 0;
    const byOrder = (a: { box: ProblemBox }, b: { box: ProblemBox }) => {
      const col = (r: { box: ProblemBox }) => (r.box.x + r.box.w / 2 < 0.5 ? 0 : 1);
      return col(a) - col(b) || a.box.y - b.box.y;
    };
    snappedRef.current = 0;
    for (const page of pgs) {
      const cached = detectedRef.current[page.id];
      if (kind === "passage" ? cached?.passages : cached?.questions) continue;
      setBusy(
        `${kind === "passage" ? "지문" : "문제"} 자리를 찾는 중... (${pgs.indexOf(page) + 1}/${pgs.length})`,
      );
      let source: PageSource;
      try {
        source = await openSource(page);
      } catch {
        failed += 1;
        continue;
      }
      try {
        const passagesHere = ((passageOverride ?? passageBoxes)[page.id] ?? [])
          .filter((b) => b.group === PASSAGE_GROUP)
          .map(({ x, y, w, h }) => ({ x, y, w, h }));
        // **서버 대기열에서 찾는다**(`runAiTask` — 대기열 패널에 뜬다).
        const { result: json } = await runAiTask<{
          regions?: DetectedKoreanRegion[];
          figures?: ProblemBox[];
        }>("detect", {
          label: kind === "passage" ? "지문 자리 찾기" : "문제 자리 찾기",
          images: [await detectImage(source)],
          params: {
            mode: kind === "passage" ? "korean-passage" : "korean-question",
            ...(kind === "question" ? { passages: passagesHere } : {}),
          },
        });
        // **테두리는 사진이 정한다**(`snapBoxes.ts`, 지면 통째로 넣기와 같다). 문제는 지문 자리를 넘지 않게 한다.
        // 지문 안 그림은 다듬지 않는다 — 그림 바로 옆 지문 줄을 같은 덩어리로 품을 수 있고, 어차피 다시 그린다.
        let regions = json.regions ?? [];
        const map = KOREAN_SNAP && regions.length ? inkMapFromImage(source.img, source.width, source.height) : null;
        if (map) {
          const res = snapRegions(map, regions.map((r) => r.box), kind === "question" ? passagesHere : []);
          snappedRef.current += res.changed;
          regions = regions.map((r, i) => ({ ...r, box: res.boxes[i] }));
        }
        detectedRef.current[page.id] = {
          ...cached,
          ...(kind === "passage"
            ? { passages: regions, figures: json.figures ?? [] }
            : { questions: regions }),
        };
      } catch (err) {
        setError(err instanceof Error ? err.message : "자리 인식에 실패했습니다.");
        setBusy(null);
        source.revoke();
        return null;
      } finally {
        source.revoke();
      }
    }
    setBusy(null);
    if (failed === pgs.length) {
      setError("사진을 열지 못했습니다.");
      return null;
    }

    const next: Record<string, EditBox[]> = {};
    let any = false;
    let figureCount = 0;
    for (const page of pgs) {
      const d = detectedRef.current[page.id] ?? {};
      // 읽는 차례로 늘어놓는다 — 모델이 순서를 지키지 않는 경우가 있는데,
      // 잡은 차례가 곧 문제 차례다.
      const found = [...((kind === "passage" ? d.passages : d.questions) ?? [])].sort(byOrder);
      const boxes: EditBox[] = found.map((r) => {
        const g = kind === "passage" ? PASSAGE_GROUP : crypto.randomUUID();
        if (kind === "question" && r.no != null) noByGroupRef.current.set(g, r.no);
        return {
        id: crypto.randomUUID(),
        ...r.box,
        // 지문은 그린 것이 전부 한 덩어리다. 문제는 조각마다 따로 잡고
        // 이어진 것만 사용자가 묶는다 — 자동으로 묶으면 서로 다른 문항을
        // 하나로 삼켜 문제가 사라진다(지면 분할에서 실제로 겪은 사고다).
        group: g,
        };
      });
      if (kind === "passage") {
        const figs = [...(d.figures ?? [])]
          .map((box) => ({ box }))
          .sort(byOrder)
          .map(({ box }) => ({ id: crypto.randomUUID(), ...box, group: FIGURE_GROUP }));
        figureCount += figs.length;
        boxes.push(...figs);
      }
      for (const b of boxes) autoIdsRef.current.add(b.id);
      if (boxes.some((b) => b.group !== FIGURE_GROUP)) any = true;
      next[page.id] = boxes;
    }
    if (!any) {
      setError(
        kind === "passage"
          ? "지문을 찾지 못했어요. 손으로 네모를 그려주세요."
          : "문제를 찾지 못했어요. 손으로 네모를 그려주세요.",
      );
      return null;
    }
    const snapNote = snappedRef.current > 0 ? `테두리 ${snappedRef.current}곳을 글자에 맞춰 다듬었어요.` : "";
    if (kind === "passage") {
      setPassageBoxes(next);
      const figNote =
        figureCount > 0 ? `지문 안에서 그림 ${figureCount}개를 찾았어요(주황 네모). 넣을 때 AI 로 다시 그려 붙입니다.` : "";
      if (figNote || snapNote) setNote([figNote, snapNote].filter(Boolean).join(" "));
    } else {
      setQuestionBoxes(next);
      if (snapNote) setNote(snapNote);
    }
    return next;
  }

  /**
   * **자동으로 자르기**(2026-10-11, 사용자 — "국어모드도 자동자르기 도입해 지문따로 문제따로 짤라줘").
   * 지문 자리 → 문제 자리를 차례로(지문 따로, 문제 따로) 찾아 곧바로 자르고 확인 화면까지 간다.
   * 문제는 방금 찾은 지문 자리를 비켜 간다. 잘못 잘린 것은 확인 화면의 "자리 고치기"로 손본다.
   */
  async function autoCut() {
    if (pages.length === 0) return;
    let passage: Record<string, EditBox[]> | undefined;
    if (!noPassage) {
      const p = await autoFill("passage");
      if (!p) {
        setStep("passage");
        return;
      }
      passage = p;
    }
    const q = await autoFill("question", passage);
    if (!q) {
      setStep("questions");
      return;
    }
    await cutAll({ passage, question: q });
  }

  /** 문제 단계의 묶음들을 **그린 차례**로 늘어놓는다. */
  function questionGroups(
    src: Record<string, EditBox[]> = questionBoxes,
    pgs: Page[] = pages,
  ): { group: string; boxes: { page: Page; box: EditBox }[] }[] {
    const order: string[] = [];
    const byGroup = new Map<string, { page: Page; box: EditBox }[]>();
    for (const page of pgs) {
      for (const box of src[page.id] ?? []) {
        if (!byGroup.has(box.group)) {
          byGroup.set(box.group, []);
          order.push(box.group);
        }
        byGroup.get(box.group)!.push({ page, box });
      }
    }
    return order.map((group) => ({ group, boxes: byGroup.get(group)! }));
  }

  /** 고른 묶음들을 한 문항으로 합친다(가장 먼저 그린 묶음에 몰아 넣는다). */
  function mergePicked() {
    if (picked.size < 2) return;
    const groups = questionGroups().filter((g) => picked.has(g.group));
    if (groups.length < 2) return;
    const keep = groups[0].group;
    setQuestionBoxes((prev) => {
      const next: Record<string, EditBox[]> = {};
      for (const [pageId, list] of Object.entries(prev)) {
        next[pageId] = list.map((b) => (picked.has(b.group) ? { ...b, group: keep } : b));
      }
      return next;
    });
    setPicked(new Set());
  }

  /** 묶음을 풀어 네모마다 따로 문항이 되게 한다. */
  function splitPicked() {
    if (picked.size === 0) return;
    setQuestionBoxes((prev) => {
      const next: Record<string, EditBox[]> = {};
      for (const [pageId, list] of Object.entries(prev)) {
        next[pageId] = list.map((b) =>
          picked.has(b.group) ? { ...b, group: crypto.randomUUID() } : b,
        );
      }
      return next;
    });
    setPicked(new Set());
  }

  /** 정해진 자리대로 잘라 미리보기를 만들고 제목을 짓는다. */
  async function cutAll(over?: {
    passage?: Record<string, EditBox[]>;
    question?: Record<string, EditBox[]>;
    pages?: Page[];
    /** 지문 없는 문항 묶음이면 지문을 자르지 않는다. */
    noPassageOverride?: boolean;
    /** 화면 단계를 건드리지 않고 조각만 돌려준다(한꺼번에 넣기). */
    quiet?: boolean;
  }): Promise<Piece[] | null> {
    const passageSrc = over?.passage ?? passageBoxes;
    const pgs = over?.pages ?? pages;
    setError(null);
    setBusy("사진을 여는 중...");
    // 쪽마다 한 번만 열고 다 자를 때까지 들고 있는다(여러 번 열면 느리다).
    const opened: (PageSource & { page: Page })[] = [];
    try {
      for (const page of pgs) {
        const s = await openSource(page);
        opened.push({ page, ...s });
      }
    } catch (err) {
      opened.forEach((o) => o.revoke());
      setError(err instanceof Error ? err.message : "사진을 열지 못했습니다.");
      setBusy(null);
      return null;
    }

    try {
      setBusy("자르는 중...");
      const imgOf = new Map(opened.map((o) => [o.page.id, o.img] as const));
      // 손으로 고친 자리에는 여유를 주지 않는다(사용자가 정한 자리다).
      const pad = (b: EditBox) => (autoIdsRef.current.has(b.id) ? PAD : 0);
      const cut: Piece[] = [];

      if (!noPassage && !over?.noPassageOverride) {
        // 지문은 그린 것 전부가 한 덩어리다. 단을 넘든 쪽을 넘든 어차피 글이라
        // 이어 붙여도 티가 안 난다.
        const parts: string[] = [];
        const figures: PassageFigureInput[] = [];
        const srcBoxes: { pageId: string; box: EditBox }[] = [];
        for (const page of pgs) {
          const list = passageSrc[page.id] ?? [];
          for (const b of list) srcBoxes.push({ pageId: page.id, box: b });
          const passagesHere = list.filter((b) => b.group === PASSAGE_GROUP);
          for (const b of passagesHere) {
            parts.push(cutBox(imgOf.get(page.id)!, b, pad(b)));
          }
          // 그림은 따로 잘라 둔다. 폭 비율은 그림을 품은 지문 네모에 견준다 —
          // 조판할 때 원본과 같은 크기로 놓으려는 것이다.
          for (const f of list.filter((b) => b.group === FIGURE_GROUP)) {
            const cx = f.x + f.w / 2;
            const cy = f.y + f.h / 2;
            const host = passagesHere.find(
              (p) => cx >= p.x && cx <= p.x + p.w && cy >= p.y && cy <= p.y + p.h,
            );
            figures.push({
              crop: cutBox(imgOf.get(page.id)!, f, pad(f)),
              scale: host ? Math.min(1, Math.max(0.15, f.w / host.w)) : 0.8,
            });
          }
        }
        if (parts.length > 0) {
          cut.push({
            id: crypto.randomUUID(),
            kind: "passage",
            crop: await stitchVertically(parts),
            parts: parts.length,
            figures,
            boxes: srcBoxes,
          });
        }
      }

      for (const g of questionGroups(over?.question, pgs)) {
        const parts = g.boxes.map(({ page, box }) => cutBox(imgOf.get(page.id)!, box, pad(box)));
        cut.push({
          id: crypto.randomUUID(),
          kind: "question",
          crop: await stitchVertically(parts),
          parts: parts.length,
          no: noByGroupRef.current.get(g.group) ?? null,
          boxes: g.boxes.map(({ page, box }) => ({ pageId: page.id, box })),
        });
      }

      if (over?.quiet) return cut;
      setPieces(cut);
      setStep("review");
      const passage = cut.find((p) => p.kind === "passage");
      if (passage) void makeTitle(passage.crop);
      return cut;
    } catch (err) {
      setError(
        "사진을 자르지 못했습니다: " + (err instanceof Error ? err.message : "알 수 없는 오류"),
      );
      return null;
    } finally {
      opened.forEach((o) => o.revoke());
      setBusy(null);
    }
  }

  /**
   * 지문 **사진**으로 제목을 짓는다(luna). 예전에는 따로 읽어 둔 글자를 보냈는데,
   * 지문 인식이 한 번의 호출로 합쳐지면서(2026-09-25) 글자를 먼저 읽는 단계가
   * 없어졌다 — 제목 짓기가 지문 인식을 기다리게 하면 저장 전까지 제목이 안 나온다.
   */
  async function makeTitle(passageCrop: string) {
    passageCropRef.current = passageCrop;
    setTitling(true);
    setTitleNote("제목을 짓는 중...");
    try {
      const { result: json } = await runAiTask<{ title?: string; kind?: string }>("title", {
        label: "지문 제목 짓기",
        images: [await prepareProblemForModel(passageCrop)],
      });
      if (!json?.title) throw new Error("제목을 짓지 못했습니다.");
      setTitle(json.title);
      setTitleNote(`${json.kind ?? ""} 지문으로 보고 지었어요. 고쳐도 됩니다.`);
    } catch (err) {
      // 제목이 없어도 넣을 수는 있어야 한다. 사용자가 직접 적으면 된다.
      setTitleNote(
        (err instanceof Error ? err.message : "제목을 짓지 못했습니다.") + " 직접 적어주세요.",
      );
    } finally {
      setTitling(false);
    }
  }

  /** 조각 하나를 카드 PNG 로 만든다(그림 한 장이 곧 카드다). */
  async function toCard(piece: Piece) {
    const figure: CardFigure = {
      id: piece.id,
      markup: await rasterToSvg(piece.crop),
      layout: WHOLE_PROBLEM_LAYOUT,
      position: 0,
    };
    const pngDataUrl = await renderCardOffscreen({
      text: "",
      boxOverride: undefined,
      fontSizePx: ptToPx(DEFAULT_FONT_PT),
      figures: [figure],
    });
    return { figure, pngDataUrl };
  }

  /**
   * 저장한다. `regenerate` 면 **문제**는 AI 재생성 큐에, **지문**은 지문 인식
   * 큐에 넣는다 — 갈래가 다르다(사진 재생성 vs 글자 인식). 둘 다 서버 큐라
   * **기다리지 않는다**(사용자 — "지문인식하는동안 아무것도 못함").
   *
   * **저장을 먼저 한다.** 그래야 행 id 를 큐에 함께 넘길 수 있고, 브라우저를
   * 닫아도 서버가 결과를 그 행에 직접 저장한다. 지문은 우선 사진으로 저장되고
   * 인식이 끝나면 일꾼이 `korean.blocks` 를 채운다(`passageRun.ts`) — 그 전에
   * 내보내도 사진으로 나올 뿐 빈 자리가 아니다.
   */
  async function save(
    regenerate: boolean,
    opts?: { pieces: Piece[]; title: string; quiet?: boolean; loose?: boolean; passageOnly?: boolean },
  ): Promise<number> {
    const pieces = opts?.pieces ?? piecesState;
    const title = opts?.title ?? titleState;
    if (pieces.length === 0) return 0;
    setError(null);
    setNote(null);
    // 한 세트는 지문 하나와 그 문항들이다. 지문 없는 문항이면 묶지 않는다.
    const setId = crypto.randomUUID();
    let done = 0;
    let qIndex = 0;
    let passageQueued = false;

    for (const piece of pieces) {
      setBusy(`넣는 중... (${done + 1}/${pieces.length})`);
      try {
        const { figure, pngDataUrl } = await toCard(piece);

        const korean = noPassage || opts?.loose
          ? undefined
          : piece.kind === "passage"
            ? {
                setId,
                role: "passage" as const,
                ...(title.trim() ? { title: title.trim() } : {}),
              }
            : { setId, role: "question" as const, index: qIndex };
        // 지문 없는 문항이어도 세어 둔다 — 아래 진행 패널 이름표에 쓴다.
        if (piece.kind === "question") qIndex += 1;

        const problemId = await onSave({
          pngDataUrl,
          text: "",
          answer: "",
          answerType: "choice",
          boxRange: {
            ranges: null,
            fontPt: DEFAULT_FONT_PT,
            figures: toStoredFigures([figure]),
            ...(korean ? { korean } : {}),
          },
        });

        // 번호는 luna 가 영역을 찾으며 읽은 것을 쓴다(지면 자르기와 같다). 없을 때만 Mathpix 로 읽는다.
        if (piece.kind === "question") {
          void (async () => {
            const n = piece.no != null ? piece.no : await readNumberWithMathpix(piece.crop);
            if (n != null) await attachNumberAndAnswer(problemId, n, answerByNumber).catch(() => null);
          })();
        }

        // 지문은 **글자로 옮기는** 작업으로 넣는다(이미지 생성이 아니다).
        if (regenerate && !noPassage && !opts?.loose && piece.kind === "passage") {
          enqueue({
            id: piece.id,
            problemKey: `korean:${problemId}`,
            label: `지문 · ${title.trim() || "제목 없음"}`,
            crop: piece.crop,
            mode: "passage",
            passageFigures: piece.figures,
            korean: true,
            problemId,
          });
          passageQueued = true;
        }
        if (regenerate && piece.kind === "question" && !opts?.passageOnly) {
          enqueue({
            id: piece.id,
            problemKey: `korean:${problemId}`,
            label: `${qIndex}번째 문제`,
            crop: piece.crop,
            mode: "problem",
            // 국어는 글자뿐이라 참고 글(문제 그리기 쪽은 여전히 Mathpix)을 더 앞세운다.
            korean: true,
            problemId,
          });
        }
        done += 1;
      } catch (err) {
        setError(
          `${done + 1}번째에서 멈췄습니다: ` +
            (err instanceof Error ? err.message : "알 수 없는 오류"),
        );
        break;
      }
    }

    setBusy(null);
    if (opts?.quiet) return done;
    if (done > 0) {
      setNote(
        regenerate
          ? `${done}개를 넣었어요.${passageQueued ? " 지문은 글자로 옮기는 중이에요(끝나면 평가원 글꼴로 조판됩니다)." : ""} 문제는 AI 재생성 큐에 올렸어요 — 진행 상황은 화면 구석에서 볼 수 있고, 그동안 다른 걸 해도 돼요.`
          : `${done}개를 원본 그대로 넣었어요.`,
      );
      reset();
      onDone?.();
    }
    return done;
  }

  /** 지문 사진으로 제목을 짓는다(화면 상태를 안 건드린다). 실패하면 빈 제목. */
  async function fetchTitle(crop: string): Promise<string> {
    try {
      const { result: json } = await runAiTask<{ title?: string }>("title", {
        label: "지문 제목 짓기",
        images: [await prepareProblemForModel(crop)],
      });
      return json?.title?.trim() ?? "";
    } catch {
      return "";
    }
  }

  /**
   * **때려박기**(2026-10-11, 사용자 — "우리 자동 자르기처럼 걍 때려박으면 되게끔, 알아서 문제랑 지문
   * 인식해가지고 딱딱" · "하이쿠가 여러 개 동시에 돌아야 하고, 어디까지가 세트인지는 지문 위 [1~4]
   * 텍스트를 먼저 뽑아서 묶게끔, 그 전에는 묶지 말고").
   *
   * ① 사진마다 **동시에**(하이쿠) 지문 자리(+ 위 `[1~4]` 줄의 범위)와 문제 자리(+ 번호)를 찾는다.
   * ② 읽는 차례로 훑으며 **범위가 읽힌 지문이 세트를 연다**. 범위 없는 지문 조각(이어진 단·쪽)은 앞 세트에 붙고,
   *    문제는 **번호가 범위 안에 드는 세트**로 간다. 범위로 묶이지 않는 문제는 묶지 않고 낱개(지문 없는 문항)로 둔다.
   * ③ 세트마다 자르기 → 제목 → 저장(+AI 큐). 확인 화면은 없다. 실패한 세트는 건너뛰고 끝에 알린다.
   */
  async function dump() {
    if (pages.length === 0) return;
    setError(null);
    setNote(null);
    const total = pages.length;
    let finished = 0;
    setBusy(`자리 찾는 중... (0/${total})`);

    // 그림을 열고 줄이는 일은 화면 스레드라 열 장까지 겹친다. 모델 호출은 제한 없이 동시에 간다.
    let openSlots = 10;
    const waiters: (() => void)[] = [];
    const acquire = () =>
      openSlots > 0
        ? ((openSlots -= 1), Promise.resolve())
        : new Promise<void>((r) => waiters.push(r));
    const release = () => {
      const w = waiters.shift();
      if (w) w();
      else openSlots += 1;
    };
    const byOrder = (a: { box: ProblemBox }, b: { box: ProblemBox }) => {
      const col = (r: { box: ProblemBox }) => (r.box.x + r.box.w / 2 < 0.5 ? 0 : 1);
      return col(a) - col(b) || a.box.y - b.box.y;
    };

    type PassageHit = { box: ProblemBox; range: { from: number; to: number } | null };
    type QuestionHit = { box: ProblemBox; no: number | null };
    type PageHits = { page: Page; pageNo: number | null; passages: PassageHit[]; figures: ProblemBox[]; questions: QuestionHit[] };

    async function detectPage(page: Page): Promise<PageHits | null> {
      let detectImg: string;
      let map: ReturnType<typeof inkMapFromImage> | null = null;
      await acquire();
      try {
        const source = await openSource(page);
        try {
          detectImg = await detectImage(source);
          map = inkMapFromImage(source.img, source.width, source.height);
        } finally {
          source.revoke();
        }
      } catch {
        return null;
      } finally {
        release();
      }
      const snap = (boxes: ProblemBox[], avoid: ProblemBox[]) => {
        if (!KOREAN_SNAP || !map || boxes.length === 0) return boxes;
        const res = snapRegions(map, boxes, avoid);
        snappedRef.current += res.changed;
        return res.boxes;
      };
      try {
        let passages: PassageHit[] = [];
        let figures: ProblemBox[] = [];
        let pageNo: number | null = null;
        if (!noPassage) {
          const { result } = await runAiTask<{ regions?: DetectedKoreanRegion[]; figures?: ProblemBox[]; pageNo?: number | null }>("detect", {
            label: "지문 자리 찾기",
            images: [detectImg],
            params: { mode: "korean-passage" },
          });
          const regs = result.regions ?? [];
          const snapped = snap(regs.map((r) => r.box), []);
          passages = regs.map((r, i) => ({ box: snapped[i], range: r.range ?? null }));
          figures = result.figures ?? [];
          pageNo = result.pageNo ?? null;
        }
        const avoid = passages.map((p) => p.box).map(({ x, y, w, h }) => ({ x, y, w, h }));
        const { result: q } = await runAiTask<{ regions?: DetectedKoreanRegion[]; pageNo?: number | null }>("detect", {
          label: "문제 자리 찾기",
          images: [detectImg],
          params: { mode: "korean-question", ...(avoid.length ? { passages: avoid } : {}) },
        });
        const qr = q.regions ?? [];
        const qs = snap(qr.map((r) => r.box), avoid);
        const questions = qr.map((r, i) => ({ box: qs[i], no: r.no ?? null }));
        return { page, pageNo: pageNo ?? q.pageNo ?? null, passages, figures, questions };
      } catch (err) {
        console.warn("[korean-dump] 자리 찾기 실패:", err instanceof Error ? err.message : err);
        return null;
      } finally {
        finished += 1;
        setBusy(`자리 찾는 중... (${finished}/${total})`);
      }
    }

    snappedRef.current = 0;
    let pageOrderNote = "";
    const hits = await Promise.all(pages.map((p) => detectPage(p)));
    const failedPages = hits.filter((h) => !h).length;
    const ok = hits.filter((h): h is PageHits => !!h);
    // 쪽 번호(아래 가운데 사선 상자)를 읽은 쪽끼리는 번호 순으로 다시 세운다 — 사진 순서가 뒤섞여 있어도 지문·문항이 이어지게.
    // 번호를 못 읽은 쪽은 제 자리를 지킨다.
    const numbered = ok.map((h, i) => ({ h, i })).filter((x) => x.h.pageNo != null);
    let reordered = false;
    if (numbered.length > 1) {
      const sorted = [...numbered].sort((a, b) => a.h.pageNo! - b.h.pageNo!);
      const slots = numbered.map((x) => x.i);
      sorted.forEach((x, n) => {
        if (ok[slots[n]] !== x.h) reordered = true;
      });
      sorted.forEach((x, n) => {
        ok[slots[n]] = x.h;
      });
    }
    pageOrderNote = numbered.length
      ? `쪽 번호로 순서를 맞췄어요: ${ok.map((h) => h.pageNo ?? "?").join(" → ")}${reordered ? " (사진 순서가 달랐어요)" : ""}.`
      : "";
    if (ok.length === 0) {
      setBusy(null);
      setError("자리를 못 찾았어요. 아래 단계별로 손으로 해주세요.");
      return;
    }

    // ── 세트로 묶기: 범위가 읽힌 지문만 세트를 연다 ──
    type SetDraft = {
      range: { from: number; to: number } | null;
      firstPage: number;
      passages: { pageId: string; box: ProblemBox }[];
      figures: { pageId: string; box: ProblemBox }[];
      questions: { pageId: string; box: ProblemBox; no: number | null }[];
    };
    const sets: SetDraft[] = [];
    const loose: SetDraft = { range: null, firstPage: 0, passages: [], figures: [], questions: [] };
    const pageIdx = new Map(ok.map((h, i) => [h.page.id, i] as const));
    for (const h of ok) {
      for (const p of [...h.passages].sort(byOrder)) {
        let cur = sets[sets.length - 1];
        if (p.range || !cur) {
          cur = { range: p.range, firstPage: pageIdx.get(h.page.id) ?? 0, passages: [], figures: [], questions: [] };
          sets.push(cur);
        }
        cur.passages.push({ pageId: h.page.id, box: p.box });
      }
      for (const f of h.figures) {
        const cx = f.x + f.w / 2;
        const cy = f.y + f.h / 2;
        const host = sets.find((st) =>
          st.passages.some(
            (ps) => ps.pageId === h.page.id && cx >= ps.box.x && cx <= ps.box.x + ps.box.w && cy >= ps.box.y && cy <= ps.box.y + ps.box.h,
          ),
        );
        host?.figures.push({ pageId: h.page.id, box: f });
      }
    }
    let lastTarget: SetDraft | null = null;
    for (const h of ok) {
      for (const q of [...h.questions].sort(byOrder)) {
        let target: SetDraft | null = null;
        if (q.no !== null) {
          const cands = sets.filter((st) => st.range && q.no! >= st.range.from && q.no! <= st.range.to);
          const here = pageIdx.get(h.page.id) ?? 0;
          target =
            cands.sort((a, b) => Math.abs(a.firstPage - here) - Math.abs(b.firstPage - here))[0] ?? null;
        } else {
          target = lastTarget;
        }
        lastTarget = target;
        (target ?? loose).questions.push({ pageId: h.page.id, box: q.box, no: q.no });
      }
    }
    const drafts = [...sets.filter((st) => st.passages.length > 0 || st.questions.length > 0), ...(loose.questions.length ? [loose] : [])];

    // ── 세트마다 자르기만 한다 — 저장은 사용자가 확인한 뒤(`commitStaged`) ──
    const out: StagedSet[] = [];
    const failedSets: string[] = [];
    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i];
      const name = d.range ? `${d.range.from}~${d.range.to}번` : d === loose ? "낱개 문항" : `${i + 1}번째`;
      setBusy(`세트 ${i + 1}/${drafts.length} (${name}) 자르는 중...`);
      const passage: Record<string, EditBox[]> = {};
      const question: Record<string, EditBox[]> = {};
      const used = new Set<string>();
      const mk = (box: ProblemBox, group: string): EditBox => {
        const b = { id: crypto.randomUUID(), ...box, group };
        autoIdsRef.current.add(b.id);
        return b;
      };
      for (const ps of d.passages) (passage[ps.pageId] ??= []).push(mk(ps.box, PASSAGE_GROUP));
      for (const f of d.figures) (passage[f.pageId] ??= []).push(mk(f.box, FIGURE_GROUP));
      const groupOf = new Map<number, string>();
      for (const q of d.questions) {
        let g: string;
        if (q.no !== null && d !== loose) {
          g = groupOf.get(q.no) ?? crypto.randomUUID();
          groupOf.set(q.no, g);
        } else g = crypto.randomUUID();
        if (q.no !== null) noByGroupRef.current.set(g, q.no);
        (question[q.pageId] ??= []).push(mk(q.box, g));
      }
      for (const id of [...Object.keys(passage), ...Object.keys(question)]) used.add(id);
      const group = ok.map((h) => h.page).filter((pg) => used.has(pg.id));
      const cut = await cutAll({ passage, question, pages: group, quiet: true, noPassageOverride: d === loose });
      if (!cut || cut.length === 0) {
        failedSets.push(name);
        continue;
      }
      const pc = cut.find((c) => c.kind === "passage");
      const t = pc ? await fetchTitle(pc.crop) : "";
      out.push({ name, pieces: cut, title: t, loose: d === loose || noPassage });
    }
    setBusy(null);
    const notes = [
      pageOrderNote,
      failedPages ? `사진 ${failedPages}장은 자리를 못 찾았어요.` : "",
      failedSets.length ? `못 자른 세트: ${failedSets.join(", ")}.` : "",
    ].filter(Boolean);
    if (out.length > 0) {
      setStaged(out);
      setNote(notes.length ? notes.join(" ") : null);
    } else {
      setError(`자동으로 못 잘랐어요. ${notes.join(" ")} 아래 단계별로 손으로 해주세요.`);
    }
  }

  /** 조각의 AI 자리를 바탕으로 다시 자르기를 연다(새 id 로 복사 — 사람이 고친 자리는 여유를 안 준다). */
  function startRecut(si: number, p: Piece) {
    if (!p.boxes?.length) return;
    const boxes: Record<string, EditBox[]> = {};
    for (const { pageId, box } of p.boxes) (boxes[pageId] ??= []).push({ ...box, id: crypto.randomUUID() });
    setRecut({ si, pid: p.id, kind: p.kind, boxes });
  }

  async function applyRecut() {
    if (!recut) return;
    const pgs = pages.filter((pg) => (recut.boxes[pg.id] ?? []).length > 0);
    const cut = await cutAll(
      recut.kind === "passage"
        ? { passage: recut.boxes, question: {}, pages: pgs, quiet: true, noPassageOverride: false }
        : { passage: {}, question: recut.boxes, pages: pgs, quiet: true },
    );
    const np = cut?.find((c) => c.kind === recut.kind);
    if (!np) {
      setError("다시 자르지 못했어요.");
      return;
    }
    setStaged((prev) =>
      prev
        ? prev.map((d, k) =>
            k === recut.si ? { ...d, pieces: d.pieces.map((p) => (p.id === recut.pid ? np : p)) } : d,
          )
        : prev,
    );
    setRecut(null);
  }

  /** 확인 상자 편집 — 조각 빼기·같은 세트 안 순서 바꾸기·다른 세트로 옮기기. */
  function stagedRemove(si: number, pid: string) {
    setStaged((prev) =>
      prev
        ? prev
            .map((d, k) => (k === si ? { ...d, pieces: d.pieces.filter((p) => p.id !== pid) } : d))
            .filter((d) => d.pieces.length > 0)
        : prev,
    );
  }
  function stagedShift(si: number, pid: string, dir: -1 | 1) {
    setStaged((prev) =>
      prev
        ? prev.map((d, k) => {
            if (k !== si) return d;
            const i = d.pieces.findIndex((p) => p.id === pid);
            const j = i + dir;
            if (i < 0 || j < 0 || j >= d.pieces.length) return d;
            const next = [...d.pieces];
            [next[i], next[j]] = [next[j], next[i]];
            return { ...d, pieces: next };
          })
        : prev,
    );
  }
  function stagedMove(si: number, pid: string, to: number) {
    setStaged((prev) => {
      if (!prev || to === si || !prev[to]) return prev;
      const piece = prev[si].pieces.find((p) => p.id === pid);
      if (!piece || piece.kind === "passage") return prev;
      return prev
        .map((d, k) =>
          k === si
            ? { ...d, pieces: d.pieces.filter((p) => p.id !== pid) }
            : k === to
              ? { ...d, pieces: [...d.pieces, piece] }
              : d,
        )
        .filter((d) => d.pieces.length > 0);
    });
  }

  /** 확인 화면에서 "넣기"를 눌렀을 때만 저장한다. */
  async function commitStaged(regenerate: boolean, passageOnly = false) {
    if (!staged) return;
    let okSets = 0;
    let made = 0;
    const failed: string[] = [];
    for (let i = 0; i < staged.length; i++) {
      const d = staged[i];
      setBusy(`세트 ${i + 1}/${staged.length} (${d.name}) 넣는 중...`);
      const n = await save(regenerate, { pieces: d.pieces, title: d.title, quiet: true, loose: d.loose, passageOnly });
      if (n > 0) {
        okSets += 1;
        made += n;
      } else failed.push(d.name);
    }
    setBusy(null);
    if (okSets > 0) {
      setStaged(null);
      setError(null);
      setNote(
        `${okSets}세트(${made}개)를 ${passageOnly ? "넣었어요 — 지문만 조판하고 문항은 원본 그대로예요" : regenerate ? "넣고 AI 작업을 올렸어요" : "원본 그대로 넣었어요"}.` +
          (failed.length ? ` 못 넣은 세트: ${failed.join(", ")}.` : ""),
      );
      reset();
      onDone?.();
    } else {
      setError(`넣지 못했어요. ${failed.join(", ")}`);
    }
  }

  const stepLabel: Record<Step, string> = {
    pick: "사진 고르기",
    passage: "① 지문 자리 잡기",
    questions: "② 문제 자리 잡기",
    review: "③ 확인하고 넣기",
  };

  const groups = step === "questions" ? questionGroups() : [];
  const groupNo = new Map(groups.map((g, i) => [g.group, i + 1] as const));
  const passageCount = pages.reduce(
    (n, p) => n + (passageBoxes[p.id]?.filter((b) => b.group === PASSAGE_GROUP).length ?? 0),
    0,
  );
  const figureCount = pages.reduce(
    (n, p) => n + (passageBoxes[p.id]?.filter((b) => b.group === FIGURE_GROUP).length ?? 0),
    0,
  );

  return (
    <Card className="flex flex-col gap-3 p-4 sm:p-5">
      <div>
        <h3 className="text-sm font-semibold text-slate-700">
          국어 모드 (지문 + 문항 세트)
          {step !== "pick" && (
            <span className="ml-2 text-xs font-normal text-slate-400">{stepLabel[step]}</span>
          )}
        </h3>
        <p className="mt-1 text-xs text-slate-400">
          지문과 문제를 <b>따로</b> 잡습니다. 네모를 끌어 옮기거나 모서리로 크기를
          고칠 수 있고, 단이나 쪽을 넘어간 문항은 조각마다 그려서 하나로 묶으면
          됩니다.
        </p>
      </div>

      {step === "pick" && (
        <>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => void pickFiles(Array.from(e.target.files ?? []))}
            className="text-sm"
          />
          <p className="text-xs text-slate-400">
            한 지문이 여러 쪽에 걸쳐 있으면 그 쪽들을 <b>모두</b> 고르세요(여러 장
            선택 가능). 고른 차례가 곧 읽는 차례입니다.
          </p>
          {pages.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {pages.map((p, i) => (
                <div key={p.id} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.dataUrl}
                    alt=""
                    className="h-24 w-20 rounded border border-slate-200 object-cover"
 />
                  <span className="absolute left-1 top-1 rounded bg-slate-700 px-1 text-[10px] text-white">
                    {i + 1}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPages((prev) => prev.filter((q) => q.id !== p.id))}
                    className="absolute -right-1 -top-1 h-5 w-5 rounded-full bg-white text-xs shadow ring-1 ring-slate-300 hover:text-red-600"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={noPassage}
              onChange={(e) => setNoPassage(e.target.checked)}
              className="h-4 w-4"
            />
            지문 없는 문항
            <span className="text-xs text-slate-400">
              어휘·문법 단독 문항처럼 지문이 없으면 켜세요. 지문 단계를 건너뜁니다.
            </span>
          </label>
          <Button
            type="button"
            onClick={() => setStep(noPassage ? "questions" : "passage")}
            disabled={pages.length === 0}
            variant="dark" className="self-start"
          >
            다음: {noPassage ? "문제" : "지문"} 자리 잡기
          </Button>
          {unlimited && (
            <div className="flex flex-col gap-2 rounded-lg border border-emerald-200 bg-emerald-50/50 p-3">
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  onClick={() => void dump()}
                  disabled={pages.length === 0 || busy !== null}
                  variant="primary"
                >
                  {busy ?? "자동으로 자르기 (세트별로 한꺼번에)"}
                </Button>
                <Button
                  type="button"
                  onClick={() => void autoCut()}
                  disabled={pages.length === 0 || busy !== null}
                  variant="outline"
                >
                  자동으로 자르고 확인하기
                </Button>
              </div>
              <p className="text-xs text-slate-400">
                사진을 여러 장 골라도 됩니다 — 하이쿠가 사진마다 동시에 지문·문제 자리를 찾고, 지문 위 [1~4] 줄에서 읽은 범위로 세트를 묶어 제목까지 지어 자른 결과를 먼저 보여 드립니다 — 확인하고 넣기를 누르면 저장됩니다(범위가 안 읽힌 문항은 묶지 않고 낱개로).
              </p>
            </div>
          )}
        </>
      )}

      {(step === "passage" || step === "questions") && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-slate-600">
            {step === "passage" ? (
              <>
                지문을 감싸는 네모를 그리세요. 단이나 쪽을 넘어가면 조각마다
                그리면 됩니다 — <b>그린 것 전부가 한 지문</b>으로 이어 붙습니다.
                지문 안에 <b>그림</b>(도표·삽화·그래프)이 있으면 &quot;그림&quot;으로
                바꿔 따로 감싸세요 — 넣을 때 AI 로 다시 그려 그 자리에 붙입니다.
              </>
            ) : (
              <>
                문항마다 네모를 그리세요. 번호부터 선지 마지막 줄까지 넣습니다.
                단·쪽을 넘어간 문항은 조각마다 그린 뒤 <b>이름표를 눌러 고르고</b>
                아래 &quot;고른 것 한 문제로 묶기&quot;를 누르세요.
              </>
            )}
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <CropShapeToggle value={shape} onChange={setShape} />
          {step === "passage" && (
            <div className="flex items-center gap-1 text-xs">
              <span className="text-slate-500">새로 그리는 것:</span>
              {(["passage", "figure"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setDrawKind(k)}
                  className={`rounded-lg border px-2 py-1 ${
                    drawKind === k
                      ? k === "passage"
                        ? "border-emerald-600 bg-emerald-600 text-white"
                        : "border-orange-500 bg-orange-500 text-white"
                      : "border-slate-300 text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {k === "passage" ? "지문" : "그림"}
                </button>
              ))}
            </div>
          )}
          </div>

          {pages.map((page, i) => (
            <div key={page.id} className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-500">{i + 1}번째 사진</span>
              <BoxEditor
                image={page.dataUrl}
                shape={shape}
                boxes={
                  (step === "passage" ? passageBoxes[page.id] : questionBoxes[page.id]) ?? []
                }
                onChange={(next) =>
                  step === "passage"
                    ? setPassageBoxes((prev) => ({ ...prev, [page.id]: next }))
                    : setQuestionBoxes((prev) => ({ ...prev, [page.id]: next }))
                }
                color={step === "passage" ? "#059669" : "#2563eb"}
                colorOf={
                  step === "passage"
                    ? (g) => (g === FIGURE_GROUP ? "#f97316" : "#059669")
                    : undefined
                }
                newGroup={
                  step === "passage"
                    ? drawKind === "figure"
                      ? FIGURE_GROUP
                      : PASSAGE_GROUP
                    : undefined
                }
                labelOf={
                  step === "passage"
                    ? (g) => (g === FIGURE_GROUP ? "그림" : "지문")
                    : (g) => {
                        const n = groupNo.get(g);
                        const size = groups.find((x) => x.group === g)?.boxes.length ?? 1;
                        return size > 1 ? `${n}번째 (${size}조각)` : `${n}번째`;
                      }
                }
                picked={step === "questions" ? picked : undefined}
                onPick={
                  step === "questions"
                    ? (g) =>
                        setPicked((prev) => {
                          const next = new Set(prev);
                          if (next.has(g)) next.delete(g);
                          else next.add(g);
                          return next;
                        })
                    : undefined
                }
              />
            </div>
          ))}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={() => void autoFill(step === "passage" ? "passage" : "question")}
              disabled={busy !== null}
              variant="outline" size="sm"
            >
              {busy ?? "자동으로 찾기"}
            </Button>
            {step === "questions" && (
              <>
                <button
                  type="button"
                  onClick={mergePicked}
                  disabled={picked.size < 2}
                  className="rounded-lg border border-amber-400 bg-amber-50 px-3 py-1.5 text-sm text-amber-800 hover:bg-amber-100 disabled:opacity-40"
                >
                  고른 것 한 문제로 묶기 ({picked.size})
                </button>
                <Button
                  type="button"
                  onClick={splitPicked}
                  disabled={picked.size === 0}
                  variant="outline" size="sm"
 >
                  묶음 풀기
                </Button>
              </>
            )}
            <span className="text-xs text-slate-400">
              {step === "passage"
                ? `조각 ${passageCount}개${figureCount ? ` · 그림 ${figureCount}개` : ""}`
                : `문항 ${groups.length}개`}
              {!unlimited && " · 자동 찾기는 무제한 계정 전용"}
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() =>
                step === "passage" ? setStep("pick") : setStep(noPassage ? "pick" : "passage")
              }
              variant="outline"
            >
              ← 뒤로
            </Button>
            {step === "passage" ? (
              <Button
                type="button"
                onClick={() => setStep("questions")}
                disabled={passageCount === 0}
                variant="dark"
              >
                다음: 문제 자리 잡기
              </Button>
            ) : (
              <Button
                type="button"
                onClick={() => void cutAll()}
                disabled={groups.length === 0 || busy !== null}
                variant="dark"
              >
                {busy ?? "다음: 확인하기"}
              </Button>
            )}
          </div>
        </div>
      )}

      {step === "review" && (
        <div className="flex flex-col gap-3">
          {!noPassage && (
            <label className="flex flex-col gap-1 text-sm text-slate-700">
              지문 제목 (첫 장 목차에 적힙니다)
              <div className="flex gap-2">
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="예: 이중차분법"
                  className="flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                />
                <Button
                  type="button"
                  onClick={() =>
                    passageCropRef.current && void makeTitle(passageCropRef.current)
                  }
                  disabled={titling || !passageCropRef.current}
                  variant="outline" size="sm" className="shrink-0"
                >
                  {titling ? "짓는 중..." : "다시 짓기"}
                </Button>
              </div>
              {titleNote && <span className="text-xs text-slate-400">{titleNote}</span>}
              {/* 제목이 비면 첫 장 목차에 그냥 "지문" 으로 찍힌다 — 목차의
                  쓸모가 통째로 사라지므로 넣기 전에 채우게 한다. */}
              {!title.trim() && !titling && (
                <span className="text-xs text-amber-700">
                  제목이 비어 있으면 목차에 &quot;지문&quot;으로만 찍힙니다. 적어주세요.
                </span>
              )}
            </label>
          )}

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {pieces.map((p, i) => (
              <div
                key={p.id}
                className={`rounded border p-1 ${
                  p.kind === "passage" ? "border-emerald-400 bg-emerald-50" : "border-slate-200"
                }`}
 >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.crop} alt="" className="h-32 w-full object-contain" />
                <p className="mt-1 text-center text-xs text-slate-500">
                  {p.kind === "passage" ? "지문" : `${i + (noPassage ? 1 : 0)}번째 문제`}
                  {p.parts > 1 && ` · ${p.parts}조각 합침`}
                  {p.figures?.length ? ` · 그림 ${p.figures.length}개` : ""}
                </p>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => setStep("questions")}
              disabled={busy !== null}
              variant="outline"
            >
              ← 자리 고치기
            </Button>
            <Button
              type="button"
              onClick={() => void save(false)}
              disabled={busy !== null}
              variant="outline"
            >
              {busy ?? "원본 그대로 넣기"}
            </Button>
            <Button
              type="button"
              onClick={() => void save(true, { pieces, title, passageOnly: true })}
              disabled={busy !== null}
              variant="outline"
            >
              {busy ?? "문항은 그대로 · 지문만 조판"}
            </Button>
            <Button
              type="button"
              onClick={() => void save(true)}
              disabled={busy !== null}
              variant="primary"
            >
              {busy ?? "모두 AI로 다시 그리기"}
              {typeof figureCost === "number" &&
                !unlimited &&
                !byok &&
                ` (최대 ${
                  figureCost *
                    (pieces.filter((p) => p.kind === "question").length +
                      pieces.reduce((n, p) => n + (p.figures?.length ?? 0), 0)) +
                  (pieces.some((p) => p.kind === "passage") && !noPassage
                    ? PASSAGE_READ_TOKENS + PASSAGE_MARKS_DEPOSIT
                    : 0)
                }토큰)`}
            </Button>
          </div>
        </div>
      )}

      {staged && (
        <div className="flex flex-col gap-3 rounded-lg border border-emerald-300 bg-emerald-50/40 p-3">
          <p className="text-sm font-medium text-slate-700">
            자동으로 자른 결과 — 확인하고 넣으세요 ({staged.length}세트)
          </p>
          {staged.map((d, si) => (
            <div key={si} className="flex flex-col gap-2 rounded border border-slate-200 bg-white p-2">
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span className="font-semibold">{d.name}</span>
                {!d.loose && (
                  <input
                    value={d.title}
                    onChange={(e) =>
                      setStaged((prev) => prev && prev.map((x, k) => (k === si ? { ...x, title: e.target.value } : x)))
                    }
                    placeholder="지문 제목"
                    className="flex-1 rounded border border-slate-300 px-2 py-1 text-sm"
                  />
                )}
                <button
                  type="button"
                  onClick={() => setStaged((prev) => (prev ? prev.filter((_, k) => k !== si) : prev))}
                  className="text-red-600 hover:underline"
                >
                  이 세트 빼기
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {d.pieces.map((p, i) => (
                  <div key={p.id} className={`rounded border p-1 ${p.kind === "passage" ? "border-emerald-400 bg-emerald-50" : "border-slate-200"}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.crop} alt="" className="h-32 w-full object-contain" />
                    <p className="mt-1 text-center text-xs text-slate-500">
                      {p.kind === "passage" ? "지문" : `${p.no != null ? `${p.no}번` : `${i + (d.pieces[0]?.kind === "passage" ? 0 : 1)}번째`} 문제`}
                      {p.parts > 1 && ` · ${p.parts}조각 합침`}
                    </p>
                    <div className="mt-1 flex items-center justify-center gap-1 text-xs">
                      <button type="button" title="앞으로" onClick={() => stagedShift(si, p.id, -1)} disabled={i === 0} className="rounded border px-1.5 disabled:opacity-30">◀</button>
                      <button type="button" title="뒤로" onClick={() => stagedShift(si, p.id, 1)} disabled={i === d.pieces.length - 1} className="rounded border px-1.5 disabled:opacity-30">▶</button>
                      <button type="button" title="빼기" onClick={() => stagedRemove(si, p.id)} className="rounded border px-1.5 text-red-600">×</button>
                    </div>
                    {p.boxes?.length ? (
                      <button type="button" onClick={() => startRecut(si, p)} className="mt-1 w-full rounded border border-amber-400 bg-amber-50 px-1 text-xs text-amber-800">
                        다시 자르기
                      </button>
                    ) : null}
                    {p.kind === "question" && staged.length > 1 && (
                      <select
                        value=""
                        onChange={(e) => e.target.value !== "" && stagedMove(si, p.id, Number(e.target.value))}
                        className="mt-1 w-full rounded border border-slate-300 text-xs"
                      >
                        <option value="">세트 옮기기…</option>
                        {staged.map((o, oi) => oi !== si && <option key={oi} value={oi}>{o.name}</option>)}
                      </select>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
          {recut && (
            <div className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-white p-2">
              <p className="text-sm text-slate-600">
                AI 가 자른 자리예요. 네모를 끌어 옮기거나 모서리로 크기를 고치고, 빈 곳을 끌어 조각을 더 그릴 수 있어요(지문은 그린 것 전부가, 문제는 이 문항의 조각이 이어 붙어요).
              </p>
              {Object.keys(recut.boxes).map((pid) => {
                const pg = pages.find((x) => x.id === pid);
                if (!pg) return null;
                const gid = recut.kind === "question" ? recut.boxes[pid][0]?.group : undefined;
                return (
                  <BoxEditor
                    key={pid}
                    image={pg.dataUrl}
                    shape={shape}
                    boxes={recut.boxes[pid] ?? []}
                    onChange={(next) => setRecut((r) => (r ? { ...r, boxes: { ...r.boxes, [pid]: next } } : r))}
                    color={recut.kind === "passage" ? "#059669" : "#2563eb"}
                    colorOf={recut.kind === "passage" ? (g) => (g === FIGURE_GROUP ? "#f97316" : "#059669") : undefined}
                    newGroup={recut.kind === "passage" ? PASSAGE_GROUP : gid ?? Object.values(recut.boxes).flat()[0]?.group}
                    labelOf={() => (recut.kind === "passage" ? "지문" : "문항")}
                  />
                );
              })}
              <div className="flex gap-2">
                <Button type="button" variant="primary" onClick={() => void applyRecut()} disabled={busy !== null}>
                  {busy ?? "이 자리로 다시 자르기"}
                </Button>
                <Button type="button" variant="outline" onClick={() => setRecut(null)} disabled={busy !== null}>
                  취소
                </Button>
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => setStaged(null)} disabled={busy !== null}>
              취소 (손으로 하기)
            </Button>
            <Button type="button" variant="outline" onClick={() => void commitStaged(false)} disabled={busy !== null || staged.length === 0}>
              {busy ?? "원본 그대로 넣기"}
            </Button>
            <Button type="button" variant="outline" onClick={() => void commitStaged(true, true)} disabled={busy !== null || staged.length === 0}>
              {busy ?? "문항은 그대로 · 지문만 조판"}
            </Button>
            <Button type="button" variant="primary" onClick={() => void commitStaged(true)} disabled={busy !== null || staged.length === 0}>
              {busy ?? "모두 AI로 다시 그리기"}
            </Button>
          </div>
        </div>
      )}

      {note && <p className="text-sm text-emerald-700">{note}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </Card>
  );
}
