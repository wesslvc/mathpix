"use client";

import { useEffect, useState } from "react";

/**
 * **27수능 수고하셨습니다 — 기존 데이터 받기.** 사이트를 문항 제작 에디터로 바꾸기 전에, 로그인한 사람이
 * 그동안 저장한 문제 이미지와 성적을 ZIP(이미지 + 엑셀) 하나로 받아 가게 한다. 서버가 ZIP 을 R2 에 만들어 두고
 * 내려받기 주소를 준다(브라우저는 R2 에서 바로 받는다). 닫으면 이 기기에서는 다시 안 뜬다.
 */
const KEY = "reprint.archiveBanner.closed";

export default function ArchiveBanner() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    try {
      setOpen(localStorage.getItem(KEY) !== "1");
    } catch {
      setOpen(true);
    }
  }, []);

  if (!open) return null;

  async function run() {
    setBusy(true);
    setErr(null);
    setMsg("문제 이미지와 성적을 묶는 중이에요… 문제가 많으면 몇 분 걸려요. 이 창을 열어 두세요.");
    try {
      const res = await fetch("/api/archive", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string; bytes?: number; images?: number; missing?: number; scores?: number };
      if (!res.ok || !body.url) throw new Error(body.error || `실패했어요 (HTTP ${res.status})`);
      setUrl(body.url);
      const mb = ((body.bytes ?? 0) / 1024 / 1024).toFixed(1);
      setMsg(
        `준비됐어요 — 이미지 ${body.images ?? 0}장 · 성적 ${body.scores ?? 0}건 · ${mb}MB${body.missing ? ` (받지 못한 이미지 ${body.missing}장은 '읽어 주세요.txt' 에 적어 뒀어요)` : ""}. 받기 링크는 7일 동안 열려 있어요.`,
      );
      window.location.href = body.url;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "실패했어요.");
      setMsg(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-b border-amber-200 bg-amber-50">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-sm text-amber-900">
        <span className="font-semibold">27수능 수고하셨습니다 🎉</span>
        <span className="min-w-[12rem] flex-1 text-amber-800">
          {msg ?? "그동안 저장한 문제 이미지와 성적(엑셀)을 ZIP 하나로 받아 갈 수 있어요."}
          {err && <span className="ml-1 text-red-700">{err}</span>}
        </span>
        {url ? (
          <a href={url} className="rounded-md bg-amber-600 px-3 py-1.5 font-medium text-white hover:bg-amber-700">
            다시 받기
          </a>
        ) : (
          <button type="button" disabled={busy} onClick={run} className="rounded-md bg-amber-600 px-3 py-1.5 font-medium text-white hover:bg-amber-700 disabled:opacity-60">
            {busy ? "묶는 중…" : "기존 데이터 받기"}
          </button>
        )}
        <button
          type="button"
          aria-label="닫기"
          className="px-1 text-amber-700 hover:text-amber-900"
          onClick={() => {
            try {
              localStorage.setItem(KEY, "1");
            } catch {
              /* 무시 */
            }
            setOpen(false);
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}
