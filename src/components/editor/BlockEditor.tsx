"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { BLOCK_LABELS, newBlock, type Block, type BlockKind, type FigureBlock } from "@/lib/editor/blocks";
import { FILLS, FILL_LABELS, MARKERS, parseTable, specFromTable, tableFromSpec, type ChartSpec, type ChartType } from "@/lib/editor/chart";

const MapTool = dynamic(() => import("./MapTool"), { ssr: false });

/**
 * **자료 블록 편집기** — 블록을 더하고·순서를 바꾸고·고친다. 상자·나란히·(가)(나) 는 안에 블록을 품으므로 같은 편집기를 다시 쓴다.
 */
const inputCls = "w-full rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-slate-500 focus:outline-none";
const areaCls = `${inputCls} font-serif leading-relaxed`;
const sel = "rounded border border-slate-300 px-1 py-0.5 text-xs";

export type UploadFn = (file: File) => Promise<string | null>;

const KINDS: BlockKind[] = ["text", "box", "dialog", "table", "figure", "bubble", "row", "labeled"];

export function BlocksEditor({ blocks, onChange, upload, depth = 0 }: { blocks: Block[]; onChange: (b: Block[]) => void; upload: UploadFn; depth?: number }) {
  const set = (i: number, b: Block) => onChange(blocks.map((x, k) => (k === i ? b : x)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= blocks.length) return;
    const n = blocks.slice();
    [n[i], n[j]] = [n[j], n[i]];
    onChange(n);
  };
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((b, i) => (
        <div key={i} className={`rounded-md border ${depth ? "border-slate-200 bg-white" : "border-slate-300 bg-slate-50"} p-2`}>
          <div className="mb-1.5 flex items-center gap-2 text-xs text-slate-500">
            <b className="text-slate-700">{BLOCK_LABELS[b.kind]}</b>
            <span className="flex-1" />
            <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="disabled:opacity-30">
              ▲
            </button>
            <button type="button" onClick={() => move(i, 1)} disabled={i === blocks.length - 1} className="disabled:opacity-30">
              ▼
            </button>
            <button type="button" onClick={() => onChange([...blocks.slice(0, i + 1), JSON.parse(JSON.stringify(b)), ...blocks.slice(i + 1)])}>
              복제
            </button>
            <button type="button" className="text-red-600" onClick={() => onChange(blocks.filter((_, k) => k !== i))}>
              빼기
            </button>
          </div>
          <BlockForm block={b} onChange={(nb) => set(i, nb)} upload={upload} depth={depth} />
        </div>
      ))}
      <AddBlock onAdd={(k) => onChange([...blocks, newBlock(k)])} depth={depth} />
    </div>
  );
}

function AddBlock({ onAdd, depth }: { onAdd: (k: BlockKind) => void; depth: number }) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      <span className="text-slate-400">+ 더하기:</span>
      {KINDS.filter((k) => depth < 3 || (k !== "box" && k !== "row" && k !== "labeled")).map((k) => (
        <button key={k} type="button" onClick={() => onAdd(k)} className="rounded border border-slate-300 bg-white px-1.5 py-0.5 hover:bg-slate-100">
          {BLOCK_LABELS[k]}
        </button>
      ))}
    </div>
  );
}

function FontPick({ value, onChange }: { value?: "serif" | "gothic"; onChange: (v: "serif" | "gothic" | undefined) => void }) {
  return (
    <select className={sel} value={value ?? "serif"} onChange={(e) => onChange(e.target.value === "gothic" ? "gothic" : undefined)}>
      <option value="serif">명조</option>
      <option value="gothic">고딕</option>
    </select>
  );
}

