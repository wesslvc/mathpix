"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toPng } from "html-to-image";
import { createClient } from "@/lib/supabase/client";
import { renderMathText } from "@/lib/renderMathText";
import { PROBLEM_CARD_WIDTH } from "@/lib/layout";

export type GalleryProblem = {
  id: string;
  imageUrl: string;
  imagePath: string;
  text: string;
  sortOrder: number | null;
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
    dataUrl = await toPng(node, { pixelRatio: 2, backgroundColor: "#ffffff" });
  }
  return await (await fetch(dataUrl)).blob();
}

export default function ProblemGallery({ problems }: Props) {
  const router = useRouter();
  const [list, setList] = useState<GalleryProblem[]>(problems);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<GalleryProblem | null>(null);
  const [editText, setEditText] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

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
      // 서로 독립된 두 행 갱신이라 동시에 보내도 안전하다(순서대로 기다리면
      // 왕복이 두 번 겹쳐 느려진다).
      const [{ error: e1 }, { error: e2 }] = await Promise.all([
        supabase.from("problems").update({ sort_order: b.sortOrder }).eq("id", a.id),
        supabase.from("problems").update({ sort_order: a.sortOrder }).eq("id", b.id),
      ]);
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
              <p className="mb-1 text-xs font-medium text-slate-500">
                미리보기 (이 모습 그대로 저장됩니다)
              </p>
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <div
                  ref={previewRef}
                  className="bg-white p-8 font-serif leading-relaxed text-ink"
                  style={{ fontSize: 24, width: PROBLEM_CARD_WIDTH }}
                  dangerouslySetInnerHTML={{ __html: renderMathText(editText) }}
                />
              </div>
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
