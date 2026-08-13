"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toPng } from "html-to-image";
import { createClient } from "@/lib/supabase/client";
import {
  renderMathTextWithInfo,
  toBoxRanges,
  type BoxOverride,
} from "@/lib/renderMathText";
import {
  readStoredFigures,
  restoreCardFigures,
  toStoredFigures,
  type StoredFigure,
} from "@/lib/storedFigures";
import { DEFAULT_FONT_PT, ptToPx } from "@/lib/fontSize";
import FontSizeControl from "./FontSizeControl";
import { CARD_CAPTURE_OPTIONS, PROBLEM_CARD_WIDTH } from "@/lib/layout";
import BoxRangeEditor from "./BoxRangeEditor";
import TextEditTabs from "./TextEditTabs";
import DiagramAdjuster, {
  DEFAULT_DIAGRAM_LAYOUT,
} from "./DiagramAdjuster";
import { DEFAULT_TABLE_LAYOUT } from "@/lib/diagramLayout";
import DraggableCard from "./DraggableCard";
import DiagramCropModal from "./DiagramCropModal";
import { useFigureJobs } from "./FigureJobsProvider";
import { rasterFromSvg, rasterToSvg } from "@/lib/figureImage";
import {
  ANSWER_TYPE_LABEL,
  formatAnswer,
  toAnswerType,
  type AnswerType,
} from "@/lib/answer";

export type GalleryProblem = {
  id: string;
  imageUrl: string;
  imagePath: string;
  text: string;
  sortOrder: number | null;
  answer: string;
  answerType: AnswerType;
  boxRange: BoxOverride | null;
  /** 저장된 글자 크기(pt). */
  fontPt: number;
};

/** 같은 폴더 안에 새 파일명을 만든다. (덮어쓰기 대신 새 오브젝트로 저장) */
function siblingPath(imagePath: string): string {
  const dir = imagePath.split("/").slice(0, -1).join("/");
  return `${dir}/${crypto.randomUUID()}.png`;
}

type Props = {
  problems: GalleryProblem[];
};

/**
 * 화면에 실제로 그려진(보이는) 노드를 PNG Blob으로 캡처한다.
 * iOS Safari는 화면 밖/투명 요소나 첫 toPng 호출에서 빈 이미지를 내놓는
 * 경우가 있어, 이미 렌더된 요소를 대상으로 여러 번 호출해 안정화한다.
 */
async function captureNode(node: HTMLElement): Promise<Blob> {
  if (document.fonts?.ready) {
    await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2000))]);
  }
  // 다음 페인트까지 기다린다.
  await new Promise((r) => requestAnimationFrame(() => r(null)));

  let dataUrl = "";
  // Safari 첫 렌더가 비는 문제 대비로 몇 번 반복(마지막 결과 사용).
  for (let i = 0; i < 3; i++) {
    dataUrl = await toPng(node, CARD_CAPTURE_OPTIONS);
  }
  return await (await fetch(dataUrl)).blob();
}

/**
 * 자리 번호 칸. **숫자를 직접 적어 그 자리로 보낼 수 있다.**
 *
 * 화살표만으로는 20번을 1번으로 보내려면 열아홉 번을 눌러야 한다.
 * 적은 값은 Enter 나 칸을 벗어날 때 반영하고, 실제 자리가 바뀌면 그 값으로
 * 되돌린다(범위를 벗어난 값을 적었을 때 화면과 어긋나지 않게).
 */
function OrderInput({
  index,
  total,
  disabled,
  onCommit,
}: {
  index: number;
  total: number;
  disabled: boolean;
  onCommit: (to: number) => void;
}) {
  const [draft, setDraft] = useState(String(index + 1));
  useEffect(() => setDraft(String(index + 1)), [index]);

  function commit() {
    const n = Number.parseInt(draft, 10);
    if (!Number.isFinite(n) || n === index + 1) {
      setDraft(String(index + 1));
      return;
    }
    onCommit(Math.min(Math.max(n, 1), total) - 1);
    // 옮겨지면 index 가 바뀌어 위 이펙트가 새 번호를 넣어 준다. **안 바뀌는
    // 경우**(자리가 그대로거나 저장에 실패해 되돌아간 경우)에도 칸에 적어 둔
    // 값이 남아 있으면 화면과 어긋나므로 여기서 원래 번호로 되돌린다.
    setDraft(String(index + 1));
  }

  return (
    <label className="flex shrink-0 items-center gap-1 text-xs text-slate-400">
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ""))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setDraft(String(index + 1));
        }}
        disabled={disabled}
        inputMode="numeric"
        aria-label="자리 번호"
        className="w-10 rounded border border-slate-300 px-1 py-0.5 text-center text-xs text-ink focus:border-blue-500 focus:outline-none disabled:opacity-40"
      />
      번
    </label>
  );
}

