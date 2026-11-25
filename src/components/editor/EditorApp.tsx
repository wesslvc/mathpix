"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { BOGI_LABELS, CIRCLED, newDoc, type QDoc, type QIndexRow } from "@/lib/editor/doc";
import { docHtml } from "@/lib/editor/render";
import { KICE_AREAS } from "@/lib/kiceSubjects";
import type { KiceArea } from "@/lib/kice/frames";

/**
 * **평가원 스타일 문항 제작 에디터**(무제한 계정 전용).
 * 왼쪽: 내 문항 목록(고르면 묶어서 내보내기) · 가운데: 문항 편집 + AI(sol) · 오른쪽: 평가원 문제지 모양 미리보기.
 * 문항은 R2 에 JSON 으로 저장된다(고치면 1.2초 뒤 저절로 저장).
 */

type AiResult = Record<string, unknown>;
type ReviewIssue = { where?: string; problem?: string; fix?: string };

const inputCls = "w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:border-slate-500 focus:outline-none";
const areaCls = `${inputCls} font-serif leading-relaxed`;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error || `요청 실패 (HTTP ${res.status})`);
  return body;
}

function download(bytes: Uint8Array, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name.replace(/[\\/:*?"<>|]/g, "_");
  a.click();
  URL.revokeObjectURL(url);
}

export default function EditorApp() {
  const [list, setList] = useState<QIndexRow[]>([]);
  const [doc, setDoc] = useState<QDoc | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const loadList = useCallback(async () => {
    const r = await api<{ items: QIndexRow[] }>("/api/editor");
    setList(r.items);
    return r.items;
  }, []);

  const open = useCallback(async (id: string) => {
    setErr(null);
    const r = await api<{ doc: QDoc }>(`/api/editor?id=${encodeURIComponent(id)}`);
    setDoc(r.doc);
    setDirty(false);
  }, []);

  useEffect(() => {
    loadList()
      .then((items) => {
        if (items[0]) void open(items[0].id);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [loadList, open]);

  // 저절로 저장
  const docRef = useRef(doc);
  docRef.current = doc;
  useEffect(() => {
    if (!dirty || !doc) return;
    const t = setTimeout(async () => {
      const d = docRef.current;
      if (!d) return;
      setSaving(true);
      try {
        await api("/api/editor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ doc: d }) });
        setDirty(false);
        void loadList();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    }, 1200);
    return () => clearTimeout(t);
  }, [doc, dirty, loadList]);

  const patch = (p: Partial<QDoc>) => {
    setDoc((d) => (d ? { ...d, ...p } : d));
    setDirty(true);
  };

  async function create() {
    const d = newDoc(crypto.randomUUID());
    d.number = (list.length % 20) + 1;
    setDoc(d);
    setDirty(true);
  }

  async function remove(id: string) {
    if (!window.confirm("이 문항을 지울까요? 되돌릴 수 없어요.")) return;
    await api(`/api/editor?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (doc?.id === id) setDoc(null);
    setSelected((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    await loadList();
  }

  async function ai(body: Record<string, unknown>, label: string): Promise<AiResult | null> {
    setBusy(label);
    setErr(null);
    try {
      return await api<AiResult>("/api/editor/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(null);
    }
  }

  const applyItem = (r: Record<string, unknown>) => {
    const s = (v: unknown) => (typeof v === "string" ? v : "");
    const choices = Array.isArray(r.choices) ? r.choices.slice(0, 5).map(s) : undefined;
    patch({
      ...(s(r.title) ? { title: s(r.title) } : {}),
      ...(typeof r.stem === "string" ? { stem: r.stem } : {}),
      ...(typeof r.question === "string" ? { question: r.question } : {}),
      ...(Array.isArray(r.bogi) ? { bogi: r.bogi.map(s).filter(Boolean) } : {}),
      ...(choices ? { choices: [...choices, "", "", "", "", ""].slice(0, 5) } : {}),
      ...(Number(r.answer) >= 1 && Number(r.answer) <= 5 ? { answer: Number(r.answer) } : {}),
      ...(typeof r.solution === "string" ? { solution: r.solution } : {}),
    });
  };

  if (err && !doc && list.length === 0) {
    return <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{err}</p>;
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[220px_minmax(0,1fr)_minmax(0,1fr)]">
      <ListPane
        list={list}
        current={doc?.id ?? null}
        selected={selected}
        setSelected={setSelected}
        onOpen={(id) => void open(id)}
        onCreate={() => void create()}
        onRemove={(id) => void remove(id)}
      />
      <div className="flex min-w-0 flex-col gap-3">
        {err && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
        {!doc ? (
          <p className="rounded-lg border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500">
            왼쪽에서 문항을 고르거나 <b>+ 새 문항</b>을 누르세요.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              {saving ? "저장 중…" : dirty ? "고친 내용 저장 대기" : "저장됨"}
              {busy && <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-800">{busy} — sol 이 생각 중이에요(1~3분)</span>}
            </div>
            <AiPanel doc={doc} busy={!!busy} ai={ai} applyItem={applyItem} />
            <DocForm doc={doc} patch={patch} busy={!!busy} ai={ai} />
          </>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        {doc && <Preview doc={doc} />}
        <ExportPane list={list} selected={selected} currentId={doc?.id ?? null} />
      </div>
    </div>
  );
}

function ListPane(props: {
  list: QIndexRow[];
  current: string | null;
  selected: Set<string>;
  setSelected: (fn: (s: Set<string>) => Set<string>) => void;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onRemove: (id: string) => void;
}) {
  const { list, current, selected, setSelected } = props;
  return (
    <aside className="flex flex-col gap-2">
      <Button type="button" onClick={props.onCreate}>
        + 새 문항
      </Button>
      <div className="flex max-h-[70vh] flex-col gap-1 overflow-y-auto">
        {list.map((r) => (
          <div key={r.id} className={`group flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm ${r.id === current ? "bg-slate-900 text-white" : "hover:bg-slate-100"}`}>
            <input
              type="checkbox"
              title="묶어서 내보내기"
              checked={selected.has(r.id)}
              onChange={(e) =>
                setSelected((s) => {
                  const n = new Set(s);
                  if (e.target.checked) n.add(r.id);
                  else n.delete(r.id);
                  return n;
                })
              }
            />
            <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => props.onOpen(r.id)}>
              {r.title || "제목 없음"}
              {r.subject && <span className="ml-1 text-xs opacity-60">{r.subject}</span>}
            </button>
            <button type="button" className="hidden text-xs opacity-60 hover:opacity-100 group-hover:inline" onClick={() => props.onRemove(r.id)}>
              ×
            </button>
          </div>
        ))}
        {list.length === 0 && <p className="px-2 py-4 text-xs text-slate-400">아직 만든 문항이 없어요.</p>}
      </div>
    </aside>
  );
}

function AiPanel({ doc, busy, ai, applyItem }: { doc: QDoc; busy: boolean; ai: (b: Record<string, unknown>, l: string) => Promise<AiResult | null>; applyItem: (r: Record<string, unknown>) => void }) {
  const [request, setRequest] = useState("");
  const [instruction, setInstruction] = useState("");
  const [review, setReview] = useState<{ solved?: number; issues: ReviewIssue[] } | null>(null);
  const [brief, setBrief] = useState("");

  async function draft() {
    const r = await ai({ action: "draft", request: `과목: ${doc.subject || "(미정)"}\n${request}` }, "초안 만들기");
    const item = r?.result as Record<string, unknown> | undefined;
    if (item) {
      applyItem(item);
      if (typeof item.figure_brief === "string" && item.figure_brief.trim()) setBrief(item.figure_brief);
    }
  }
  async function revise() {
    const r = await ai({ action: "revise", doc, instruction }, "지시대로 고치기");
    if (r?.result) applyItem(r.result as Record<string, unknown>);
  }
  async function check() {
    let figurePng: string | undefined;
    if (doc.figure) {
      const { svgToPngDataUrl } = await import("@/lib/editor/exportHwpx");
      figurePng = (await svgToPngDataUrl(doc.figure.svg)) ?? undefined;
    }
    const r = await ai({ action: "review", doc, figurePng }, "검수");
    const o = r?.result as { solved_answer?: number; issues?: ReviewIssue[] } | undefined;
    if (o) setReview({ solved: Number(o.solved_answer) || undefined, issues: Array.isArray(o.issues) ? o.issues : [] });
  }

  return (
    <details className="rounded-lg border border-slate-200 bg-slate-50 p-3" open>
      <summary className="cursor-pointer text-sm font-semibold text-slate-700">AI 도우미 (sol)</summary>
      <div className="mt-2 flex flex-col gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">새 문항 초안 — 단원·출제 의도·난이도·자료 형태를 적어 주세요</span>
          <textarea className={inputCls} rows={2} value={request} onChange={(e) => setRequest(e.target.value)} placeholder="예: 세계지리, 건조 기후 지역의 농업, 세계 지도에 지역 A~C 표시, <보기> ㄱㄴㄷ형, 3점" />
          <Button type="button" variant="outline" size="sm" disabled={busy || !request.trim()} onClick={() => void draft()}>
            초안 만들기 (지금 내용을 덮어써요)
          </Button>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">지시대로 고치기</span>
          <textarea className={inputCls} rows={2} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="예: 정답을 ④로 바꾸고 ㄷ을 더 헷갈리게" />
          <Button type="button" variant="outline" size="sm" disabled={busy || !instruction.trim()} onClick={() => void revise()}>
            고치기
          </Button>
        </label>
        <div className="flex flex-col gap-1">
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void check()}>
            검수 (sol 이 직접 풀고 문제점 찾기)
          </Button>
          {review && (
            <div className="rounded-md border border-slate-200 bg-white p-2 text-xs">
              <p>
                sol 이 푼 정답: <b>{review.solved ? CIRCLED[review.solved - 1] : "?"}</b> · 등록 정답: <b>{doc.answer ? CIRCLED[doc.answer - 1] : "없음"}</b>
                {review.solved && doc.answer && review.solved !== doc.answer && <span className="ml-1 text-red-600">— 다릅니다</span>}
              </p>
              {review.issues.length === 0 ? (
                <p className="text-emerald-700">지적 사항 없음</p>
              ) : (
                <ul className="mt-1 list-disc pl-4">
                  {review.issues.map((x, i) => (
                    <li key={i}>
                      <b>{x.where}</b> {x.problem} {x.fix && <span className="text-slate-500">→ {x.fix}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        {brief && (
          <p className="rounded-md bg-white px-2 py-1.5 text-xs text-slate-600">
            초안의 그림 설명이 아래 &lsquo;그림&rsquo; 칸에 들어갔어요: {brief.slice(0, 120)}
            {brief.length > 120 ? "…" : ""}
          </p>
        )}
      </div>
      <FigureBriefBridge brief={brief} />
    </details>
  );
}

/** 초안의 그림 설명을 그림 칸으로 넘긴다(전역 이벤트 — 두 패널이 서로를 몰라도 되게). */
function FigureBriefBridge({ brief }: { brief: string }) {
  useEffect(() => {
    if (brief) window.dispatchEvent(new CustomEvent("editor:figure-brief", { detail: brief }));
  }, [brief]);
  return null;
}

function DocForm({ doc, patch, busy, ai }: { doc: QDoc; patch: (p: Partial<QDoc>) => void; busy: boolean; ai: (b: Record<string, unknown>, l: string) => Promise<AiResult | null> }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-3 text-sm">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="col-span-2 flex flex-col gap-1">
          <span className="text-xs text-slate-500">제목(목록용)</span>
          <input className={inputCls} value={doc.title} onChange={(e) => patch({ title: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">과목</span>
          <input className={inputCls} value={doc.subject} placeholder="세계지리" onChange={(e) => patch({ subject: e.target.value })} />
        </label>
        <div className="flex gap-2">
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-xs text-slate-500">번호</span>
            <input className={inputCls} type="number" min={1} max={99} value={doc.number} onChange={(e) => patch({ number: Number(e.target.value) || 1 })} />
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-xs text-slate-500">배점</span>
            <select className={inputCls} value={doc.points} onChange={(e) => patch({ points: Number(e.target.value) })}>
              {[2, 3, 4].map((p) => (
                <option key={p} value={p}>
                  {p}점
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <p className="text-xs text-slate-400">표기: 빈 줄 = 문단 · $수식$ · **굵게** · __밑줄__</p>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-slate-500">발문·자료 글</span>
        <textarea className={areaCls} rows={4} value={doc.stem} onChange={(e) => patch({ stem: e.target.value })} />
      </label>
      <FigureEditor doc={doc} patch={patch} busy={busy} ai={ai} />
      <label className="flex flex-col gap-1">
        <span className="text-xs text-slate-500">묻는 문장</span>
        <input className={`${inputCls} font-serif`} value={doc.question} placeholder="이에 대한 설명으로 옳은 것만을 <보기>에서 있는 대로 고른 것은?" onChange={(e) => patch({ question: e.target.value })} />
      </label>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-slate-500">&lt;보기&gt; (비우면 상자 없음)</span>
        {doc.bogi.map((b, i) => (
          <div key={i} className="flex items-start gap-2">
            <span className="mt-1.5 w-4 font-serif">{BOGI_LABELS[i]}.</span>
            <textarea className={areaCls} rows={1} value={b} onChange={(e) => patch({ bogi: doc.bogi.map((x, k) => (k === i ? e.target.value : x)) })} />
            <button type="button" className="mt-1 text-xs text-red-600" onClick={() => patch({ bogi: doc.bogi.filter((_, k) => k !== i) })}>
              빼기
            </button>
          </div>
        ))}
        {doc.bogi.length < 6 && (
          <button type="button" className="self-start text-xs text-slate-600 underline" onClick={() => patch({ bogi: [...doc.bogi, ""] })}>
            + 보기 진술 추가
          </button>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-slate-500">선지 (동그라미를 눌러 정답 표시)</span>
        {doc.choices.map((c, i) => (
          <div key={i} className="flex items-center gap-2">
            <button
              type="button"
              title="정답으로"
              onClick={() => patch({ answer: doc.answer === i + 1 ? 0 : i + 1 })}
              className={`h-7 w-7 shrink-0 rounded-full border font-serif ${doc.answer === i + 1 ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300"}`}
            >
              {CIRCLED[i]}
            </button>
            <input className={`${inputCls} font-serif`} value={c} onChange={(e) => patch({ choices: doc.choices.map((x, k) => (k === i ? e.target.value : x)) })} />
          </div>
        ))}
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-slate-500">해설</span>
        <textarea className={areaCls} rows={4} value={doc.solution} onChange={(e) => patch({ solution: e.target.value })} />
      </label>
    </div>
  );
}

function FigureEditor({ doc, patch, busy, ai }: { doc: QDoc; patch: (p: Partial<QDoc>) => void; busy: boolean; ai: (b: Record<string, unknown>, l: string) => Promise<AiResult | null> }) {
  const [brief, setBrief] = useState("");
  const [note, setNote] = useState("");
  const [showCode, setShowCode] = useState(false);
  useEffect(() => {
    const on = (e: Event) => setBrief(String((e as CustomEvent).detail ?? ""));
    window.addEventListener("editor:figure-brief", on);
    return () => window.removeEventListener("editor:figure-brief", on);
  }, []);
  const fig = doc.figure;

  async function draw(edit: boolean) {
    const r = await ai({ action: "svg", brief, baseSvg: edit ? fig?.svg : undefined }, edit ? "그림 고치기" : "그림 그리기");
    if (r && typeof r.svg === "string") {
      patch({ figure: { svg: r.svg, widthPct: fig?.widthPct ?? 80, caption: fig?.caption } });
      setNote(typeof r.note === "string" ? r.note : "");
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-slate-200 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-slate-600">그림 (AI 가 SVG 로 그림)</span>
        {fig && (
          <>
            <label className="flex items-center gap-1 text-xs text-slate-500">
              폭
              <input type="range" min={30} max={100} value={fig.widthPct} onChange={(e) => patch({ figure: { ...fig, widthPct: Number(e.target.value) } })} />
              {fig.widthPct}%
            </label>
            <button type="button" className="text-xs underline" onClick={() => setShowCode((v) => !v)}>
              {showCode ? "SVG 코드 닫기" : "SVG 코드 보기·고치기"}
            </button>
            <button type="button" className="text-xs text-red-600 underline" onClick={() => patch({ figure: null })}>
              그림 빼기
            </button>
          </>
        )}
        <label className="cursor-pointer text-xs underline">
          SVG 파일 올리기
          <input
            type="file"
            accept=".svg,image/svg+xml"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const text = await f.text();
              patch({ figure: { svg: text, widthPct: fig?.widthPct ?? 80, caption: fig?.caption } });
            }}
          />
        </label>
      </div>
      <textarea
        className={inputCls}
        rows={3}
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        placeholder={fig ? "고칠 점을 적으세요(예: 지역 B 를 사하라 사막 남쪽 가장자리로, 범례 추가)" : "그릴 그림을 자세히 적으세요(요소·라벨·값·위치)"}
      />
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" disabled={busy || !brief.trim()} onClick={() => void draw(false)}>
          {fig ? "새로 그리기" : "그리기"}
        </Button>
        {fig && (
          <Button type="button" variant="outline" size="sm" disabled={busy || !brief.trim()} onClick={() => void draw(true)}>
            지금 그림 고치기
          </Button>
        )}
      </div>
      {note && <p className="text-xs text-slate-500">sol: {note}</p>}
      {fig && (
        <input className={`${inputCls} font-serif`} value={fig.caption ?? ""} placeholder="그림 아래 글(선택)" onChange={(e) => patch({ figure: { ...fig, caption: e.target.value } })} />
      )}
      {fig && showCode && (
        <textarea className={`${inputCls} font-mono text-xs`} rows={8} value={fig.svg} onChange={(e) => patch({ figure: { ...fig, svg: e.target.value } })} />
      )}
    </div>
  );
}

function Preview({ doc }: { doc: QDoc }) {
  const html = useMemo(() => ({ __html: docHtml(doc) }), [doc]);
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <p className="mb-2 text-xs text-slate-500">미리보기 (평가원 문제지 한 단 폭)</p>
      <div className="overflow-x-auto">
        <div style={{ width: 400, maxWidth: "100%" }} dangerouslySetInnerHTML={html} />
      </div>
    </div>
  );
}

function ExportPane({ list, selected, currentId }: { list: QIndexRow[]; selected: Set<string>; currentId: string | null }) {
  const [area, setArea] = useState<KiceArea>("사회탐구");
  const [subject, setSubject] = useState("");
  const [title, setTitle] = useState("");
  const [withAnswers, setWithAnswers] = useState(true);
  const [withSolutions, setWithSolutions] = useState(true);
  const [progress, setProgress] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ids = selected.size ? list.filter((r) => selected.has(r.id)).map((r) => r.id) : currentId ? [currentId] : [];

  async function loadDocs(): Promise<QDoc[]> {
    const docs: QDoc[] = [];
    for (const id of ids) docs.push((await api<{ doc: QDoc }>(`/api/editor?id=${encodeURIComponent(id)}`)).doc);
    return docs.sort((a, b) => a.number - b.number);
  }

  async function run(kind: "pdf" | "hwpx") {
    setErr(null);
    try {
      setProgress("문항 불러오는 중…");
      const docs = await loadDocs();
      const name = title.trim() || docs[0]?.title || "문항";
      if (kind === "pdf") {
        const { docsToPdf } = await import("@/lib/editor/exportPdf");
        const bytes = await docsToPdf(docs, { title, area, subject, withAnswers, withSolutions }, setProgress);
        download(bytes, `${name}.pdf`, "application/pdf");
      } else {
        setProgress("한글 파일 만드는 중…");
        const { docsToHwpx } = await import("@/lib/editor/exportHwpx");
        const bytes = await docsToHwpx(docs, withSolutions);
        download(bytes, `${name}.hwpx`, "application/hwp+zip");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3 text-sm">
      <p className="font-semibold text-slate-700">내보내기 — {selected.size ? `고른 ${ids.length}문항` : "지금 문항"}</p>
      <div className="grid grid-cols-2 gap-2">
        <select className={inputCls} value={area} onChange={(e) => setArea(e.target.value as KiceArea)}>
          {KICE_AREAS.map((a) => (
            <option key={a} value={a}>
              {a} 틀
            </option>
          ))}
        </select>
        <input className={inputCls} value={subject} placeholder="과목명(탐구: 세계지리)" onChange={(e) => setSubject(e.target.value)} />
        <input className={`${inputCls} col-span-2`} value={title} placeholder="표지 제목(예: 2028학년도 세계지리 모의평가)" onChange={(e) => setTitle(e.target.value)} />
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={withAnswers} onChange={(e) => setWithAnswers(e.target.checked)} /> 정답표 (PDF)
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={withSolutions} onChange={(e) => setWithSolutions(e.target.checked)} /> 해설
      </label>
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={!ids.length || !!progress} onClick={() => void run("pdf")}>
          PDF (평가원 틀)
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={!ids.length || !!progress} onClick={() => void run("hwpx")}>
          한글 (HWPX)
        </Button>
      </div>
      {progress && <p className="text-xs text-slate-500">{progress}</p>}
      {err && <p className="text-xs text-red-600">{err}</p>}
      <p className="text-xs text-slate-400">HWPX 첫 버전: 수식은 읽을 수 있는 글자로, 그림은 PNG 로 들어가요.</p>
    </div>
  );
}
