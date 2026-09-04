"use client";

import { useRef, useState } from "react";
import { cropImageToDataUrl, fileToDataUrl, isHeicFile, loadImage } from "@/lib/cropImage";
import {
  DETECT_INPUT_DIM,
  MAX_UPLOAD_CHARS,
  PROBLEM_INPUT_DIM,
  PROBLEM_MAX_HEIGHT,
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
import { useFigureJobs } from "./FigureJobsProvider";
import BoxEditor, { type EditBox } from "./BoxEditor";

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
const PAD = 0.004;

/** 지문 네모는 전부 이 묶음에 들어간다(그린 것이 곧 한 지문이다). */
const PASSAGE_GROUP = "passage";

type Step = "pick" | "passage" | "questions" | "review";

type Page = { id: string; file: File | null; dataUrl: string };

type Piece = { id: string; kind: "passage" | "question"; crop: string; parts: number };

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
  /** 문제 하나를 다시 그리는 데 드는 토큰. 서버가 알려준 값을 그대로 쓴다. */
  figureCost?: number | null;
  onDone?: () => void;
};

export default function KoreanModePanel({
  onSave,
  unlimited = false,
  figureCost,
  onDone,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const { enqueue } = useFigureJobs();

  const [step, setStep] = useState<Step>("pick");
  const [pages, setPages] = useState<Page[]>([]);
  /** 쪽(사진) id → 그 쪽에 그린 네모들. */
  const [passageBoxes, setPassageBoxes] = useState<Record<string, EditBox[]>>({});
  const [questionBoxes, setQuestionBoxes] = useState<Record<string, EditBox[]>>({});
  /** 합치기용으로 고른 묶음들. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  /** 자동으로 찾은 결과(쪽마다). 한 번만 부르고 두 단계가 나눠 쓴다. */
  const detectedRef = useRef<Record<string, DetectedKoreanRegion[]>>({});
  /** 자동으로 찾은 자리를 사람이 안 건드렸으면 여유(PAD)를 준다. */
  const autoIdsRef = useRef<Set<string>>(new Set());

  const [pieces, setPieces] = useState<Piece[]>([]);
  const [title, setTitle] = useState("");
  const [titleNote, setTitleNote] = useState<string | null>(null);
  const [noPassage, setNoPassage] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

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
  async function openSource(page: Page): Promise<{ img: HTMLImageElement; revoke: () => void }> {
    if (page.file) {
      const url = URL.createObjectURL(page.file);
      try {
        return { img: await loadImage(url), revoke: () => URL.revokeObjectURL(url) };
      } catch {
        URL.revokeObjectURL(url);
      }
    }
    return { img: await loadImage(page.dataUrl), revoke: () => {} };
  }

  function cutBox(img: HTMLImageElement, b: ProblemBox, pad: number): string {
    const x = Math.max(0, b.x - pad) * img.naturalWidth;
    const y = Math.max(0, b.y - pad) * img.naturalHeight;
    const w = Math.min(1 - b.x + pad, b.w + pad * 2) * img.naturalWidth;
    const h = Math.min(1 - b.y + pad, b.h + pad * 2) * img.naturalHeight;
    return cropImageToDataUrl(
      img,
      { x, y, width: w, height: h },
      { maxWidth: PROBLEM_INPUT_DIM, maxHeight: PROBLEM_MAX_HEIGHT },
    );
  }

  /**
   * 영역을 찾을 때 보낼 이미지. **원본에서 만들되 요청 상한에 맞춰 줄인다**
   * (Vercel 4.5MB). 배치 패널과 같은 방식이다.
   */
  async function detectImage(img: HTMLImageElement): Promise<string> {
    const whole = { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight };
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
   * **사진 한 장에 한 번만 부르고 결과를 들고 있는다** — 지문 단계와 문제
   * 단계가 같은 결과를 나눠 쓴다(따로 부르면 값이 두 배다).
   */
  async function autoFill(kind: "passage" | "question") {
    setError(null);
    let failed = 0;
    for (const page of pages) {
      if (detectedRef.current[page.id]) continue;
      setBusy(`자리를 찾는 중... (${pages.indexOf(page) + 1}/${pages.length})`);
      let source: { img: HTMLImageElement; revoke: () => void };
      try {
        source = await openSource(page);
      } catch {
        failed += 1;
        continue;
      }
      try {
        const res = await fetch("/api/detect-problems", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: await detectImage(source.img), mode: "korean" }),
        });
        const json = (await res.json()) as { regions?: DetectedKoreanRegion[]; error?: string };
        if (!res.ok) throw new Error(json.error ?? "자리 인식에 실패했습니다.");
        detectedRef.current[page.id] = json.regions ?? [];
      } catch (err) {
        setError(err instanceof Error ? err.message : "자리 인식에 실패했습니다.");
        setBusy(null);
        source.revoke();
        return;
      } finally {
        source.revoke();
      }
    }
    setBusy(null);
    if (failed === pages.length) {
      setError("사진을 열지 못했습니다.");
      return;
    }

    const next: Record<string, EditBox[]> = {};
    let any = false;
    for (const page of pages) {
      const found = (detectedRef.current[page.id] ?? []).filter((r) => r.kind === kind);
      // 읽는 차례로 늘어놓는다 — 모델이 순서를 지키지 않는 경우가 있는데,
      // 잡은 차례가 곧 문제 차례다.
      const sorted = [...found].sort((a, b) => {
        const col = (r: DetectedKoreanRegion) => (r.box.x + r.box.w / 2 < 0.5 ? 0 : 1);
        return col(a) - col(b) || a.box.y - b.box.y;
      });
      const boxes = sorted.map((r) => ({
        id: crypto.randomUUID(),
        ...r.box,
        // 지문은 그린 것이 전부 한 덩어리다. 문제는 조각마다 따로 잡고
        // 이어진 것만 사용자가 묶는다 — 자동으로 묶으면 서로 다른 문항을
        // 하나로 삼켜 문제가 사라진다(지면 분할에서 실제로 겪은 사고다).
        group: kind === "passage" ? PASSAGE_GROUP : crypto.randomUUID(),
      }));
      for (const b of boxes) autoIdsRef.current.add(b.id);
      if (boxes.length > 0) any = true;
      next[page.id] = boxes;
    }
    if (!any) {
      setError(
        kind === "passage"
          ? "지문을 찾지 못했어요. 손으로 네모를 그려주세요."
          : "문제를 찾지 못했어요. 손으로 네모를 그려주세요.",
      );
      return;
    }
    if (kind === "passage") setPassageBoxes(next);
    else setQuestionBoxes(next);
  }

  /** 문제 단계의 묶음들을 **그린 차례**로 늘어놓는다. */
  function questionGroups(): { group: string; boxes: { page: Page; box: EditBox }[] }[] {
    const order: string[] = [];
    const byGroup = new Map<string, { page: Page; box: EditBox }[]>();
    for (const page of pages) {
      for (const box of questionBoxes[page.id] ?? []) {
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
  async function cutAll() {
    setError(null);
    setBusy("사진을 여는 중...");
    // 쪽마다 한 번만 열고 다 자를 때까지 들고 있는다(여러 번 열면 느리다).
    const opened: { page: Page; img: HTMLImageElement; revoke: () => void }[] = [];
    try {
      for (const page of pages) {
        const s = await openSource(page);
        opened.push({ page, ...s });
      }
    } catch (err) {
      opened.forEach((o) => o.revoke());
      setError(err instanceof Error ? err.message : "사진을 열지 못했습니다.");
      setBusy(null);
      return;
    }

    try {
      setBusy("자르는 중...");
      const imgOf = new Map(opened.map((o) => [o.page.id, o.img] as const));
      // 손으로 고친 자리에는 여유를 주지 않는다(사용자가 정한 자리다).
      const pad = (b: EditBox) => (autoIdsRef.current.has(b.id) ? PAD : 0);
      const cut: Piece[] = [];

      if (!noPassage) {
        // 지문은 그린 것 전부가 한 덩어리다. 단을 넘든 쪽을 넘든 어차피 글이라
        // 이어 붙여도 티가 안 난다.
        const parts: string[] = [];
        for (const page of pages) {
          for (const b of passageBoxes[page.id] ?? []) {
            parts.push(cutBox(imgOf.get(page.id)!, b, pad(b)));
          }
        }
        if (parts.length > 0) {
          cut.push({
            id: crypto.randomUUID(),
            kind: "passage",
            crop: await stitchVertically(parts),
            parts: parts.length,
          });
        }
      }

      for (const g of questionGroups()) {
        const parts = g.boxes.map(({ page, box }) => cutBox(imgOf.get(page.id)!, box, pad(box)));
        cut.push({
          id: crypto.randomUUID(),
          kind: "question",
          crop: await stitchVertically(parts),
          parts: parts.length,
        });
      }

      setPieces(cut);
      setStep("review");
      const passage = cut.find((p) => p.kind === "passage");
      if (passage) void makeTitle(passage.crop);
    } catch (err) {
      setError(
        "사진을 자르지 못했습니다: " + (err instanceof Error ? err.message : "알 수 없는 오류"),
      );
    } finally {
      opened.forEach((o) => o.revoke());
      setBusy(null);
    }
  }

  /** Mathpix 로 지문을 읽고 그 **글자만** 보내 제목을 짓는다. */
  async function makeTitle(passageCrop: string) {
    setTitleNote("제목을 짓는 중...");
    try {
      const ocr = await fetch("/api/mathpix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: await enhanceContrast(passageCrop) }),
      });
      const read = (await ocr.json()) as { text?: string; latex?: string; error?: string };
      if (!ocr.ok) throw new Error(read.error ?? "지문을 읽지 못했습니다.");
      const text = (read.text || read.latex || "").trim();
      if (text.length < 20) throw new Error("지문 글자가 거의 인식되지 않았습니다.");

      const res = await fetch("/api/korean-title", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const json = (await res.json()) as { title?: string; kind?: string; error?: string };
      if (!res.ok || !json.title) throw new Error(json.error ?? "제목을 짓지 못했습니다.");
      setTitle(json.title);
      setTitleNote(`${json.kind ?? ""} 지문으로 보고 지었어요. 고쳐도 됩니다.`);
    } catch (err) {
      // 제목이 없어도 넣을 수는 있어야 한다. 사용자가 직접 적으면 된다.
      setTitleNote(
        (err instanceof Error ? err.message : "제목을 짓지 못했습니다.") + " 직접 적어주세요.",
      );
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
   * 저장한다. `regenerate` 면 AI 재생성 큐에도 넣는다.
   *
   * **저장을 먼저 한다.** 그래야 행 id 를 큐에 함께 넘길 수 있고, 브라우저를
   * 닫아도 서버가 결과를 그 행에 직접 저장한다(`persistWholeProblem`).
   */
  async function save(regenerate: boolean) {
    if (pieces.length === 0) return;
    setError(null);
    setNote(null);
    // 한 세트는 지문 하나와 그 문항들이다. 지문 없는 문항이면 묶지 않는다.
    const setId = crypto.randomUUID();
    let done = 0;
    let qIndex = 0;

    for (const piece of pieces) {
      setBusy(`넣는 중... (${done + 1}/${pieces.length})`);
      try {
        const { figure, pngDataUrl } = await toCard(piece);
        const korean = noPassage
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

        if (regenerate) {
          enqueue({
            id: piece.id,
            problemKey: `korean:${problemId}`,
            label: piece.kind === "passage" ? "지문" : `${qIndex}번째 문제`,
            crop: piece.crop,
            mode: "problem",
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
    if (done > 0) {
      setNote(
        regenerate
          ? `${done}개를 넣고 AI 재생성 큐에 올렸어요. 진행 상황은 화면 구석에서 볼 수 있어요.`
          : `${done}개를 원본 그대로 넣었어요.`,
      );
      reset();
      onDone?.();
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
  const passageCount = pages.reduce((n, p) => n + (passageBoxes[p.id]?.length ?? 0), 0);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4">
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
          <button
            type="button"
            onClick={() => setStep(noPassage ? "questions" : "passage")}
            disabled={pages.length === 0}
            className="self-start rounded-lg bg-slate-700 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            다음: {noPassage ? "문제" : "지문"} 자리 잡기
          </button>
        </>
      )}

      {(step === "passage" || step === "questions") && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-slate-600">
            {step === "passage" ? (
              <>
                지문을 감싸는 네모를 그리세요. 단이나 쪽을 넘어가면 조각마다
                그리면 됩니다 — <b>그린 것 전부가 한 지문</b>으로 이어 붙습니다.
              </>
            ) : (
              <>
                문항마다 네모를 그리세요. 번호부터 선지 마지막 줄까지 넣습니다.
                단·쪽을 넘어간 문항은 조각마다 그린 뒤 <b>이름표를 눌러 고르고</b>
                아래 &quot;고른 것 한 문제로 묶기&quot;를 누르세요.
              </>
            )}
          </p>

          {pages.map((page, i) => (
            <div key={page.id} className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-500">{i + 1}번째 사진</span>
              <BoxEditor
                image={page.dataUrl}
                boxes={
                  (step === "passage" ? passageBoxes[page.id] : questionBoxes[page.id]) ?? []
                }
                onChange={(next) =>
                  step === "passage"
                    ? setPassageBoxes((prev) => ({ ...prev, [page.id]: next }))
                    : setQuestionBoxes((prev) => ({ ...prev, [page.id]: next }))
                }
                color={step === "passage" ? "#059669" : "#2563eb"}
                newGroup={step === "passage" ? PASSAGE_GROUP : undefined}
                labelOf={
                  step === "passage"
                    ? () => "지문"
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
            <button
              type="button"
              onClick={() => void autoFill(step === "passage" ? "passage" : "question")}
              disabled={busy !== null}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {busy ?? "자동으로 찾기"}
            </button>
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
                <button
                  type="button"
                  onClick={splitPicked}
                  disabled={picked.size === 0}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                >
                  묶음 풀기
                </button>
              </>
            )}
            <span className="text-xs text-slate-400">
              {step === "passage" ? `조각 ${passageCount}개` : `문항 ${groups.length}개`}
              {!unlimited && " · 자동 찾기는 무제한 계정 전용"}
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() =>
                step === "passage" ? setStep("pick") : setStep(noPassage ? "pick" : "passage")
              }
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
            >
              ← 뒤로
            </button>
            {step === "passage" ? (
              <button
                type="button"
                onClick={() => setStep("questions")}
                disabled={passageCount === 0}
                className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                다음: 문제 자리 잡기
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void cutAll()}
                disabled={groups.length === 0 || busy !== null}
                className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {busy ?? "다음: 확인하기"}
              </button>
            )}
          </div>
        </div>
      )}

      {step === "review" && (
        <div className="flex flex-col gap-3">
          {!noPassage && (
            <label className="flex flex-col gap-1 text-sm text-slate-700">
              지문 제목 (첫 장 목차에 적힙니다)
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="예: 이중차분법"
                className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
              />
              {titleNote && <span className="text-xs text-slate-400">{titleNote}</span>}
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
                </p>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setStep("questions")}
              disabled={busy !== null}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
            >
              ← 자리 고치기
            </button>
            <button
              type="button"
              onClick={() => void save(false)}
              disabled={busy !== null}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {busy ?? "원본 그대로 넣기"}
            </button>
            <button
              type="button"
              onClick={() => void save(true)}
              disabled={busy !== null}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ?? "모두 AI로 다시 그리기"}
              {typeof figureCost === "number" && ` (약 ${figureCost * pieces.length}토큰)`}
            </button>
          </div>
        </div>
      )}

      {note && <p className="text-sm text-emerald-700">{note}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
