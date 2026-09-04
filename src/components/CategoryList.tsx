"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { categoryLabel, type Category, type Folder } from "@/lib/supabase/types";
import { createClient } from "@/lib/supabase/client";
import DeleteCategoryButton from "@/components/DeleteCategoryButton";

const NO_FOLDER = "__none__";

/**
 * **파일탐색기처럼** — 폴더를 누르면 그 안으로 들어가고(`?folder=id`),
 * "← 전체"로 나온다. 한때 폴더별로 묶어 한 화면에 전부 펼쳐 보여줬는데
 * 사용자가 불편하다고 했다 — 폴더가 몇 개만 있어도 화면이 계속 길어지고,
 * 지금 어디를 보고 있는지 알기 어려웠다. 폴더 안에 폴더는 없다(사용자가
 * "하위에 하위는 없어도 된다"고 확인한 범위) — 그래서 지금 폴더 하나만
 * 기억하면 되고, `?folder=` 쿼리 하나로 표현할 수 있다.
 *
 * 검색 중에는 폴더 구분을 무시하고 전체에서 찾는다 — "지금 보고 있는
 * 폴더 안에서만 찾기"가 아니라 "이름은 아는데 어디 있는지 모를 때 찾기"가
 * 요청의 의도였다.
 */
export default function CategoryList({
  categories,
  folders,
  currentFolderId,
  maxScoreByCategory = {},
}: {
  categories: Category[];
  folders: Folder[];
  currentFolderId: string | null;
  /** 실모 id → 원점수 만점(탐구 50 / 그 밖 100). 없으면 100. */
  maxScoreByCategory?: Record<string, number>;
}) {
  /** 이 실모의 만점. 연결된 채점이 없으면 예전처럼 100. */
  const maxOf = (id: string) => maxScoreByCategory[id] ?? 100;
  const router = useRouter();
  const currentFolder = folders.find((f) => f.id === currentFolderId) ?? null;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renamingFolder, setRenamingFolder] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [busy, setBusy] = useState(false);
  /**
   * **`router.refresh()` 는 기다려 주지 않는다.**
   *
   * 이 함수는 서버에 다시 그려 달라고 부탁만 하고 **곧바로 반환한다** — 그래서
   * `finally { setBusy(false) }` 가 서버 응답이 오기 한참 전에 실행됐다.
   * 화면은 "다 됐다"는 얼굴을 하고 있는데 목록은 아직 예전 것이고, 잠시 뒤
   * 갑자기 바뀐다. 사용자가 말한 "뚜둑뚜둑 끊긴 다음 다음 화면이 뜬다"가
   * 이 자리에도 있었다(폴더 만들기·이름 바꾸기·실모 옮기기).
   *
   * `startTransition` 으로 감싸면 그 갱신이 끝날 때까지 `pending` 이 켜져
   * 있으므로, 그때까지 눌린 상태를 유지할 수 있다.
   */
  const [pending, startTransition] = useTransition();
  const working = busy || pending;
  /** 서버 갱신이 실제로 끝날 때까지 pending 이 유지되게 감싼다. */
  const refresh = () => startTransition(() => router.refresh());

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exportSelected() {
    const ids = categories.filter((c) => selected.has(c.id)).map((c) => c.id);
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
      refresh();
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
      setRenamingFolder(false);
      refresh();
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
      // 지금 보고 있던 폴더를 지웠으면 전체 목록으로 나간다 — 없어진 폴더
      // 안에 계속 남아 있을 수는 없다.
      router.push("/");
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function moveCategory(categoryId: string, folderId: string | null) {
    const supabase = createClient();
    await supabase.from("categories").update({ folder_id: folderId }).eq("id", categoryId);
    refresh();
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null; // null = 검색 안 함
    return categories.filter((c) => categoryLabel(c, maxOf(c.id)).toLowerCase().includes(q));
  }, [categories, search]);

  function folderNameOf(id: string | null): string | null {
    if (!id) return null;
    return folders.find((f) => f.id === id)?.name ?? null;
  }

  function Row({ category, showFolderTag = false }: { category: Category; showFolderTag?: boolean }) {
    const folderName = showFolderTag ? folderNameOf(category.folder_id) : null;
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
            {categoryLabel(category, maxOf(category.id))}
            {category.is_exam && (
              <span className="ml-2 rounded bg-blue-50 px-1.5 py-0.5 text-xs font-medium text-blue-600">
                실모
              </span>
            )}
          </p>
          <p className="text-xs text-slate-400">
            {folderName && <>📁 {folderName} · </>}
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
          <DeleteCategoryButton categoryId={category.id} label={categoryLabel(category, maxOf(category.id))} />
          <Link href={`/categories/${category.id}`} className="text-sm text-blue-600">
            열기 →
          </Link>
        </div>
      </div>
    );
  }

  const nothingAtAll = categories.length === 0 && folders.length === 0;

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
        placeholder="실모 이름으로 검색 (폴더 안이든 밖이든 전체에서 찾아요)"
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
      />

      {nothingAtAll ? (
        <p className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
          아직 등록된 실모가 없습니다. 위에서 실모를 추가해보세요.
        </p>
      ) : filtered !== null ? (
        // 검색 중에는 폴더 구분 없이 전체에서 찾는다. 폴더에 있던 것은
        // 어디 있는지 태그로 알려준다.
        filtered.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
            검색 결과가 없어요.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {filtered.map((c) => (
              <Row key={c.id} category={c} showFolderTag />
            ))}
          </div>
        )
      ) : currentFolder ? (
        // ── 폴더 안 ──────────────────────────────────────────────
        <div className="flex flex-col gap-3">
          <Link href="/" className="inline-flex w-fit items-center gap-1 text-sm text-blue-600 hover:underline">
            ← 전체 실모
          </Link>

          <div className="flex items-center gap-2">
            {renamingFolder ? (
              <>
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  className="rounded border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void renameFolder(currentFolder.id)}
                  className="text-xs text-blue-600 hover:text-blue-800"
                >
                  저장
                </button>
                <button
                  type="button"
                  onClick={() => setRenamingFolder(false)}
                  className="text-xs text-slate-500 hover:text-slate-700"
                >
                  취소
                </button>
              </>
            ) : (
              <>
                <h2 className="text-lg font-semibold text-ink">📁 {currentFolder.name}</h2>
                <button
                  type="button"
                  onClick={() => {
                    setRenamingFolder(true);
                    setRenameValue(currentFolder.name);
                  }}
                  className="text-xs text-slate-400 underline underline-offset-2 hover:text-slate-600"
                >
                  이름 바꾸기
                </button>
                <button
                  type="button"
                  disabled={working}
                  onClick={() => void deleteFolder(currentFolder.id, currentFolder.name)}
                  className="text-xs text-slate-400 underline underline-offset-2 hover:text-red-600"
                >
                  삭제
                </button>
              </>
            )}
          </div>

          <div className="flex flex-col gap-3">
            {categories
              .filter((c) => c.folder_id === currentFolder.id)
              .map((c) => (
                <Row key={c.id} category={c} />
              ))}
            {categories.filter((c) => c.folder_id === currentFolder.id).length === 0 && (
              <p className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-400">
                이 폴더는 비어 있어요.
              </p>
            )}
          </div>
        </div>
      ) : (
        // ── 전체(루트) ───────────────────────────────────────────
        <div className="flex flex-col gap-4">
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
                disabled={working || !newFolderName.trim()}
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

          {folders.length > 0 && (
            <div className="flex flex-col gap-2">
              {folders.map((folder) => {
                const count = categories.filter((c) => c.folder_id === folder.id).length;
                return (
                  <Link
                    key={folder.id}
                    href={`/?folder=${folder.id}`}
                    className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm hover:border-blue-300 hover:bg-blue-50"
                  >
                    <span className="font-medium text-ink">📁 {folder.name}</span>
                    <span className="text-xs text-slate-400">{count}개</span>
                  </Link>
                );
              })}
            </div>
          )}

          <div className="flex flex-col gap-3">
            {categories
              .filter((c) => !c.folder_id)
              .map((c) => (
                <Row key={c.id} category={c} />
              ))}
            {categories.length > 0 && categories.every((c) => c.folder_id) && folders.length > 0 && (
              <p className="text-center text-sm text-slate-400">
                폴더 밖에는 실모가 없어요. 위 폴더를 눌러 들어가보세요.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
