"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  SAVED_KEY_KIND_LABEL,
  listSavedAnswerKeys,
  type SavedKeyKind,
  type SavedKeySource,
} from "@/lib/savedAnswerKeys";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";

const KIND_ORDER: SavedKeyKind[] = ["problems", "key", "grade"];

/** 정답 미리보기 한 줄 — "1 ③ · 2 ⑤ · 3 12 …" (객관식 숫자는 원숫자로). */
function previewLine(src: SavedKeySource, max = 12): string {
  const circled = "①②③④⑤⑥⑦⑧⑨";
  const shown = src.items.slice(0, max).map((it) => {
    const a = /^[1-9]$/.test(it.answer) ? circled[Number(it.answer) - 1] : it.answer;
    return `${it.no} ${a}`;
  });
  return shown.join(" · ") + (src.items.length > max ? " …" : "");
}

/**
 * **저장돼 있는 정답표 하나를 고른다** — 다른 실모의 문제 정답 · 읽어 둔 답지 · 채점 기록 중에서
 * (`savedAnswerKeys.ts`). 누르기 전까지는 아무것도 안 읽는다(링크 하나로 접혀 있다).
 */
export default function SavedKeyPicker({
  onPick,
  excludeCategoryId,
  label = "저장된 정답표 불러오기",
  defaultOpen = false,
}: {
  onPick: (src: SavedKeySource) => void;
  excludeCategoryId?: string;
  label?: string;
  /** 처음부터 펼쳐 둔다(“불러오기”를 눌러 들어온 화면). */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<SavedKeySource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState("");

  async function openPicker() {
    setOpen(true);
    setError(null);
    if (sources) return;
    try {
      setSources(await listSavedAnswerKeys(createClient(), { excludeCategoryId }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "정답표 목록을 불러오지 못했어요.");
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = sources ?? [];
    return q ? list.filter((s) => `${s.title} ${s.detail}`.toLowerCase().includes(q)) : list;
  }, [sources, query]);

  useEffect(() => {
    if (defaultOpen) void openPicker();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const picked = filtered.find((s) => s.id === chosen) ?? sources?.find((s) => s.id === chosen);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => void openPicker()}
        className="self-start text-xs text-blue-600 underline underline-offset-2 hover:text-blue-800"
      >
        {label}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-blue-200 bg-blue-50/40 p-3">
      <p className="text-xs font-medium text-slate-700">저장된 정답표에서 불러오기</p>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {!sources && !error && <p className="text-xs text-slate-400">불러오는 중…</p>}
      {sources && sources.length === 0 && (
        <p className="text-xs text-slate-500">
          불러올 정답표가 없어요. 다른 실모에 정답을 넣어 두거나 답지를 읽어 두거나 채점을 한 번 하면 여기 나와요.
        </p>
      )}
      {sources && sources.length > 0 && (
        <>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="이름으로 찾기"
            className="h-8 text-xs"
          />
          <NativeSelect value={chosen} onChange={(e) => setChosen(e.target.value)} className="text-xs">
            <option value="">정답표를 고르세요 ({filtered.length}개)</option>
            {KIND_ORDER.map((kind) => {
              const group = filtered.filter((s) => s.kind === kind);
              if (group.length === 0) return null;
              return (
                <optgroup key={kind} label={SAVED_KEY_KIND_LABEL[kind]}>
                  {group.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title} — {s.detail}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </NativeSelect>
          {picked && (
            <p className="break-words text-[11px] leading-5 text-slate-500">
              <span className="font-medium text-slate-700">{SAVED_KEY_KIND_LABEL[picked.kind]}</span> · {picked.detail}
              <br />
              {previewLine(picked)}
            </p>
          )}
        </>
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="primary"
          disabled={!picked}
          onClick={() => {
            if (!picked) return;
            onPick(picked);
            setOpen(false);
            setChosen("");
          }}
        >
          불러오기
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          닫기
        </Button>
      </div>
    </div>
  );
}
