"use client";

import { useMemo, useState } from "react";
import { loadPng } from "@/lib/kice/loadPng";
import { answersCsv, planZip, safeName, type ZipItem } from "@/lib/zipExport";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/**
 * 문제 이미지를 **ZIP** 으로 내려받는다(PDF 내보내기 옆). 정답은 `정답.csv` 로 따로 묶는다.
 *
 * - 여러 실모를 골라 들어왔으면 실모마다 폴더로 나눈다(끌 수 있다). 아래 체크로 이 중 일부만 담을 수도 있다.
 * - 이미지는 PDF 와 같은 길(`loadPng`)로 받아 옛 카드 테두리를 지운다. 번호는 **원래 번호**를 쓴다(1번부터 새로
 *   매기는 건 PDF 의 기능이다).
 * - 받지 못한 그림이 있어도 나머지는 묶고, 빠진 것을 화면에 알린다 — 조용히 빠지면 문제가 없어진 줄 안다.
 */

type Props = {
  title: string;
  items: ZipItem[];
};

/** 한꺼번에 받는 그림 수. 많이 열면 브라우저·R2 가 숨차고, 적으면 느리다. */
const FETCH_LANES = 6;

export default function ZipExportPanel({ title, items }: Props) {
  const sources = useMemo(() => [...new Set(items.map((it) => it.source))], [items]);
  const multi = sources.length > 1;
  const [picked, setPicked] = useState<Set<string>>(() => new Set(sources));
  const [byFolder, setByFolder] = useState(true);
  const [withCsv, setWithCsv] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const chosen = useMemo(
    () => items.filter((it) => !multi || picked.has(it.source)),
    [items, multi, picked],
  );

  function toggle(source: string) {
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  }

  async function generate() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { default: JSZip } = await import("jszip");
      const entries = planZip(chosen, multi && byFolder);
      const zip = new JSZip();

      // 그림을 몇 개씩 겹쳐 받는다. 실패한 것은 기록만 하고 계속한다.
      const failed: string[] = [];
      let next = 0;
      let done = 0;
      setProgress(`이미지 받는 중 0/${entries.length}`);
      const lane = async () => {
        while (next < entries.length) {
          const e = entries[next++];
          try {
            zip.file(e.path, await loadPng(e.item.imageUrl), { binary: true });
          } catch {
            failed.push(e.path);
          }
          setProgress(`이미지 받는 중 ${++done}/${entries.length}`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(FETCH_LANES, entries.length) }, lane));
      if (failed.length === entries.length) throw new Error("이미지를 하나도 받지 못했습니다. 잠시 뒤 다시 시도해 주세요.");

      if (withCsv) {
        // 받지 못한 그림의 줄은 CSV 에서도 뺀다 — 파일이 없는데 줄만 있으면 어긋난다.
        const gone = new Set(failed);
        zip.file("정답.csv", answersCsv(entries.filter((e) => !gone.has(e.path))));
      }

      setProgress("ZIP 묶는 중 0%");
      // PNG 는 이미 압축돼 있어 다시 압축해 봐야 시간만 든다.
      const blob = await zip.generateAsync(
        { type: "blob", compression: "STORE" },
        (meta) => setProgress(`ZIP 묶는 중 ${Math.round(meta.percent)}%`),
      );

      const link = document.createElement("a");
      const objectUrl = URL.createObjectURL(blob);
      link.href = objectUrl;
      link.download = `${safeName(title, "오답모음")}.zip`;
      link.click();
      // 바로 해제하면 일부 브라우저가 내려받기를 시작하기 전에 주소가 사라진다.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);

      if (failed.length > 0) {
        setNotice(`${failed.length}개는 받지 못해 빠졌어요: ${failed.slice(0, 5).join(", ")}${failed.length > 5 ? " …" : ""}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "ZIP 만들기에 실패했습니다.");
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }

  const problemCount = chosen.filter((it) => !it.passage).length;

  return (
    <Card className="flex flex-col gap-4 p-4 sm:p-5">
      <div>
        <h2 className="text-sm font-semibold text-slate-700">문제 이미지 ZIP</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          문제 그림을 한 장씩 PNG 로 묶고, 정답은 엑셀에서 바로 열리는 <b>정답.csv</b> 로 함께 담아요. 위의 인쇄 순서가 파일
          순서(앞 번호)가 됩니다.
        </p>
      </div>

      {multi && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-sm font-medium text-slate-700">담을 실모</span>
            <button
              type="button"
              onClick={() => setPicked(new Set(sources))}
              className="text-xs text-blue-700 underline hover:text-blue-900"
            >
              전체선택
            </button>
            <button
              type="button"
              onClick={() => setPicked(new Set())}
              className="text-xs text-blue-700 underline hover:text-blue-900"
            >
              선택 해제
            </button>
          </div>
          <ul className="flex flex-col gap-1">
            {sources.map((s) => (
              <li key={s}>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={picked.has(s)} onChange={() => toggle(s)} className="h-4 w-4" />
                  <span className="min-w-0 flex-1 truncate">{s}</span>
                  <span className="shrink-0 text-xs text-slate-400">
                    {items.filter((it) => it.source === s && !it.passage).length}문제
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={byFolder} onChange={(e) => setByFolder(e.target.checked)} className="h-4 w-4" />
            실모별 폴더로 나누기
          </label>
        </div>
      )}

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={withCsv} onChange={(e) => setWithCsv(e.target.checked)} className="h-4 w-4" />
        정답.csv 함께 담기
        <span className="text-xs text-slate-400">파일 · 실모 · 문제번호 · 정답 · 내가 고른 답</span>
      </label>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-amber-700">{notice}</p>}

      <div className="flex justify-end">
        <Button
          type="button"
          onClick={generate}
          disabled={busy || chosen.length === 0}
          variant="primary"
          className="px-5 py-2.5 text-sm"
        >
          {busy ? (progress ?? "ZIP 만드는 중...") : `ZIP 내려받기 (${problemCount}문제)`}
        </Button>
      </div>
    </Card>
  );
}
