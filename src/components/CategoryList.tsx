"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { categoryLabel, type Category, type Folder } from "@/lib/supabase/types";
import { createClient } from "@/lib/supabase/client";
import DeleteCategoryButton from "@/components/DeleteCategoryButton";

const NO_FOLDER = "__none__";

export default function CategoryList({
  categories,
  folders,
}: {
  categories: Category[];
  folders: Folder[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busy, setBusy] = useState(false);

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exportSelected() {
    const ids = categories
      .filter((c) => selected.has(c.id))
      .map((c) => c.id);
    if (ids.length === 0) return;
    router.push(`/export?ids=${ids.join(",")}`);
  }

  async function createFolder() {
    if (!newFolderName.trim()) return;
    setBusy(true);
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("로그인이 필요합니다.");
      const { error } = await supabase
        .from("folders")
        .insert({ user_id: user.id, name: newFolderName.trim() });
      if (error) throw error;
      setNewFolderName("");
      setCreatingFolder(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function renameFolder(id: string) {
    if (!renameValue.trim()) return;
    setBusy(true);
    try {
      const supabase = createClient();
      await supabase.from("folders").update({ name: renameValue.trim() }).eq("id", id);
      setRenamingId(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function deleteFolder(id: string, name: string) {
    if (!confirm(`"${name}" 폴더를 지울까요? 안의 실모는 지워지지 않고 "폴더 없음"으로 남습니다.`)) {
      return;
    }
    setBusy(true);
    try {
      const supabase = createClient();
      await supabase.from("folders").delete().eq("id", id);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function moveCategory(categoryId: string, folderId: string | null) {
    const supabase = createClient();
    await supabase.from("categories").update({ folder_id: folderId }).eq("id", categoryId);
    router.refresh();
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null; // null = 검색 안 함(폴더별로 보여준다)
    return categories.filter((c) => categoryLabel(c).toLowerCase().includes(q));
  }, [categories, search]);

  function Row({ category }: { category: Category }) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm">
        <input
          type="checkbox"
          checked={selected.has(category.id)}
          onChange={() => toggle(category.id)}
          className="h-4 w-4 shrink-0 rounded border-slate-300"
          aria-label="선택"
        />
        <Link href={`/categories/${category.id}`} className="min-w-0 flex-1">
          <p className="truncate font-semibold text-ink">
            {categoryLabel(category)}
            {category.is_exam && (
              <span className="ml-2 rounded bg-blue-50 px-1.5 py-0.5 text-xs font-medium text-blue-600">
                실모
              </span>
            )}
          </p>
          <p className="text-xs text-slate-400">
            {new Date(category.created_at).toLocaleDateString("ko-KR")} 생성
          </p>
        </Link>
        <div className="flex shrink-0 items-center gap-2">
          <select
            value={category.folder_id ?? NO_FOLDER}
            onChange={(e) =>
              void moveCategory(category.id, e.target.value === NO_FOLDER ? null : e.target.value)
            }
            className="rounded border border-slate-300 px-1.5 py-1 text-xs text-slate-600 focus:border-blue-500 focus:outline-none"
            aria-label="폴더로 이동"
          >
            <option value={NO_FOLDER}>폴더 없음</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <DeleteCategoryButton categoryId={category.id} label={categoryLabel(category)} />
          <Link href={`/categories/${category.id}`} className="text-sm text-blue-600">
            열기 →
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-400">
          여러 실모를 체크하면 오답을 한 번에 PDF로 모을 수 있습니다.
        </p>
        <button
          type="button"
          onClick={exportSelected}
          disabled={selected.size === 0}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          선택한 {selected.size || ""}개로 PDF 만들기
        </button>
      </div>

      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="실모 이름으로 검색"
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
      />

      {categories.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
          아직 등록된 실모가 없습니다. 위에서 실모를 추가해보세요.
        </p>
      ) : filtered !== null ? (
        // 검색 중에는 폴더 구분 없이 결과만 보여준다.
        filtered.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
            검색 결과가 없어요.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {filtered.map((c) => (
              <Row key={c.id} category={c} />
            ))}
          </div>
        )
      ) : (
        <div className="flex flex-col gap-5">
          {!creatingFolder ? (
            <button
              type="button"
              onClick={() => setCreatingFolder(true)}
              className="self-start text-sm text-blue-600 underline underline-offset-2 hover:text-blue-800"
            >
              + 폴더 만들기
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder="폴더 이름"
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
              />
              <button
                type="button"
                disabled={busy || !newFolderName.trim()}
                onClick={() => void createFolder()}
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
              >
                만들기
              </button>
              <button
                type="button"
                onClick={() => {
                  setCreatingFolder(false);
                  setNewFolderName("");
                }}
                className="text-sm text-slate-500 hover:text-slate-700"
              >
                취소
              </button>
            </div>
          )}

          {folders.map((folder) => {
            const inFolder = categories.filter((c) => c.folder_id === folder.id);
            return (
              <div key={folder.id} className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  {renamingId === folder.id ? (
                    <>
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        className="rounded border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => void renameFolder(folder.id)}
                        className="text-xs text-blue-600 hover:text-blue-800"
                      >
                        저장
                      </button>
                      <button
                        type="button"
                        onClick={() => setRenamingId(null)}
                        className="text-xs text-slate-500 hover:text-slate-700"
                      >
                        취소
                      </button>
                    </>
                  ) : (
                    <>
                      <h3 className="text-sm font-semibold text-slate-700">
                        📁 {folder.name}
                        <span className="ml-1.5 font-normal text-slate-400">
                          {inFolder.length}개
                        </span>
                      </h3>
                      <button
                        type="button"
                        onClick={() => {
                          setRenamingId(folder.id);
                          setRenameValue(folder.name);
                        }}
                        className="text-xs text-slate-400 underline underline-offset-2 hover:text-slate-600"
                      >
                        이름 바꾸기
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteFolder(folder.id, folder.name)}
                        className="text-xs text-slate-400 underline underline-offset-2 hover:text-red-600"
                      >
                        삭제
                      </button>
                    </>
                  )}
                </div>
                {inFolder.length > 0 && (
                  <div className="flex flex-col gap-3 pl-1">
                    {inFolder.map((c) => (
                      <Row key={c.id} category={c} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          <div className="flex flex-col gap-2">
            {folders.length > 0 && (
              <h3 className="text-sm font-semibold text-slate-500">폴더 없음</h3>
            )}
            <div className="flex flex-col gap-3">
              {categories
                .filter((c) => !c.folder_id)
                .map((c) => (
                  <Row key={c.id} category={c} />
                ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