function BlockForm({ block: b, onChange, upload, depth }: { block: Block; onChange: (b: Block) => void; upload: UploadFn; depth: number }) {
  switch (b.kind) {
    case "text":
      return (
        <div className="flex flex-col gap-1">
          <textarea className={areaCls} rows={3} value={b.text} onChange={(e) => onChange({ ...b, text: e.target.value })} placeholder="글 (줄 앞에 ○ · • · 1. 을 쓰면 내어쓰기)" />
          <div className="flex flex-wrap gap-2 text-xs">
            <FontPick value={b.font} onChange={(font) => onChange({ ...b, font })} />
            <select className={sel} value={b.align ?? "justify"} onChange={(e) => onChange({ ...b, align: e.target.value as "left" })}>
              <option value="justify">양쪽</option>
              <option value="left">왼쪽</option>
              <option value="center">가운데</option>
              <option value="right">오른쪽</option>
            </select>
            <select className={sel} value={b.size ?? "m"} onChange={(e) => onChange({ ...b, size: e.target.value as "m" })}>
              <option value="s">작게</option>
              <option value="m">보통</option>
              <option value="l">크게</option>
            </select>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={!!b.bold} onChange={(e) => onChange({ ...b, bold: e.target.checked || undefined })} /> 굵게
            </label>
          </div>
        </div>
      );
    case "box":
      return (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <input className={`${inputCls} max-w-[12rem]`} value={b.title ?? ""} placeholder="제목(예: <보 기>, 자료)" onChange={(e) => onChange({ ...b, title: e.target.value })} />
            <select className={sel} value={b.titlePos ?? "border"} onChange={(e) => onChange({ ...b, titlePos: e.target.value as "border" })}>
              <option value="border">제목: 테두리 위</option>
              <option value="top">제목: 상자 머리</option>
              <option value="none">제목 없음</option>
            </select>
            <select className={sel} value={b.frame ?? "plain"} onChange={(e) => onChange({ ...b, frame: e.target.value as "plain" })}>
              <option value="plain">실선</option>
              <option value="round">둥근 모서리</option>
              <option value="dash">점선</option>
              <option value="double">겹선</option>
              <option value="window">창(머리 띠)</option>
              <option value="none">테두리 없음</option>
            </select>
            <FontPick value={b.font} onChange={(font) => onChange({ ...b, font })} />
          </div>
          <BlocksEditor blocks={b.blocks} onChange={(blocks) => onChange({ ...b, blocks })} upload={upload} depth={depth + 1} />
        </div>
      );
    case "dialog":
      return (
        <div className="flex flex-col gap-1">
          {b.lines.map((l, i) => (
            <div key={i} className="flex gap-1">
              <input className={`${inputCls} w-16 flex-none`} value={l.who} onChange={(e) => onChange({ ...b, lines: b.lines.map((x, k) => (k === i ? { ...x, who: e.target.value } : x)) })} />
              <textarea className={areaCls} rows={1} value={l.text} onChange={(e) => onChange({ ...b, lines: b.lines.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)) })} />
              <button type="button" className="text-xs text-red-600" onClick={() => onChange({ ...b, lines: b.lines.filter((_, k) => k !== i) })}>
                ×
              </button>
            </div>
          ))}
          <div className="flex gap-2 text-xs">
            <button type="button" className="underline" onClick={() => onChange({ ...b, lines: [...b.lines, { who: "", text: "" }] })}>
              + 말 더하기
            </button>
            <FontPick value={b.font} onChange={(font) => onChange({ ...b, font })} />
          </div>
        </div>
      );
    case "table":
      return <TableForm block={b} onChange={onChange} upload={upload} />;
    case "figure":
      return <FigureForm block={b} onChange={onChange} upload={upload} />;
    case "bubble":
      return (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <input className={`${inputCls} w-24`} value={b.who ?? ""} placeholder="이름(선택)" onChange={(e) => onChange({ ...b, who: e.target.value })} />
            <select className={sel} value={b.side ?? "left"} onChange={(e) => onChange({ ...b, side: e.target.value === "right" ? "right" : "left" })}>
              <option value="left">사람 왼쪽</option>
              <option value="right">사람 오른쪽</option>
            </select>
            <ImagePick upload={upload} label={b.src ? "사람 그림 바꾸기" : "사람 그림 올리기"} onPick={(src) => onChange({ ...b, src })} />
            {b.src && (
              <button type="button" className="text-red-600 underline" onClick={() => onChange({ ...b, src: undefined })}>
                기본 그림으로
              </button>
            )}
            <FontPick value={b.font} onChange={(font) => onChange({ ...b, font })} />
          </div>
          <textarea className={areaCls} rows={2} value={b.text} onChange={(e) => onChange({ ...b, text: e.target.value })} placeholder="말" />
        </div>
      );
    case "row":
      return (
        <div className="flex flex-col gap-1">
          <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.max(1, b.cols.length)}, minmax(0,1fr))` }}>
            {b.cols.map((c, i) => (
              <div key={i} className="flex flex-col gap-1 rounded border border-dashed border-slate-300 p-1">
                <div className="flex text-[11px] text-slate-400">
                  {i + 1}칸<span className="flex-1" />
                  {b.cols.length > 1 && (
                    <button type="button" className="text-red-600" onClick={() => onChange({ ...b, cols: b.cols.filter((_, k) => k !== i) })}>
                      칸 빼기
                    </button>
                  )}
                </div>
                <BlocksEditor blocks={c} onChange={(nc) => onChange({ ...b, cols: b.cols.map((x, k) => (k === i ? nc : x)) })} upload={upload} depth={depth + 1} />
              </div>
            ))}
          </div>
          {b.cols.length < 4 && (
            <button type="button" className="self-start text-xs underline" onClick={() => onChange({ ...b, cols: [...b.cols, [{ kind: "text", text: "" }]] })}>
              + 칸 더하기
            </button>
          )}
        </div>
      );
    case "labeled":
      return (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-xs">
            <input className={`${inputCls} w-20`} value={b.label} onChange={(e) => onChange({ ...b, label: e.target.value })} />
            <select className={sel} value={b.pos ?? "left"} onChange={(e) => onChange({ ...b, pos: e.target.value === "top" ? "top" : "left" })}>
              <option value="left">표지 왼쪽</option>
              <option value="top">표지 위 가운데</option>
            </select>
          </div>
          <BlocksEditor blocks={b.blocks} onChange={(blocks) => onChange({ ...b, blocks })} upload={upload} depth={depth + 1} />
        </div>
      );
  }
}

function ImagePick({ upload, label, onPick }: { upload: UploadFn; label: string; onPick: (src: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <label className="cursor-pointer text-xs underline">
      {busy ? "올리는 중…" : label}
      <input
        type="file"
        accept="image/*"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          setBusy(true);
          try {
            const src = await upload(f);
            if (src) onPick(src);
          } finally {
            setBusy(false);
          }
        }}
      />
    </label>
  );
}

function TableForm({ block: b, onChange, upload }: { block: Extract<Block, { kind: "table" }>; onChange: (b: Block) => void; upload: UploadFn }) {
  const n = Math.max(1, ...b.rows.map((r) => r.length));
  const setCell = (ri: number, ci: number, v: string) =>
    onChange({ ...b, rows: b.rows.map((r, i) => (i === ri ? Array.from({ length: n }, (_, k) => (k === ci ? v : r[k] ?? "")) : r)) });
  return (
    <div className="flex flex-col gap-1">
      <div className="overflow-x-auto">
        <table className="border-collapse text-xs">
          <tbody>
            {b.rows.map((r, ri) => (
              <tr key={ri}>
                {Array.from({ length: n }, (_, ci) => (
                  <td key={ci} className="p-0.5">
                    <textarea className={`${inputCls} min-w-[5rem] font-serif ${ri < (b.header ?? 0) ? "bg-slate-100" : ""}`} rows={1} value={r[ci] ?? ""} onChange={(e) => setCell(ri, ci, e.target.value)} />
                  </td>
                ))}
                <td>
                  <button type="button" className="px-1 text-red-600" onClick={() => onChange({ ...b, rows: b.rows.filter((_, k) => k !== ri) })}>
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button type="button" className="underline" onClick={() => onChange({ ...b, rows: [...b.rows, Array(n).fill("")] })}>
          + 줄
        </button>
        <button type="button" className="underline" onClick={() => onChange({ ...b, rows: b.rows.map((r) => [...r, ""]) })}>
          + 칸
        </button>
        {n > 1 && (
          <button type="button" className="underline" onClick={() => onChange({ ...b, rows: b.rows.map((r) => r.slice(0, n - 1)) })}>
            − 끝 칸
          </button>
        )}
        <label className="flex items-center gap-1">
          머리 줄
          <select className={sel} value={b.header ?? 0} onChange={(e) => onChange({ ...b, header: Number(e.target.value) })}>
            {[0, 1, 2, 3].map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          폭
          <input type="range" min={30} max={100} value={b.widthPct ?? 100} onChange={(e) => onChange({ ...b, widthPct: Number(e.target.value) })} />
          {b.widthPct ?? 100}%
        </label>
        <FontPick value={b.font} onChange={(font) => onChange({ ...b, font })} />
        <ImagePick
          upload={upload}
          label="칸에 그림(끝 칸)"
          onPick={(src) => onChange({ ...b, rows: b.rows.map((r, i) => (i === b.rows.length - 1 ? [...r.slice(0, n - 1), `[img:${src}]`] : r)) })}
        />
      </div>
      <p className="text-[11px] text-slate-400">칸 합치기: 칸에 &lt; 를 적으면 왼쪽 칸과, ^ 를 적으면 위 칸과 합쳐져요. 칸 안 줄바꿈 가능.</p>
    </div>
  );
}

const CHART_TYPES: { v: ChartType; l: string }[] = [
  { v: "bar", l: "막대" },
  { v: "stacked", l: "쌓인 막대" },
  { v: "hbar100", l: "가로 100% 막대" },
  { v: "line", l: "꺾은선" },
  { v: "area", l: "누적 영역" },
  { v: "dotrange", l: "두 시점 점" },
  { v: "radar", l: "방사형" },
  { v: "bubble", l: "거품" },
  { v: "venn", l: "벤 다이어그램" },
];

const CHART_SAMPLE: Record<ChartType, string> = {
  bar: "월, 강수량, 기온\n1월, 20, -3\n7월, 280, 25",
  stacked: "국가, 1차, 2차, 3차\nA, 10, 30, 60\nB, 40, 20, 40",
  hbar100: "연도, 청년, 중장년, 노년\n2000, 40, 45, 15\n2020, 25, 45, 30",
  line: "연도, A, B\n2000, 10, 30\n2010, 20, 25\n2020, 35, 20",
  area: "연도, 도시, 촌락\n1970, 40, 60\n1990, 70, 30\n2020, 90, 10",
  dotrange: "국가, 2014년, 2023년\nA, 20, 35\nB, 50, 40",
  radar: "그래프, 경제, 정치, 사회, 문화, 환경\n(가), 4, 3, 5, 2, 4\n(나), 2, 5, 3, 4, 3",
  bubble: "이름, x, y, 크기, 칠하기\nA, 10, 60, 30, gray\nB, 40, 30, 80, white",
  venn: "A, B\n1, 가\n12, 나\n2, 다",
};

function FigureForm({ block: b, onChange, upload }: { block: FigureBlock; onChange: (b: Block) => void; upload: UploadFn }) {
  const [mapOpen, setMapOpen] = useState(false);
  const [code, setCode] = useState(false);
  const mode = b.chart ? "chart" : b.map ? "map" : b.src ? "image" : b.svg ? "svg" : "none";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button"
          className="rounded border border-slate-300 bg-white px-1.5 py-0.5"
          onClick={() => onChange({ ...b, svg: undefined, src: undefined, map: undefined, chart: b.chart ?? specFromTable("bar", parseTable(CHART_SAMPLE.bar)) })}
        >
          그래프
        </button>
        <button type="button" className="rounded border border-slate-300 bg-white px-1.5 py-0.5" onClick={() => setMapOpen(true)}>
          {b.map ? "백지도 고치기" : "백지도"}
        </button>
        <ImagePick upload={upload} label="그림 파일 올리기" onPick={(src) => onChange({ ...b, src, svg: undefined, chart: undefined, map: undefined })} />
        <label className="cursor-pointer underline">
          SVG 파일
          <input
            type="file"
            accept=".svg,image/svg+xml"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) onChange({ ...b, svg: await f.text(), src: undefined, chart: undefined, map: undefined });
            }}
          />
        </label>
        {(mode === "svg" || mode === "map") && (
          <button type="button" className="underline" onClick={() => setCode((v) => !v)}>
            SVG 코드
          </button>
        )}
        <span className="flex-1" />
        <label className="flex items-center gap-1">
          폭
          <input type="range" min={20} max={100} value={b.widthPct} onChange={(e) => onChange({ ...b, widthPct: Number(e.target.value) })} />
          {b.widthPct}%
        </label>
        <select className={sel} value={b.align ?? "center"} onChange={(e) => onChange({ ...b, align: e.target.value as "center" })}>
          <option value="center">가운데</option>
          <option value="left">왼쪽</option>
          <option value="right">오른쪽</option>
        </select>
      </div>
      {mode === "none" && <p className="text-xs text-slate-400">그래프·백지도·그림 파일 중에서 고르거나, 위 &lsquo;그림&rsquo; 칸의 AI SVG 를 쓰세요(AI 그림은 이 블록으로 옮길 수 있어요).</p>}
      {b.chart && <ChartForm spec={b.chart} onChange={(chart) => onChange({ ...b, chart })} />}
      {code && b.svg && <textarea className={`${inputCls} font-mono text-xs`} rows={6} value={b.svg} onChange={(e) => onChange({ ...b, svg: e.target.value })} />}
      <input className={`${inputCls} font-serif`} value={b.caption ?? ""} placeholder="그림 아래 글(선택, 예: (가))" onChange={(e) => onChange({ ...b, caption: e.target.value })} />
      {mapOpen && (
        <MapTool
          initial={b.map}
          onClose={() => setMapOpen(false)}
          onApply={(svg, map) => {
            onChange({ ...b, svg, map, src: undefined, chart: undefined });
            setMapOpen(false);
          }}
        />
      )}
    </div>
  );
}

function ChartForm({ spec, onChange }: { spec: ChartSpec; onChange: (s: ChartSpec) => void }) {
  const [table, setTable] = useState(() => tableFromSpec(spec));
  const apply = (type: ChartType, t: string) => onChange(specFromTable(type, parseTable(t), spec));
  const num = (v: string) => (v.trim() === "" ? undefined : Number(v));
  const isXY = ["bar", "stacked", "line", "area"].includes(spec.type);
  return (
    <div className="flex flex-col gap-1.5 rounded border border-slate-200 bg-white p-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className={sel}
          value={spec.type}
          onChange={(e) => {
            const t = e.target.value as ChartType;
            const sample = CHART_SAMPLE[t];
            setTable(sample);
            apply(t, sample);
          }}
        >
          {CHART_TYPES.map((t) => (
            <option key={t.v} value={t.v}>
              {t.l}
            </option>
          ))}
        </select>
        <input className={`${inputCls} w-32`} value={spec.title ?? ""} placeholder="제목" onChange={(e) => onChange({ ...spec, title: e.target.value || undefined })} />
        <input className={`${inputCls} w-24`} value={spec.yLabel ?? ""} placeholder="세로축 단위 (℃)" onChange={(e) => onChange({ ...spec, yLabel: e.target.value || undefined })} />
        {isXY && <input className={`${inputCls} w-24`} value={spec.y2Label ?? ""} placeholder="오른쪽 축 단위" onChange={(e) => onChange({ ...spec, y2Label: e.target.value || undefined })} />}
        <input className={`${inputCls} w-24`} value={spec.xLabel ?? ""} placeholder="가로축 이름" onChange={(e) => onChange({ ...spec, xLabel: e.target.value || undefined })} />
      </div>
      <textarea
        className={`${inputCls} font-mono text-xs`}
        rows={4}
        value={table}
        onChange={(e) => {
          setTable(e.target.value);
          apply(spec.type, e.target.value);
        }}
      />
      <p className="text-[11px] text-slate-400">
        쉼표로 칸을 나눠요. 첫 줄 = 머리(범주 이름, 계열 이름…), 다음 줄마다 범주 하나.
        {spec.type === "venn" && " 벤: 첫 줄 = 원 이름, 다음 줄 = 영역 번호(1·2·3·12·13·23·123), 글자."}
        {spec.type === "radar" && " 방사형: 첫 줄 = 축 이름, 다음 줄 = 그래프 하나."}
      </p>
      {spec.type !== "venn" && (
        <div className="flex flex-col gap-1">
          {spec.series.map((s, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1.5">
              <span className="w-20 truncate">{s.name || `계열 ${i + 1}`}</span>
              <select className={sel} value={s.fill ?? ""} onChange={(e) => onChange({ ...spec, series: spec.series.map((x, k) => (k === i ? { ...x, fill: (e.target.value || undefined) as never } : x)) })}>
                <option value="">칠하기(기본)</option>
                {FILLS.map((f) => (
                  <option key={f} value={f}>
                    {FILL_LABELS[f]}
                  </option>
                ))}
              </select>
              {isXY && (
                <>
                  <select className={sel} value={s.as ?? ""} onChange={(e) => onChange({ ...spec, series: spec.series.map((x, k) => (k === i ? { ...x, as: (e.target.value || undefined) as never } : x)) })}>
                    <option value="">{spec.type === "line" ? "선" : "막대"}</option>
                    <option value="dot">점</option>
                    <option value="line">선</option>
                  </select>
                  <select className={sel} value={s.axis ?? "left"} onChange={(e) => onChange({ ...spec, series: spec.series.map((x, k) => (k === i ? { ...x, axis: e.target.value === "right" ? "right" : undefined } : x)) })}>
                    <option value="left">왼쪽 축</option>
                    <option value="right">오른쪽 축</option>
                  </select>
                </>
              )}
              {(isXY || spec.type === "dotrange") && (
                <select className={sel} value={s.marker ?? ""} onChange={(e) => onChange({ ...spec, series: spec.series.map((x, k) => (k === i ? { ...x, marker: (e.target.value || undefined) as never } : x)) })}>
                  <option value="">표시(기본)</option>
                  {MARKERS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        축 범위:
        <input className={`${inputCls} w-16`} placeholder="최소" defaultValue={spec.yMin ?? ""} onBlur={(e) => onChange({ ...spec, yMin: num(e.target.value) })} />
        <input className={`${inputCls} w-16`} placeholder="최대" defaultValue={spec.yMax ?? ""} onBlur={(e) => onChange({ ...spec, yMax: num(e.target.value) })} />
        <input className={`${inputCls} w-16`} placeholder="간격" defaultValue={spec.yStep ?? ""} onBlur={(e) => onChange({ ...spec, yStep: num(e.target.value) })} />
        {isXY && (
          <input
            className={`${inputCls} w-40`}
            placeholder="아래 묶음 글(쉼표, 예: (가),,(나))"
            defaultValue={spec.groups?.join(",") ?? ""}
            onBlur={(e) => onChange({ ...spec, groups: e.target.value.trim() ? e.target.value.split(",").map((x) => x.trim()) : undefined })}
          />
        )}
        <select className={sel} value={spec.legend ?? "bottom"} onChange={(e) => onChange({ ...spec, legend: e.target.value === "none" ? "none" : undefined })}>
          <option value="bottom">범례 있음</option>
          <option value="none">범례 없음</option>
        </select>
      </div>
      <input className={inputCls} value={spec.note ?? ""} placeholder="그림 아래 출처·주석(선택)" onChange={(e) => onChange({ ...spec, note: e.target.value || undefined })} />
    </div>
  );
}
