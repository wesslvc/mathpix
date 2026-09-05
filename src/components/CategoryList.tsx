"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  categoryLabel,
  categoryScore,
  type Category,
  type Folder,
} from "@/lib/supabase/types";
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
  /**
   * **고르는 중인가.** 예전에는 체크박스가 줄마다 늘 떠 있고 그 옆에 폴더
   * 고르는 드롭다운과 삭제 버튼까지 붙어서, 실모 하나를 여는 게 목적인
   * 화면인데 컨트롤이 넷씩 보였다. 고르는 일은 "여러 개를 PDF 로 묶을 때"만
   * 하는 일이라 평소에는 감춰 둔다 — 누르면 그때 체크박스가 나온다.
   */
  const [picking, setPicking] = useState(false);
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
    return categories.filter((c) => categoryLabel(c).toLowerCase().includes(q));
  }, [categories, search]);

  function folderNameOf(id: string | null): string | null {
    if (!id) return null;
    return folders.find((f) => f.id === id)?.name ?? null;
  }

  function Row({ category, showFolderTag = false }: { category: Category; showFolderTag?: boolean }) {
    const folderName = showFolderTag ? folderNameOf(category.folder_id) : null;
    const label = categoryLabel(category);
    // 점수는 **제목 안이 아니라 옆에** 붙인다(사용자 요청). 제목은 시험 이름
    // 그대로 두고, 점수는 배지로 따로 보여 준다.
    const score = categoryScore(category, maxOf(category.id));
    return (
      <div className="group flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3.5 shadow-sm transition hover:border-blue-300 hover:shadow">
        {picking && (
          <input
            type="checkbox"
            checked={selected.has(category.id)}
            onChange={() => toggle(category.id)}
            className="h-4 w-4 shrink-0 rounded border-slate-300"
            aria-label={`${label} 선택`}
          />
        )}
        {/* 줄 전체가 여는 자리다 — "열기 →" 를 따로 두지 않는다(누르는 자리가
            둘이면 어디를 눌러야 할지 헷갈리고 줄만 길어진다). */}
        <Link href={`/categories/${category.id}`} className="min-w-0 flex-1 py-0.5">
          <p className="truncate font-semibold text-ink">
            {label}
            {category.is_exam && (
              <span className="ml-2 rounded bg-blue-50 px-1.5 py-0.5 text-xs font-medium text-blue-600">
                실모
              </span>
            )}
            {score && (
              <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">
                {score}
              </span>
            )}
          </p>
          <p className="mt-0.5 text-xs text-slate-400">
            {folderName && <>📁 {folderName} · </>}
            {new Date(category.created_at).toLocaleDateString("ko-KR")}
          </p>
        </Link>

        {/* 폴더 옮기기·삭제는 자주 쓰는 일이 아니다 — `⋯` 안으로 넣어
            평소에는 안 보이게 한다. `<details>` 를 쓰면 바깥을 눌렀을 때
            닫는 처리를 직접 만들 필요가 없다(브라우저가 해 준다). */}
        <details className="relative shrink-0">
          <summary
            className="flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 [&::-webkit-details-marker]:hidden"
            aria-label={`${label} 더보기`}
          >
            ⋯
          </summary>
          <div className="absolute right-0 top-9 z-20 flex w-52 flex-col gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
            <label className="flex flex-col gap-1 text-xs text-slate-500">
              폴더로 옮기기
              <select
                value={category.folder_id ?? NO_FOLDER}
                onChange={(e) =>
                  void moveCategory(
                    category.id,
                    e.target.value === NO_FOLDER ? null : e.target.value,
                  )
                }
                className="rounded border border-slate-300 px-2 py-1.5 text-sm text-ink focus:border-blue-500 focus:outline-none"
              >
                <option value={NO_FOLDER}>폴더 없음</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="border-t border-slate-100 pt-2">
              <DeleteCategoryButton categoryId={category.id} label={label} />
            </div>
          </div>
        </details>
      </div>
    );
  }

  const nothingAtAll = categories.length === 0 && folders.length === 0;

  return (
    <div className="flex flex-col gap-4">
      {/* 검색과 도구를 한 줄에 둔다. 예전에는 안내 문구 한 줄 + PDF 버튼 한
          줄 + 검색 한 줄 + 폴더 만들기 한 줄로 **네 줄**이 목록 위를 차지했다. */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="실모 이름으로 검색"
          className="min-w-[12rem] flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        />
        {!currentFolder && !creatingFolder && (
          <button
            type="button"
            onClick={() => setCreatingFolder(true)}
            className="shrink-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-ink hover:bg-slate-50"
          >
            + 폴더
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setPicking((v) => !v);
            setSelected(new Set());
          }}
          className={`shrink-0 rounded-lg border px-3 py-2 text-sm ${
            picking
              ? "border-blue-500 bg-blue-50 text-blue-700"
              : "border-slate-300 bg-white text-ink hover:bg-slate-50"
          }`}
        >
          {picking ? "선택 끝내기" : "선택해서 PDF"}
        </button>
      </div>

      {/* 고르는 중일 때만 나오는 띠. 몇 개 골랐는지와 만들기 버튼이 여기 있다. */}
      {picking && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2">
          <p className="text-xs text-blue-800">
            {selected.size === 0
              ? "PDF로 묶을 실모를 골라주세요."
              : `${selected.size}개 선택됨`}
          </p>
          <button
            type="button"
            onClick={exportSelected}
            disabled={selected.size === 0}
            className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
          >
            PDF 만들기
          </button>
        </div>
      )}

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
                <h2 className="min-w-0 flex-1 truncate text-lg font-semibold text-ink">
                  📁 {currentFolder.name}
                </h2>
                {/* 폴더 이름 바꾸기·삭제도 실모 줄과 같은 `⋯` 로 통일한다 —
                    화면마다 다른 모양이면 어디에 뭐가 있는지 외워야 한다. */}
                <details className="relative shrink-0">
                  <summary
                    className="flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 [&::-webkit-details-marker]:hidden"
                    aria-label="폴더 더보기"
                  >
                    ⋯
                  </summary>
                  <div className="absolute right-0 top-9 z-20 flex w-40 flex-col rounded-xl border border-slate-200 bg-white p-1 shadow-lg">
                    <button
                      type="button"
                      onClick={() => {
                        setRenamingFolder(true);
                        setRenameValue(currentFolder.name);
                      }}
                      className="rounded-lg px-3 py-2 text-left text-sm text-ink hover:bg-slate-50"
                    >
                      이름 바꾸기
                    </button>
                    <button
                      type="button"
                      disabled={working}
                      onClick={() => void deleteFolder(currentFolder.id, currentFolder.name)}
                      className="rounded-lg px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50 disabled:opacity-40"
                    >
                      폴더 삭제
                    </button>
                  </div>
                </details>
              </>
            )}
          </div>

          <div className="flex flex-col gap-2.5">
            {categories
              .filter((c) => c.folder_id === currentFolder.id)
              .map((c) => (
                <Row key={c.id} category={c} />
              ))}
            {categories.filter((c) => c.folder_id === currentFolder.id).length === 0 && (
              <p className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-400">
                이 폴더는 비어 있어요. 위에서 실모를 추가하거나, 전체 목록에서
                실모의 <span className="font-medium">⋯ → 폴더로 옮기기</span>로
                가져올 수 있어요.
              </p>
            )}
          </div>
        </div>
      ) : (
        // ── 전체(루트) ───────────────────────────────────────────
        <div className="flex flex-col gap-4">
          {creatingFolder && (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createFolder();
                  if (e.key === "Escape") {
                    setCreatingFolder(false);
                    setNewFolderName("");
                  }
                }}
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

          {/* 폴더는 **격자**로 놓는다. 한 줄에 하나씩 쌓으면 폴더가 몇 개만
              돼도 실모 목록이 화면 아래로 밀려나 "파일탐색기 같다"는 느낌이
              안 난다. 좁은 화면에서는 한 줄, 넓으면 두세 줄이다. */}
          {folders.length > 0 && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {folders.map((folder) => {
                const count = categories.filter((c) => c.folder_id === folder.id).length;
                return (
                  <Link
                    key={folder.id}
                    href={`/?folder=${folder.id}`}
                    className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-3 shadow-sm transition hover:border-blue-300 hover:bg-blue-50"
                  >
                    <span aria-hidden className="text-lg leading-none">📁</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">
                        {folder.name}
                      </span>
                      <span className="block text-xs text-slate-400">{count}개</span>
                    </span>
                  </Link>
                );
              })}
            </div>
          )}

          <div className="flex flex-col gap-2.5">
            {categories
              .filter((c) => !c.folder_id)
              .map((c) => (
                <Row key={c.id} category={c} />
              ))}
            {categories.length > 0 && categories.every((c) => c.folder_id) && folders.length > 0 && (
              <p className="py-4 text-center text-sm text-slate-400">
                폴더 밖에는 실모가 없어요. 위 폴더를 눌러 들어가보세요.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
