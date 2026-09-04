"use client";

import { useRef, useState } from "react";
import { KICE_FONT_NAMES } from "@/lib/kice/fonts";

/**
 * **PC 없이 평가원 글꼴을 올린다.**
 *
 * `scripts/upload-kice-fonts.mjs`는 `pyftsubset`(Python)로 미리 잘라 둔
 * 파일을 요구해 컴퓨터가 있어야 했다. 여기서는 원본 TTF를 **그대로** 올리면
 * 서버가 `subset-font`(harfbuzz WASM)로 대신 잘라 준다 — 휴대폰 브라우저
 * 하나로 끝난다.
 *
 * 큰 파일은 조각내 보낸다(Vercel 요청 본문 4.5MB 제한, `BulkMappedImportPanel`
 * 과 같은 이유). 누구나 쓸 수 있는 화면은 아니다 — 서버가 무제한 계정인지
 * 확인하고 아니면 막는다(`requireFontAdmin`).
 */

const CHUNK_BYTES = 3.5 * 1024 * 1024;

type Result = {
  file: string;
  originalBytes: number;
  subsetBytes: number;
  missing: string[];
};

const kb = (n: number) => `${Math.round(n / 1024)}KB`;

export default function KiceFontAdminPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fontName, setFontName] = useState(KICE_FONT_NAMES[KICE_FONT_NAMES.length - 1]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setBusy("준비하는 중...");
    setError(null);
    setResult(null);

    const uploadId = crypto.randomUUID();
    const total = Math.max(1, Math.ceil(file.size / CHUNK_BYTES));

    try {
      for (let i = 0; i < total; i++) {
        setBusy(`올리는 중... (${i + 1}/${total})`);
        const chunk = file.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
        const form = new FormData();
        form.append("uploadId", uploadId);
        form.append("index", String(i));
        form.append("chunk", chunk);
        const res = await fetch("/api/admin/kice-font/chunk", { method: "POST", body: form });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json.error ?? `조각 ${i + 1}을 올리지 못했습니다.`);
        }
      }

      setBusy("글자를 추려 올리는 중... (시간이 좀 걸립니다)");
      const res = await fetch("/api/admin/kice-font/finish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId, total, fontName }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "처리에 실패했습니다.");
      setResult(json as Result);
      if (fileRef.current) fileRef.current.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : "알 수 없는 오류입니다.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col gap-4 px-4 py-10">
      <h1 className="text-xl font-semibold text-ink">평가원 글꼴 올리기</h1>
      <p className="text-sm text-slate-500">
        원본 TTF 파일을 그대로 고르면 서버가 필요한 글자만 잘라 올립니다.
        (한)신중명조는 자유롭게 타이핑하는 글(정답표·제목·지문)에 쓰여
        <b> 완성형 한글 전체</b>를 남기고, 나머지 넷은 문제지 틀에 쓰인
        글자만 남깁니다.
      </p>

      <label className="flex flex-col gap-1 text-sm text-slate-700">
        어느 글꼴인가요
        <select
          value={fontName}
          onChange={(e) => setFontName(e.target.value)}
          className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
        >
          {KICE_FONT_NAMES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>

      <input
        ref={fileRef}
        type="file"
        accept=".ttf,.otf,font/ttf,font/otf"
        className="text-sm"
      />

      <button
        type="button"
        onClick={() => void upload()}
        disabled={busy !== null}
        className="self-start rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {busy ?? "올리기"}
      </button>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {result && (
        <div className="flex flex-col gap-1 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <p>
            <b>{result.file}</b> 로 올렸습니다 — {kb(result.originalBytes)} →{" "}
            {kb(result.subsetBytes)}
          </p>
          {result.missing.length > 0 ? (
            <p className="text-amber-800">
              이 원본 글꼴에 없는 글자 {result.missing.length}자: {result.missing.join(" ")}
              <br />
              그 글자는 다른 글꼴로 대신 그려지거나(다른 서체) 빠집니다 — 원본
              글꼴에 아예 없어서 우리가 만들 수는 없습니다.
            </p>
          ) : (
            <p>필요한 글자가 전부 있습니다.</p>
          )}
        </div>
      )}
    </main>
  );
}
