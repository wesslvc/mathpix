"use client";

import { useEffect, useState } from "react";

/**
 * **PC 없이 Supabase의 그림을 R2로 옮긴다.**
 *
 * `scripts/migrate-images-to-r2.mjs`(로컬 스크립트)와 로직은 같지만, 서버가
 * 이미 가진 키를 그대로 쓰므로 아무 값도 입력할 필요 없이 버튼만 누르면
 * 된다(`/api/admin/migrate-images`). 무제한 계정만 실제로 동작한다 — 다른
 * 계정이 들어와도 버튼을 누르면 403이 뜰 뿐이다(`/admin/kice-fonts`와
 * 같은 방식, 이 페이지 자체는 따로 가드하지 않는다).
 *
 * **여러 번에 나눠 부른다.** 파일이 수백 개라 한 번의 요청으로 다 못 옮길
 * 수 있어서, 서버가 매번 한 뭉치(20개)만 처리하고 "남은 것"을 돌려주면
 * 화면이 그걸 그대로 다시 보내 이어서 부른다 — 진행 상황이 눈에 보이고,
 * 중간에 멈춰도 다시 누르면 이어서 된다.
 */

type Item = { path: string; size: number | null; mimetype: string | null };
type Failure = { path: string; error: string };

type CopyProgress = {
  total: number | null;
  copied: number;
  skipped: number;
  failed: number;
  copiedBytes: number;
  failures: Failure[];
  done: boolean;
};

type DeleteProgress = {
  total: number | null;
  deleted: number;
  deleteSkipped: number;
  failed: number;
  failures: Failure[];
  done: boolean;
};

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;