export default function ProblemGallery({ problems }: Props) {
  const router = useRouter();
  const [list, setList] = useState<GalleryProblem[]>(problems);
  const [busyId, setBusyId] = useState<string | null>(null);
  /**
   * 카드로 볼지 목록으로 볼지.
   *
   * 순서를 바꿀 때는 카드가 불편하다 — 한 화면에 두세 개밖에 안 들어와서 멀리
   * 보내려면 계속 스크롤해야 한다. 목록은 한 줄에 하나씩이라 한눈에 들어오고,
   * 자리 번호를 직접 적어 곧바로 보낼 수도 있다.
   */
  const [view, setView] = useState<"card" | "list">("card");
  useEffect(() => {
    const saved = window.localStorage.getItem("gallery-view");
    if (saved === "list" || saved === "card") setView(saved);
  }, []);
  function pickView(next: "card" | "list") {
    setView(next);
    window.localStorage.setItem("gallery-view", next);
  }
  const [editing, setEditing] = useState<GalleryProblem | null>(null);
  const [editText, setEditText] = useState("");
  const [editAnswer, setEditAnswer] = useState("");
  const [editAnswerType, setEditAnswerType] = useState<AnswerType>("choice");
  // undefined = 자동 감지에 맡김. 그 외는 사용자가 직접 정한 범위.
  const [editBox, setEditBox] = useState<BoxOverride | undefined>(undefined);
  const [editFontPt, setEditFontPt] = useState(DEFAULT_FONT_PT);
  // 저장돼 있던 그림들. 목록 조회에는 들어 있지 않아서(용량 때문에) 수정할
  // 문제 하나만 따로 가져온다.
  const [editFigures, setEditFigures] = useState<StoredFigure[]>([]);
  const [figuresLoading, setFiguresLoading] = useState(false);
  /**
   * 그림 정보가 없는 옛 문제인가.
   *
   * 예전에는 그림을 저장하지 않아서, 그런 문제를 여기서 고쳐 저장하면 원래
   * 붙어 있던 그림이 통째로 사라진다. 되살릴 방법이 없으므로 알려만 준다.
   */
  const [maybeLostFigures, setMaybeLostFigures] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  /**
   * 오려내기 창을 무엇 때문에 열었는가.
   *   add   : 새 그림을 붙인다(새로 찍은 사진에서 오려낸다).
   *   recrop: 이미 붙어 있는 그림을 다시 오려낸다(그 그림 자체가 재료다).
   */
  const [cropTarget, setCropTarget] = useState<
    { mode: "add" } | { mode: "recrop"; id: string; src: string } | null
  >(null);

  // AI 그림 작업은 화면 바깥(FigureJobsProvider)에서 돈다 — 인식 화면과 같은
  // 큐를 쓴다. 수정 창을 닫아도 작업은 계속 돌고, 끝나면 저장본이 갱신된다.
  const { jobs, enqueue, dismiss, putSnapshot } = useFigureJobs();

  // 미리보기에 그릴 것들. 표는 본문에서 다시 뽑고(본문을 고치면 따라 바뀐다)
  // 저장돼 있던 자리·크기만 입힌다.
  const blocks = useMemo(
    () => renderMathTextWithInfo(editText, editBox).blocks,
    [editText, editBox],
  );
  /**
   * 본문 글자가 없는 문제인가("통째로 AI로 다시 그리기"로 만든 것).
   * 그림 한 장이 곧 문제라, 본문 수정·조건 박스는 다룰 대상이 없다.
   */
  const isImageOnly = (editing?.text ?? "").trim() === "";
  const cardFigures = useMemo(
    () => restoreCardFigures(editFigures, blocks),
    [editFigures, blocks],
  );

  /**
   * 끌어 옮긴 결과를 저장할 목록에 반영한다.
   *
   * 표는 아직 저장된 적이 없을 수 있다(원래 자리 그대로 뒀던 표). 그때는
   * 지금 화면 상태를 바탕으로 새로 넣어준다.
   */
  function updateFigure(id: string, patch: Partial<StoredFigure>) {
    setEditFigures((prev) => {
      const i = prev.findIndex((f) => f.id === id);
      if (i !== -1) {
        const next = [...prev];
        next[i] = { ...next[i], ...patch };
        return next;
      }
      const cur = cardFigures.find((f) => f.id === id);
      if (!cur) return prev;
      return [
        ...prev,
        {
          id,
          layout: cur.layout,
          position: cur.position,
          kind: cur.kind,
          row: cur.row,
          ...patch,
        },
      ];
    });
  }

  /**
   * 새로 붙인 그림이 갈 자리. 자리 목록의 범위를 벗어나면 맨 아래로 본다
   * (`CardFigure.position`). 붙인 뒤 미리보기에서 끌어 옮기면 실제 자리가 잡힌다.
   */
  const BOTTOM = 9999;

  /** 이 문제를 가리키는 키. 큐가 결과를 어느 문제로 돌려줄지 아는 데 쓴다. */
  const problemKey = editing ? `edit:${editing.id}` : "";

  /**
   * 큐에 넣는다.
   *
   * **같은 id 를 두 번 넣을 수 없으므로**(중복 과금을 막는 자리다) 다시 그릴
   * 때는 먼저 옛 작업을 목록에서 지운다.
   */
  function requestRedraw(id: string, crop: string) {
    dismiss(id);
    enqueue({ id, problemKey, label: editing?.text?.slice(0, 20) || "수정 중인 문제", crop });
  }

  /** 오려낸 그림을 붙인다(원본 그대로). AI 는 그 뒤에 따로 요청한다. */
  async function attachCrop(crop: string) {
    const target = cropTarget;
    const markup = await rasterToSvg(crop);
    if (target?.mode === "recrop") {
      // 다시 오려낸 것은 **원본 픽셀**이므로 AI 표시를 떼어 다시 그릴 수 있게 한다.
      updateFigure(target.id, { markup, ai: false });
    } else {
      setEditFigures((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          markup,
          layout: DEFAULT_DIAGRAM_LAYOUT,
          position: BOTTOM,
          kind: "figure",
          row: false,
        },
      ]);
    }
    setCropTarget(null);
  }

  // 뒤에서 돌던 AI 작업이 끝나면 그 자리를 완성된 그림으로 갈아끼운다.
  useEffect(() => {
    const done = jobs.filter((j) => j.status === "done" && j.svg);
    if (!done.length) return;
    setEditFigures((prev) => {
      let changed = false;
      const next = prev.map((f) => {
        const j = done.find((d) => d.id === f.id);
        if (!j?.svg || j.svg === f.markup) return f;
        changed = true;
        return { ...f, markup: j.svg, ai: true };
      });
      return changed ? next : prev;
    });
  }, [jobs]);

  // 수정 창을 닫은 뒤에 작업이 끝나도 결과가 남도록, 지금 상태를 큐에 알려둔다.
  useEffect(() => {
    if (!editing) return;
    putSnapshot(problemKey, {
      problemId: editing.id,
      spec: {
        text: editText,
        boxOverride: editBox,
        fontSizePx: ptToPx(editFontPt),
        figures: cardFigures,
      },
    });
  }, [putSnapshot, problemKey, editing, editText, editBox, editFontPt, cardFigures]);

  /** 같은 자리에 놓인 다른 것의 개수("나란히 놓기"가 뜻이 있는지). */
  function slotMateCount(id: string): number {
    const here = cardFigures.find((f) => f.id === id)?.position;
    return cardFigures.filter((f) => f.id !== id && f.position === here).length;
  }

  /**
   * 문제를 **원하는 자리로 보낸다.**
   *
   * 자리마다 붙어 있던 `sort_order` 값은 그대로 두고 **누가 그 자리를 갖는지만**
   * 바꾼다. 새 값을 지어내면(예: 사이 값 끼워넣기) 값이 점점 촘촘해지다 결국
   * 끼울 자리가 없어지는데, 자리를 돌려 쓰면 그 일이 없다.
   *
   * 바뀐 행만 갱신한다 — 한 칸 옮기면 두 행, 멀리 보내면 그 사이 행들만이다.
   */
  async function moveTo(index: number, target: number) {
    const to = Math.max(0, Math.min(list.length - 1, target));
    if (to === index) return;

    const orders = list.map((p) => p.sortOrder);
    if (orders.some((o) => o == null)) {
      window.alert(
        "정렬 순서가 아직 준비되지 않았습니다. 0003 마이그레이션 SQL을 실행했는지 확인해주세요.",
      );
      return;
    }
    const slots = [...(orders as number[])].sort((a, b) => a - b);

    const moved = list[index];
    setBusyId(moved.id);

    const reordered = [...list];
    reordered.splice(index, 1);
    reordered.splice(to, 0, moved);
    const next = reordered.map((p, i) => ({ ...p, sortOrder: slots[i] }));
    const changed = next.filter(
      (p) => p.sortOrder !== list.find((x) => x.id === p.id)?.sortOrder,
    );
    setList(next);

    try {
      const supabase = createClient();
      // 서로 독립된 행 갱신이라 동시에 보낸다(순서대로 기다리면 왕복이 겹쳐 느리다).
      const results = await Promise.all(
        changed.map((p) =>
          supabase.from("problems").update({ sort_order: p.sortOrder }).eq("id", p.id),
        ),
      );
      const failed = results.find((r) => r.error);
      if (failed?.error) throw failed.error;
    } catch (err) {
      // 실패하면 원래 순서로 되돌린다.
      setList(list);
      window.alert(
        err instanceof Error ? err.message : "순서 변경에 실패했습니다.",
      );
    } finally {
      setBusyId(null);
    }
  }

  function openEdit(problem: GalleryProblem) {
    setEditing(problem);
    setEditText(problem.text);
    setEditAnswer(problem.answer);
    setEditAnswerType(problem.answerType);
    // DB에 null이면 저장할 때 자동 감지에 맡겼던 것이다.
    setEditBox(problem.boxRange ?? undefined);
    // 저장할 때의 크기로 연다. 예전에는 24px로 고정돼 있어서 수정만 하면
    // 글씨가 저 혼자 커졌다.
    setEditFontPt(problem.fontPt);
    setEditError(null);
    setEditFigures([]);
    setMaybeLostFigures(false);
    void loadFigures(problem.id);
  }

  /** 이 문제에 저장된 그림을 가져온다(목록 조회에서는 일부러 뺐다). */
  async function loadFigures(problemId: string) {
    setFiguresLoading(true);
    try {
      const supabase = createClient();
      const { data } = await supabase
        .from("problems")
        .select("box_range")
        .eq("id", problemId)
        .maybeSingle();
      const stored = readStoredFigures(data?.box_range);
      setEditFigures(stored);
      // figures 키 자체가 없으면 그림을 저장하기 전에 만들어진 문제다.
      const hasKey =
        data?.box_range &&
        typeof data.box_range === "object" &&
        "figures" in (data.box_range as object);
      setMaybeLostFigures(!hasKey);
    } catch {
      // 못 불러와도 본문 수정은 되게 둔다. 다만 그림이 빠질 수 있다고 알린다.
      setMaybeLostFigures(true);
    } finally {
      setFiguresLoading(false);
    }
  }

  async function saveEdit() {
    if (!editing) return;
    setIsSaving(true);
    setEditError(null);
    try {
      const node = previewRef.current;
      if (!node) throw new Error("미리보기를 찾을 수 없습니다.");

      const supabase = createClient();
      const blob = await captureNode(node);

      // 스토리지 버킷에 UPDATE 정책이 없어 덮어쓰기(upsert)는 RLS에 막힌다.
      // 새 경로에 업로드하고 image_path를 바꾼 뒤 예전 파일을 지운다.
      const newPath = siblingPath(editing.imagePath);
      const { error: upErr } = await supabase.storage
        .from("problem-images")
        .upload(newPath, blob, { contentType: "image/png" });
      if (upErr) throw upErr;

      const { error: dbErr } = await supabase
        .from("problems")
        .update({
          image_path: newPath,
          text_content: editText,
          latex: editText,
          answer: editAnswer.trim() || null,
          answer_type: editAnswerType,
          box_range: {
            ranges: toBoxRanges(editBox),
            fontPt: editFontPt,
            figures: toStoredFigures(cardFigures),
          },
        })
        .eq("id", editing.id);
      if (dbErr) {
        // DB 갱신 실패 시 방금 올린 파일을 정리한다.
        await supabase.storage.from("problem-images").remove([newPath]);
        throw dbErr;
      }

      // 예전 이미지는 정리(실패해도 치명적이지 않으므로 무시).
      await supabase.storage
        .from("problem-images")
        .remove([editing.imagePath]);

      setEditing(null);
      router.refresh();
    } catch (err) {
      setEditError(
        err instanceof Error ? err.message : "수정 저장에 실패했습니다.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function remove(problem: GalleryProblem) {
    if (!window.confirm("이 오답을 삭제할까요?")) return;
    setBusyId(problem.id);
    try {
      const supabase = createClient();
      await supabase.storage.from("problem-images").remove([problem.imagePath]);
      const { error } = await supabase
        .from("problems")
        .delete()
        .eq("id", problem.id);
      if (error) throw error;
      setList((cur) => cur.filter((p) => p.id !== problem.id));
      router.refresh();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "삭제에 실패했습니다.");
    } finally {
      setBusyId(null);
    }
  }

  if (list.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
        아직 저장된 오답이 없습니다. 위에서 오답을 추가해보세요.
      </p>
    );
  }

  /** 목록에서 보여줄 한 줄짜리 본문 미리보기. */
  function preview(problem: GalleryProblem): string {
    const t = problem.text.replace(/\s+/g, " ").trim();
    if (!t) return "이미지 문제";
    return t.length > 60 ? `${t.slice(0, 60)}…` : t;
  }

  const rowButtons = (problem: GalleryProblem, index: number) => (
    <>
      <button
        type="button"
        onClick={() => moveTo(index, index - 1)}
        disabled={index === 0 || busyId === problem.id}
        aria-label="앞으로"
        className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-40"
      >
        ↑
      </button>
      <button
        type="button"
        onClick={() => moveTo(index, index + 1)}
        disabled={index === list.length - 1 || busyId === problem.id}
        aria-label="뒤로"
        className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-40"
      >
        ↓
      </button>
      <button
        type="button"
        onClick={() => openEdit(problem)}
        className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
      >
        수정
      </button>
      <button
        type="button"
        onClick={() => remove(problem)}
        disabled={busyId === problem.id}
        className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-500 hover:border-red-300 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
      >
        삭제
      </button>
    </>
  );

  return (
    <>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs text-slate-400">
          {list.length}개 · 번호 칸에 자리를 직접 적으면 그 자리로 보냅니다
        </p>
        <div className="flex gap-1">
          {(["card", "list"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => pickView(v)}
              className={`rounded-lg border px-3 py-1 text-xs font-medium ${
                view === v
                  ? "border-blue-600 bg-blue-50 text-blue-700"
                  : "border-slate-300 text-slate-600 hover:bg-slate-100"
              }`}
            >
              {v === "card" ? "카드" : "목록"}
            </button>
          ))}
        </div>
      </div>

      {view === "list" ? (
        <ul className="flex flex-col divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {list.map((problem, index) => (
            <li
              key={problem.id}
              className={`flex items-center gap-2 px-2 py-1.5 ${
                busyId === problem.id ? "opacity-50" : ""
              }`}
            >
              <OrderInput
                index={index}
                total={list.length}
                disabled={busyId === problem.id}
                onCommit={(to) => void moveTo(index, to)}
              />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={problem.imageUrl}
                alt=""
                className="h-10 w-14 shrink-0 rounded border border-slate-200 object-cover object-top"
              />
              <span className="min-w-0 flex-1 truncate text-xs text-slate-600">
                {preview(problem)}
              </span>
              {problem.answer.trim() !== "" && (
                <span className="shrink-0 text-xs text-slate-400">
                  {formatAnswer(problem.answer, problem.answerType)}
                </span>
              )}
              <div className="flex shrink-0 items-center gap-1">
                {rowButtons(problem, index)}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {list.map((problem, index) => (
            <div
              key={problem.id}
              className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-2 shadow-sm"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={problem.imageUrl}
                alt="저장된 오답"
                className="w-full rounded object-contain"
              />
              <div className="flex flex-wrap items-center justify-between gap-1 px-1 pb-1">
                <OrderInput
                  index={index}
                  total={list.length}
                  disabled={busyId === problem.id}
                  onCommit={(to) => void moveTo(index, to)}
                />
                <div className="flex items-center gap-1">
                  {rowButtons(problem, index)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !isSaving && setEditing(null)}
        >
          <div
            className="flex max-h-[90vh] w-full max-w-6xl flex-col gap-4 overflow-auto rounded-2xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-ink">문제 내용 수정</h2>
            <p className="text-xs text-slate-500">
              내용·정답·조건 박스를 고치면 아래 미리보기처럼 이미지가 다시
              만들어져 저장됩니다.
            </p>
            {figuresLoading && (
              <p className="text-xs text-slate-400">그림을 불러오는 중…</p>
            )}
            {!figuresLoading && maybeLostFigures && (
              <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                이 문제는 그림이 함께 저장되기 전에 만들어졌습니다. 원래 그림이
                붙어 있었다면 <strong>여기서 저장하는 순간 사라집니다.</strong>{" "}
                그림을 살리려면 저장하지 말고 닫은 뒤, 오답추가로 다시 만들어
                주세요.
              </p>
            )}

            {/* 넓은 화면에서는 편집기와 미리보기를 나란히 둬서 고치는 즉시
                결과를 확인할 수 있게 한다(수식 편집이 특히 불편했던 부분). */}
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="flex flex-col gap-4">
                {isImageOnly ? (
                  <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-500">
                    이 문제는 AI가 통째로 다시 그린 <strong>이미지</strong>입니다.
                    글자를 따로 들고 있지 않아 본문 수정·조건 박스는 쓰지 않습니다.
                    그림의 크기·위치는 오른쪽 미리보기에서 조절할 수 있어요.
                  </p>
                ) : (
                  <TextEditTabs value={editText} onChange={setEditText} />
                )}

                <div className="flex flex-col gap-2 rounded-lg border border-slate-200 px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 text-xs font-medium text-slate-500">
                      정답 유형
                    </span>
                    {(["choice", "short"] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setEditAnswerType(t)}
                        className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${
                          editAnswerType === t
                            ? "border-blue-600 bg-blue-50 text-blue-700"
                            : "border-slate-300 text-slate-600 hover:bg-slate-100"
                        }`}
                      >
                        {ANSWER_TYPE_LABEL[t]}
                      </button>
                    ))}
                  </div>
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <span className="shrink-0 text-xs font-medium text-slate-500">
                      정답
                    </span>
                    <input
                      value={editAnswer}
                      onChange={(e) => setEditAnswer(e.target.value)}
                      placeholder={
                        editAnswerType === "choice"
                          ? "예: 3 → ③으로 표기"
                          : "예: 12"
                      }
                      className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                    />
                  </label>
                  {editAnswer.trim() !== "" && (
                    <p className="text-[11px] text-slate-500">
                      정답표 표기:{" "}
                      <span className="text-sm font-medium text-ink">
                        {formatAnswer(editAnswer, editAnswerType)}
                      </span>
                    </p>
                  )}
                </div>

                {!isImageOnly && (
                  <div className="rounded-lg border border-slate-200 px-3 py-2.5">
                    <BoxRangeEditor
                      text={editText}
                      value={editBox}
                      onChange={setEditBox}
                    />
                  </div>
                )}
              </div>

              <div>
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-medium text-slate-500">
                    미리보기 (이 모습 그대로 저장됩니다)
                  </p>
                  <FontSizeControl value={editFontPt} onChange={setEditFontPt} />
                </div>
                {/* 휴대폰에서 가로로 밀지 않고 한눈에 보이도록 축소한다.
                    카드 너비는 고정이라 저장되는 결과는 달라지지 않는다. */}
                <div className="rounded-lg border border-slate-200">
                  <DraggableCard
                    blocks={blocks}
                    figures={cardFigures}
                    fontSizePx={ptToPx(editFontPt)}
                    width={PROBLEM_CARD_WIDTH}
                    cardRef={previewRef}
                    cardClassName="problem-surface bg-white p-8"
                    onLayoutChange={(id, layout) => updateFigure(id, { layout })}
                    onPositionChange={(id, position) =>
                      updateFigure(id, { position })
                    }
                  />
                </div>

                {/* 그림·표 조절. 위치는 미리보기에서 끌어 옮기는 게 기본이고,
                    여기서는 크기·여백과 나란히 놓기를 다룬다. */}
                <div className="mt-2 flex flex-col gap-2 rounded-lg border border-slate-200 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] text-slate-400">
                      미리보기에서 그림이나 표를 잡아 끌면 원하는 문단 사이로
                      옮길 수 있어요. 같은 자리에 둘을 놓고 “옆으로 나란히”를
                      켜면 가로로 놓입니다.
                    </p>
                    <button
                      type="button"
                      onClick={() => setCropTarget({ mode: "add" })}
                      className="shrink-0 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
                    >
                      그림 추가
                    </button>
                  </div>
                  {cardFigures.map((f) => {
                    const job = jobs.find((j) => j.id === f.id);
                    const busy = job?.status === "pending" || job?.status === "running";
                    // 다시 그리려면 원본 픽셀이 있어야 한다(마크업에서 되꺼낸다).
                    const raster = f.markup ? rasterFromSvg(f.markup) : null;
                    return (
                      <div key={f.id} className="flex flex-col gap-1">
                        <DiagramAdjuster
                          label={
                            f.kind === "table"
                              ? `표 ${cardFigures.filter((x) => x.kind === "table").indexOf(f) + 1}`
                              : `그림 ${cardFigures.filter((x) => x.kind !== "table").indexOf(f) + 1}`
                          }
                          layout={f.layout}
                          defaultLayout={
                            f.kind === "table"
                              ? DEFAULT_TABLE_LAYOUT
                              : DEFAULT_DIAGRAM_LAYOUT
                          }
                          onChange={(layout) => updateFigure(f.id, { layout })}
                          row={f.row ?? false}
                          rowMates={slotMateCount(f.id)}
                          onRowChange={(row) => updateFigure(f.id, { row })}
                        />
                        {/* 표는 본문에서 만들어지는 것이라 오려내거나 다시 그릴 대상이 아니다. */}
                        {f.kind !== "table" && raster && (
                          <div className="flex flex-wrap items-center gap-1.5 pl-1">
                            <button
                              type="button"
                              onClick={() =>
                                setCropTarget({ mode: "recrop", id: f.id, src: raster })
                              }
                              disabled={busy}
                              className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                            >
                              다시 오려내기
                            </button>
                            <button
                              type="button"
                              onClick={() => requestRedraw(f.id, raster)}
                              disabled={busy || f.ai === true}
                              className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                            >
                              {busy ? "다시 그리는 중..." : "AI로 다시 그리기"}
                            </button>
                            {f.ai === true && (
                              <span className="text-[11px] text-slate-400">
                                이미 AI로 그린 그림입니다. 다시 오려내면 원본으로
                                돌아가 다시 그릴 수 있어요.
                              </span>
                            )}
                            {job?.status === "error" && (
                              <span className="text-[11px] text-red-600">{job.error}</span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {cropTarget && (
              <DiagramCropModal
                // 원본 사진은 저장하지 않으므로(변환 결과만 남긴다) 새 그림은
                // 새로 찍은 사진에서만 오려낼 수 있다. 다시 오려내기는 붙어
                // 있는 그림 자체가 재료다.
                imageSrc={cropTarget.mode === "recrop" ? cropTarget.src : null}
                purpose="figure"
                onConfirm={(crop) => void attachCrop(crop)}
                onCancel={() => setCropTarget(null)}
              />
            )}

            {editError && <p className="text-sm text-red-600">{editError}</p>}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditing(null)}
                disabled={isSaving}
                className="g-btn g-btn-outline"
              >
                취소
              </button>
              <button
                type="button"
                onClick={saveEdit}
                disabled={isSaving}
                className="g-btn g-btn-primary"
              >
                {isSaving ? "저장 중..." : "저장"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
