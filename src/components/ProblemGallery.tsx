"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toPng } from "html-to-image";
import { createClient } from "@/lib/supabase/client";
import { renderMathText } from "@/lib/renderMathText";

export type GalleryProblem = {
  id: string;
  imageUrl: string;
  imagePath: string;
  text: string;
  sortOrder: number | null;
};

type Props = {
  problems: GalleryProblem[];
};

/**
 * 편집한 텍스트를 화면 밖 카드에 렌더링해 PNG Blob으로 만든다.
 * (저장 당시 ResultStage 카드와 같은 스타일 - 나눔명조 + KaTeX)
 */
async function renderTextToPng(text: string): Promise<Blob> {
  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.left = "-99999px";
  container.style.top = "0";
  container.style.width = "640px";
  container.style.padding = "32px";
  container.style.background = "#ffffff";
  container.style.fontFamily = '"Nanum Myeongjo", serif';
  container.style.fontSize = "24px";
  container.style.lineHeight = "1.7";
  container.style.color = "#1a1d29";
  container.innerHTML = renderMathText(text);
  document.body.appendChild(container);
  try {
    if (document.fonts?.ready) await document.fonts.ready;
    const dataUrl = await toPng(container, {
      pixelRatio: 2,
      backgroundColor: "#ffffff",
    });
    return await (await fetch(dataUrl)).blob();
  } finally {
    document.body.removeChild(container);
  }
}

export default function ProblemGallery({ problems }: Props) {
  const router = useRouter();
  const [list, setList] = useState<GalleryProblem[]>(problems);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<GalleryProblem | null>(null);
  const [editText, setEditText] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  async function move(index: number, dir: -1 | 1) {
    const j = index + dir;
    if (j < 0 || j >= list.length) return;

    const a = list[index];
    const b = list[j];
    if (a.sortOrder == null || b.sortOrder == null) {
      window.alert(
        "정렬 순서가 아직 준비되지 않았습니다. 0003 마이그레이션 SQL을 실행했는지 확인해주세요.",
      );
      return;
    }

    setBusyId(a.id);

    // 두 문제의 sort_order 값을 서로 맞바꾼다.
    const next = [...list];
    next[index] = { ...b, sortOrder: a.sortOrder };
    next[j] = { ...a, sortOrder: b.sortOrder };
    setList(next);

    try {
      const supabase = createClient();
      const { error: e1 } = await supabase
        .from("problems")
        .update({ sort_order: b.sortOrder })
        .eq("id", a.id);
      const { error: e2 } = await supabase
        .from("problems")
        .update({ sort_order: a.sortOrder })
        .eq("id", b.id);
      if (e1 || e2) throw e1 ?? e2;
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
    setEditError(null);
  }

  async function saveEdit() {
    if (!editing) return;
    setIsSaving(true);
    setEditError(null);
    try {
      const supabase = createClient();
      const blob = await renderTextToPng(editText);

      const { error: upErr } = await supabase.storage
        .from("problem-images")
        .upload(editing.imagePath, blob, {
          contentType: "image/png",
          upsert: true,
        });
      if (upErr) throw upErr;

      const { error: dbErr } = await supabase
        .from("problems")
        .update({ text_content: editText, latex: editText })
        .eq("id", editing.id);
      if (dbErr) throw dbErr;

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

  return (
    <>
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
              <span className="text-xs text-slate-400">{index + 1}번</span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={index === 0 || busyId === problem.id}
                  aria-label="앞으로"
                  className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-40"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
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
              </div>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !isSaving && setEditing(null)}
        >
          <div
            className="flex max-h-[90vh] w-full max-w-3xl flex-col gap-4 overflow-auto rounded-2xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-ink">문제 내용 수정</h2>
            <p className="text-xs text-slate-500">
              텍스트와 수식($...$, $$...$$)을 고치면 아래 미리보기처럼 이미지가
              다시 만들어져 저장됩니다.
            </p>

            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              rows={8}
              className="w-full rounded-lg border border-slate-300 p-3 font-mono text-sm focus:border-blue-500 focus:outline-none"
            />

            <div>
              <p className="mb-1 text-xs font-medium text-slate-500">미리보기</p>
              <div
                className="rounded-lg border border-slate-200 bg-white p-6 font-serif text-lg leading-relaxed text-ink"
                dangerouslySetInnerHTML={{ __html: renderMathText(editText) }}
              />
            </div>

            {editError && <p className="text-sm text-red-600">{editError}</p>}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditing(null)}
                disabled={isSaving}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50"
              >
                취소
              </button>
              <button
                type="button"
                onClick={saveEdit}
                disabled={isSaving}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
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
