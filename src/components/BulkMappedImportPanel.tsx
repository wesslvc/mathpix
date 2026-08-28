"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { matchFiles, parseCsv, type MatchedItem, type SkippedItem } from "@/lib/bulkImportMatch";

/**
 * 한 요청에 담을 최대 바이트. Vercel Serverless Function 요청 본문은
 * 4.5MB로 막혀 있다(문제 영역 자동 찾기와 같은 제약) — 넉넉히 여유를 두고
 * 3.5MB로 묶어 보낸다. multipart 오버헤드는 무시할 만큼 작다.
 */
const MAX_BATCH_BYTES = 3.5 * 1024 * 1024;

function chunkFiles(files: File[]): File[][] {
  const batches: File[][] = [];
  let current: File[] = [];
  let currentBytes = 0;
  for (const f of files) {
    if (current.length > 0 && currentBytes + f.size > MAX_BATCH_BYTES) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(f);
    currentBytes += f.size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

type BatchResponse = { ok: number; failed: string[]; skipped: SkippedItem[] };

/**
 * 이미지 여러 장 + 정답 CSV를 한 번에 매칭해서 올린다.
 *
 * **왜 필요한가**: 학원가에서 도는 "연계교재 선별" 자료는 문제 사진 수십~
 * 수백 장과 정답표(CSV)가 따로 온다. 한 장씩 크롭·인식·정답 입력을 거치면
 * 100장에 100번을 반복해야 한다. 이 자료는 이미 깔끔하게 잘린 스크린샷이라
 * 크롭도 Mathpix 인식도 필요 없다 — 파일명에서 뽑은 키로 정답만 매칭해서
 * 그림 하나짜리 카드로 곧장 저장한다. Mathpix도, AI 그림 생성도 부르지
 * 않으므로 **토큰이 들지 않는다.**
 *
 * **실제 업로드·저장은 서버(`/api/bulk-import-mapped`)가 한다.** 처음엔
 * 브라우저에서 카드를 다시 그려(캔버스) 나머지 문제들과 같은 모양으로
 * 만들려 했는데, 이 기능을 쓸 사람이 터미널도 없는 모바일이라 그 복잡한
 * 캔버스 경로를 실기기에서 검증하기 어려웠다. 여기 화면은 매칭 미리보기만
 * 보여주고(서버와 같은 판정 함수 `bulkImportMatch.ts`를 그대로 쓴다),
 * 실제 파일은 그대로 서버로 보낸다 — 서버가 PNG 헤더만 읽어 저장하므로
 * 훨씬 단순하고 견고하다.
 *
 * 파일명 규칙(예: `수능특강_08강_3점_05번.png`, `수능완성_실전모의고사3회_07번.png`)이
 * 안 맞으면 매칭이 안 되므로, CSV에 `파일명,정답` 두 컬럼만 있는 형태도 함께
 * 받는다 — 어떤 이름 규칙이든 정답만 나란히 적어 오면 쓸 수 있게.
 *
 * **하나라도 안 맞으면 그 파일만 건너뛴다**(전체를 막지 않는다) — 맞는 것부터
 * 먼저 넣고, 안 맞은 것은 목록으로 보여줘 나중에 개별적으로 넣을 수 있게 한다.
 */
export default function BulkMappedImportPanel({ categoryId }: { categoryId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [images, setImages] = useState<File[]>([]);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvRows, setCsvRows] = useState<Record<string, string>[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<{ ok: number; failed: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { plan, skipped } = useMemo<{ plan: MatchedItem[]; skipped: SkippedItem[] }>(() => {
    if (images.length === 0 || !csvRows) return { plan: [], skipped: [] };
    return matchFiles(
      images.map((f) => f.name),
      csvRows,
    );
  }, [images, csvRows]);

  async function handleCsvFile(file: File) {
    try {
      const text = await file.text();
      setCsvRows(parseCsv(text));
      setCsvFile(file);
      setError(null);
    } catch {
      setError("CSV를 읽지 못했습니다.");
    }
  }

  async function runImport() {
    if (plan.length === 0 || !csvFile) return;
    setError(null);
    setDone(null);

    const matchedNames = new Set(plan.map((p) => p.name));
    const filesToUpload = images.filter((f) => matchedNames.has(f.name));
    const batches = chunkFiles(filesToUpload);

    let ok = 0;
    const failed: string[] = [];

    for (let i = 0; i < batches.length; i++) {
      setBusy(`올리는 중... (${i + 1}/${batches.length}묶음)`);
      const fd = new FormData();
      fd.set("categoryId", categoryId);
      fd.set("csv", csvFile);
      for (const f of batches[i]) fd.append("images", f);

      try {
        const res = await fetch("/api/bulk-import-mapped", { method: "POST", body: fd });
        const json = (await res.json()) as Partial<BatchResponse> & { error?: string };
        if (!res.ok) {
          failed.push(`${i + 1}번째 묶음 실패 — ${json.error ?? res.statusText}`);
          continue;
        }
        ok += json.ok ?? 0;
        if (Array.isArray(json.failed)) failed.push(...json.failed);
      } catch {
        failed.push(`${i + 1}번째 묶음 — 네트워크 오류`);
      }
    }

    setBusy(null);
    setDone({ ok, failed });
    router.refresh();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="self-start text-sm text-blue-600 underline underline-offset-2 hover:text-blue-800"
      >
        + 이미지 여러 장 + 정답 CSV로 한 번에 올리기
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-sm font-medium text-slate-700">
        이미지 여러 장 + 정답 CSV로 한 번에 올리기
      </p>
      <p className="text-xs text-slate-400">
        이미 깔끔하게 잘려 있는 사진(스크린샷 등)에 맞는 기능입니다 — 크롭·문제
        인식 없이 그림 그대로 저장하고 정답만 CSV에서 매칭합니다. 토큰이 들지
        않습니다.
      </p>

      <label className="flex flex-col gap-1 text-sm text-slate-700">
        이미지 파일들 (PNG)
        <input
          type="file"
          accept="image/png"
          multiple
          onChange={(e) => setImages(Array.from(e.target.files ?? []))}
          className="text-sm"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm text-slate-700">
        정답 CSV (교재,단원,구분,문항번호,정답 — 또는 파일명,정답)
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleCsvFile(f);
          }}
          className="text-sm"
        />
      </label>

      {images.length > 0 && csvRows && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
          <p className="font-medium text-slate-700">
            매칭 {plan.length}개 / 이미지 {images.length}개 중
          </p>
          {skipped.length > 0 && (
            <div className="mt-1.5">
              <p className="text-amber-700">건너뛴 {skipped.length}개 (CSV와 안 맞음):</p>
              <ul className="mt-1 max-h-24 list-inside list-disc overflow-y-auto text-slate-500">
                {skipped.slice(0, 20).map((s) => (
                  <li key={s.name}>
                    {s.name} — {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={plan.length === 0 || Boolean(busy)}
          onClick={() => void runImport()}
          className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {busy ?? `${plan.length}개 올리기`}
        </button>
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={() => {
            setOpen(false);
            setImages([]);
            setCsvFile(null);
            setCsvRows(null);
            setDone(null);
            setError(null);
          }}
          className="text-xs text-slate-500 hover:text-slate-700"
        >
          닫기
        </button>
      </div>

      {done && (
        <p className="text-sm">
          <span className="text-emerald-700">성공 {done.ok}개</span>
          {done.failed.length > 0 && (
            <span className="text-red-600"> · 실패 {done.failed.length}개</span>
          )}
          {done.failed.length > 0 && (
            <ul className="mt-1 list-inside list-disc text-xs text-red-600">
              {done.failed.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
        </p>
      )}
    </div>
  );
}