export default function MigrateImagesPage() {
  const [preview, setPreview] = useState<{ count: number; totalBytes: number } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);

  const [copyBusy, setCopyBusy] = useState(false);
  const [copy, setCopy] = useState<CopyProgress | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  const [deleteBusy, setDeleteBusy] = useState(false);
  const [del, setDel] = useState<DeleteProgress | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/migrate-images");
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "확인하지 못했습니다.");
        if (json.configured === false) {
          setPreviewError("R2가 아직 설정되지 않았습니다.");
          return;
        }
        setPreview({ count: json.count, totalBytes: json.totalBytes });
      } catch (err) {
        setPreviewError(err instanceof Error ? err.message : "확인하지 못했습니다.");
      } finally {
        setPreviewLoading(false);
      }
    })();
  }, []);

  async function runCopy() {
    setCopyBusy(true);
    setCopyError(null);
    setCopy({ total: null, copied: 0, skipped: 0, failed: 0, copiedBytes: 0, failures: [], done: false });
    try {
      let items: Item[] | undefined = undefined;
      let acc: CopyProgress = {
        total: null,
        copied: 0,
        skipped: 0,
        failed: 0,
        copiedBytes: 0,
        failures: [],
        done: false,
      };
      for (;;) {
        const res: Response = await fetch("/api/admin/migrate-images", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "copy", items }),
        });
        const json: {
          total?: number | null;
          copied: number;
          skipped: number;
          failed: number;
          copiedBytes: number;
          failures: Failure[];
          remaining: Item[];
          done: boolean;
          error?: string;
        } = await res.json();
        if (!res.ok) throw new Error(json.error ?? "복사에 실패했습니다.");

        acc = {
          total: acc.total ?? json.total ?? null,
          copied: acc.copied + json.copied,
          skipped: acc.skipped + json.skipped,
          failed: acc.failed + json.failed,
          copiedBytes: acc.copiedBytes + json.copiedBytes,
          failures: [...acc.failures, ...json.failures],
          done: json.done,
        };
        setCopy(acc);

        if (json.done) break;
        items = json.remaining;
      }
    } catch (err) {
      setCopyError(err instanceof Error ? err.message : "복사 중 오류가 발생했습니다.");
    } finally {
      setCopyBusy(false);
    }
  }

  async function runDelete() {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      let items: Item[] | undefined = undefined;
      let acc: DeleteProgress = {
        total: null,
        deleted: 0,
        deleteSkipped: 0,
        failed: 0,
        failures: [],
        done: false,
      };
      setDel(acc);
      for (;;) {
        const res: Response = await fetch("/api/admin/migrate-images", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "delete", items }),
        });
        const json: {
          total?: number | null;
          deleted: number;
          deleteSkipped: number;
          failed: number;
          failures: Failure[];
          remaining: Item[];
          done: boolean;
          error?: string;
        } = await res.json();
        if (!res.ok) throw new Error(json.error ?? "삭제에 실패했습니다.");

        acc = {
          total: acc.total ?? json.total ?? null,
          deleted: acc.deleted + json.deleted,
          deleteSkipped: acc.deleteSkipped + json.deleteSkipped,
          failed: acc.failed + json.failed,
          failures: [...acc.failures, ...json.failures],
          done: json.done,
        };
        setDel(acc);

        if (json.done) break;
        items = json.remaining;
      }
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "삭제 중 오류가 발생했습니다.");
    } finally {
      setDeleteBusy(false);
    }
  }

  const copyFullyDone = copy?.done && copy.failed === 0;

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 pb-10 pt-6">
      <h1 className="text-xl font-semibold text-ink">그림을 R2로 옮기기</h1>
      <p className="text-sm text-slate-500">
        Supabase Storage에 있는 문제 그림을 Cloudflare R2로 복사합니다. DB는
        건드리지 않습니다 — 그림 보기(/api/card)가 R2를 먼저 보고 없으면
        Supabase로 내려가게 되어 있어서, 옮기는 도중에도 화면은 계속
        정상입니다. 재인코딩 없이 원본 바이트 그대로 옮깁니다.
      </p>

      {previewLoading && <p className="text-sm text-slate-400">확인하는 중...</p>}
      {previewError && <p className="text-sm text-red-600">{previewError}</p>}
      {preview && (
        <p className="text-sm text-slate-600">
          지금 Supabase에 <b>{preview.count}개</b>, 총 <b>{mb(preview.totalBytes)}</b>가
          있습니다(이미 R2에 있는 것도 포함된 값입니다 — 복사를 누르면 그런
          것은 건너뜁니다).
        </p>
      )}

      <button
        type="button"
        onClick={() => void runCopy()}
        disabled={copyBusy}
        className="self-start rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {copyBusy ? "복사하는 중..." : "R2로 복사 시작"}
      </button>

      {copy && (
        <div className="flex flex-col gap-1 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
          <p>
            복사 {copy.copied}개({mb(copy.copiedBytes)}) · 이미 있음 {copy.skipped}개 ·
            실패 {copy.failed}개
            {copy.total != null && ` (전체 ${copy.total}개 중)`}
          </p>
          {copy.done && copy.failed === 0 && (
            <p className="text-emerald-700">✓ 전부 끝났습니다. Supabase 원본은 아직 그대로 있습니다.</p>
          )}
          {copy.failures.length > 0 && (
            <div className="text-amber-700">
              <p>실패한 것들 — 버튼을 다시 눌러 재시도할 수 있습니다:</p>
              <ul className="list-disc pl-5">
                {copy.failures.slice(0, 10).map((f) => (
                  <li key={f.path} className="truncate">
                    {f.path}: {f.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {copyError && <p className="text-sm text-red-600">{copyError}</p>}

      {copyFullyDone && (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p>
            복사가 끝났다면 앱에서 그림들이 잘 뜨는지 먼저 확인해보세요. 확인이
            끝나면 아래에서 Supabase 원본을 지울 수 있습니다 — <b>R2에 같은
            크기로 있는 것만</b> 지우므로 안전하지만, 되돌릴 수는 없습니다.
          </p>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            앱에서 그림이 잘 뜨는 것을 확인했고, Supabase 원본을 지우겠습니다.
          </label>
          <button
            type="button"
            onClick={() => void runDelete()}
            disabled={!confirmed || deleteBusy}
            className="self-start rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {deleteBusy ? "지우는 중..." : "Supabase 원본 지우기"}
          </button>
        </div>
      )}

      {del && (
        <div className="flex flex-col gap-1 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
          <p>
            지움 {del.deleted}개 · 건너뜀(R2 미확인) {del.deleteSkipped}개 · 실패 {del.failed}개
          </p>
          {del.done && del.failed === 0 && <p className="text-emerald-700">✓ 정리가 끝났습니다.</p>}
        </div>
      )}
      {deleteError && <p className="text-sm text-red-600">{deleteError}</p>}
    </main>
  );
}
