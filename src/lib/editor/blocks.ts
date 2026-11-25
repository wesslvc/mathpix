/**
 * **자료 블록** — 평가원 탐구 문제지(2028 예시문항 통합사회)에 나오는 자료를 전부 이 꼴들의 조합으로 만든다. 순수 모듈.
 *
 *   text     글 문단(명조/고딕, 정렬, ○·• 글머리는 내어쓰기)
 *   box      테두리 상자(제목을 테두리 위·상자 머리·없음, 실선/둥근/점선/겹선/창 모양), 안에 블록
 *   dialog   대화(갑: …, 을: … — 이름 뒤로 내어쓰기)
 *   table    표(머리 줄, 칸 합치기: "<" 왼쪽과 · "^" 위와)
 *   figure   그림(SVG·올린 그림·그래프·백지도)
 *   bubble   말풍선(사람 그림 + 말, 왼쪽/오른쪽)
 *   row      나란히(칸마다 블록)
 *   labeled  (가)·(나) 표지 + 블록
 *
 * 글 표기: 빈 줄 = 문단, `$…$` 수식, `**굵게**`, `__밑줄__`, `[[글]]` 네모 칸(빈칸 ㉠ 등).
 */
import { readChartSpec, buildChartSvg, type ChartSpec } from "./chart";
import { readMapSpec, type MapSpec } from "./mapFigure";

export type Font = "serif" | "gothic";
export type Align = "left" | "center" | "justify" | "right";
export type Frame = "plain" | "round" | "dash" | "double" | "window" | "none";

export type TextBlock = { kind: "text"; text: string; font?: Font; align?: Align; bold?: boolean; size?: "s" | "m" | "l" };
export type BoxBlock = { kind: "box"; title?: string; titlePos?: "border" | "top" | "none"; frame?: Frame; font?: Font; blocks: Block[] };
export type DialogBlock = { kind: "dialog"; lines: { who: string; text: string }[]; font?: Font };
export type TableBlock = { kind: "table"; rows: string[][]; header?: number; widthPct?: number; font?: Font; align?: Align; colWidths?: number[] };
export type FigureBlock = { kind: "figure"; svg?: string; src?: string; widthPct: number; align?: Align; caption?: string; map?: MapSpec; chart?: ChartSpec };
export type BubbleBlock = { kind: "bubble"; who?: string; text: string; side?: "left" | "right"; src?: string; font?: Font };
export type RowBlock = { kind: "row"; cols: Block[][]; gap?: number };
export type LabeledBlock = { kind: "labeled"; label: string; blocks: Block[]; pos?: "left" | "top" };
export type Block = TextBlock | BoxBlock | DialogBlock | TableBlock | FigureBlock | BubbleBlock | RowBlock | LabeledBlock;
export type BlockKind = Block["kind"];

export const BLOCK_LABELS: Record<BlockKind, string> = {
  text: "글",
  box: "상자",
  dialog: "대화",
  table: "표",
  figure: "그림·그래프",
  bubble: "말풍선",
  row: "나란히",
  labeled: "(가)(나) 표지",
};

export function newBlock(kind: BlockKind): Block {
  switch (kind) {
    case "text":
      return { kind, text: "" };
    case "box":
      return { kind, title: "", titlePos: "none", frame: "plain", blocks: [{ kind: "text", text: "" }] };
    case "dialog":
      return { kind, lines: [{ who: "갑", text: "" }, { who: "을", text: "" }] };
    case "table":
      return { kind, rows: [["구분", "A", "B"], ["", "", ""]], header: 1, widthPct: 100 };
    case "figure":
      return { kind, widthPct: 80, align: "center" };
    case "bubble":
      return { kind, who: "", text: "", side: "left" };
    case "row":
      return { kind, cols: [[{ kind: "text", text: "" }], [{ kind: "text", text: "" }]] };
    case "labeled":
      return { kind, label: "(가)", blocks: [{ kind: "text", text: "" }], pos: "left" };
  }
}

/* ---------------- 받기(모양 확인) ---------------- */

const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
const pick = <T extends string>(v: unknown, list: readonly T[]): T | undefined => (list.includes(v as T) ? (v as T) : undefined);
const pct = (v: unknown, d: number) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.min(100, Math.max(10, Math.round(x))) : d;
};
const FONTS = ["serif", "gothic"] as const;
const ALIGNS = ["left", "center", "justify", "right"] as const;
const FRAMES = ["plain", "round", "dash", "double", "window", "none"] as const;

/** 우리 저장소(`/api/card/…`)나 data URL 그림만 받는다. */
export function cleanSrc(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  if (/^\/api\/card\/[\w./-]+$/.test(v)) return v;
  if (/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v) && v.length < 4_000_000) return v;
  return undefined;
}

export function readBlocks(raw: unknown, clean: (svg: string) => string | null, depth = 0): Block[] {
  if (!Array.isArray(raw) || depth > 4) return [];
  const out: Block[] = [];
  for (const x of raw.slice(0, 60)) {
    const b = readBlock(x, clean, depth);
    if (b) out.push(b);
  }
  return out;
}

function readBlock(raw: unknown, clean: (svg: string) => string | null, depth: number): Block | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const font = pick(o.font, FONTS);
  switch (o.kind) {
    case "text":
      return { kind: "text", text: str(o.text, 8000), font, align: pick(o.align, ALIGNS), bold: o.bold === true || undefined, size: pick(o.size, ["s", "m", "l"] as const) };
    case "box":
      return {
        kind: "box",
        title: str(o.title, 80) || undefined,
        titlePos: pick(o.titlePos, ["border", "top", "none"] as const),
        frame: pick(o.frame, FRAMES),
        font,
        blocks: readBlocks(o.blocks, clean, depth + 1),
      };
    case "dialog":
      return {
        kind: "dialog",
        font,
        lines: Array.isArray(o.lines)
          ? o.lines.slice(0, 20).map((l) => {
              const q = (l ?? {}) as Record<string, unknown>;
              return { who: str(q.who, 20), text: str(q.text, 2000) };
            })
          : [],
      };
    case "table": {
      const rows = Array.isArray(o.rows) ? o.rows.slice(0, 40).map((r) => (Array.isArray(r) ? r.slice(0, 16).map((c) => str(c, 600)) : [])) : [];
      return {
        kind: "table",
        rows,
        header: Math.min(5, Math.max(0, Number(o.header) || 0)),
        widthPct: pct(o.widthPct, 100),
        font,
        align: pick(o.align, ALIGNS),
        colWidths: Array.isArray(o.colWidths) ? o.colWidths.slice(0, 16).map((w) => Math.max(1, Number(w) || 1)) : undefined,
      };
    }
    case "figure": {
      const chart = readChartSpec(o.chart) ?? undefined;
      const map = readMapSpec(o.map) ?? undefined;
      const svg = typeof o.svg === "string" ? clean(o.svg) ?? undefined : undefined;
      const src = cleanSrc(o.src);
      if (!svg && !src && !chart) return { kind: "figure", widthPct: pct(o.widthPct, 80), align: pick(o.align, ALIGNS), caption: str(o.caption, 120) || undefined };
      return { kind: "figure", svg, src, chart, map, widthPct: pct(o.widthPct, 80), align: pick(o.align, ALIGNS), caption: str(o.caption, 120) || undefined };
    }
    case "bubble":
      return { kind: "bubble", who: str(o.who, 20) || undefined, text: str(o.text, 2000), side: o.side === "right" ? "right" : "left", src: cleanSrc(o.src), font };
    case "row":
      return {
        kind: "row",
        gap: Number(o.gap) || undefined,
        cols: Array.isArray(o.cols) ? o.cols.slice(0, 4).map((c) => readBlocks(c, clean, depth + 1)) : [],
      };
    case "labeled":
      return { kind: "labeled", label: str(o.label, 12), blocks: readBlocks(o.blocks, clean, depth + 1), pos: o.pos === "top" ? "top" : "left" };
  }
  return null;
}

/* ---------------- 그리기(HTML) ---------------- */

export const SERIF = "'Nanum Myeongjo', 'Noto Serif KR', serif";
export const GOTHIC = "'Nanum Gothic', 'Noto Sans KR', sans-serif";
const fontCss = (f?: Font) => (f === "gothic" ? `font-family:${GOTHIC};` : "");

/** 글 칸 → HTML. `inline` 은 한 문단 안 글(수식·굵게·밑줄·네모)을 그리는 함수. */
export function textHtml(src: string, inline: (s: string) => string, o: { align?: Align; indentFirst?: boolean } = {}): string {
  const paras = src.split(/\n\s*\n/).map((s) => s.trimEnd()).filter((s) => s.trim());
  const align = o.align ?? "justify";
  return paras
    .map((p) => {
      const lines = p.split("\n");
      // 글머리(○ • ◦ ▪ · - 1. ⑴ ㄱ.)로 시작하는 줄이 있으면 줄마다 내어쓰기
      if (lines.some((l) => BULLET.test(l.trim()))) {
        return lines
          .map((l) => {
            const m = BULLET.exec(l.trim());
            if (!m) return `<div style="margin:0 0 3px;text-align:${align}">${inline(l.trim())}</div>`;
            const mark = m[0].trimEnd();
            const rest = l.trim().slice(m[0].length);
            return `<div style="display:flex;gap:4px;margin:0 0 3px;text-align:${align}"><span style="flex:none">${inline(mark)}</span><span style="flex:1;min-width:0">${inline(rest)}</span></div>`;
          })
          .join("");
      }
      return `<p style="margin:0 0 6px;text-align:${align}">${inline(p.trim())}</p>`;
    })
    .join("");
}
const BULLET = /^(○|●|•|◦|▪|□|■|◎|※|-|·|\d{1,2}[.)]|[⑴⑵⑶⑷⑸⑹]|[ㄱㄴㄷㄹㅁ]\.|\([가-하]\)|[A-E]\.)\s+/;

const frameCss = (f: Frame | undefined) => {
  switch (f ?? "plain") {
    case "round":
      return "border:1px solid #111;border-radius:10px;";
    case "dash":
      return "border:1px dashed #111;";
    case "double":
      return "border:3px double #111;";
    case "none":
      return "border:none;";
    case "window":
      return "border:1px solid #111;";
    default:
      return "border:1px solid #111;";
  }
};

function tableHtml(t: TableBlock, inline: (s: string) => string): string {
  const rows = t.rows;
  const nCols = Math.max(1, ...rows.map((r) => r.length));
  const grid = rows.map((r) => Array.from({ length: nCols }, (_, i) => r[i] ?? ""));
  const skip = grid.map((r) => r.map(() => false));
  const cells: string[] = [];
  for (let ri = 0; ri < grid.length; ri++) {
    const tds: string[] = [];
    for (let ci = 0; ci < nCols; ci++) {
      if (skip[ri][ci]) continue;
      const v = grid[ri][ci];
      if (v === "<" || v === "^") continue;
      let cs = 1;
      while (ci + cs < nCols && grid[ri][ci + cs] === "<") cs++;
      let rs = 1;
      while (ri + rs < grid.length && grid[ri + rs][ci] === "^") rs++;
      for (let a = 0; a < rs; a++) for (let b = 0; b < cs; b++) skip[ri + a][ci + b] = true;
      const head = ri < (t.header ?? 0);
      const img = /^\[img:(.+)\]$/.exec(v.trim());
      const body = img && cleanSrc(img[1]) ? `<img src="${img[1]}" style="max-width:100%;display:block;margin:0 auto"/>` : inline(v).replace(/\n/g, "<br/>");
      tds.push(
        `<td${cs > 1 ? ` colspan="${cs}"` : ""}${rs > 1 ? ` rowspan="${rs}"` : ""} style="border:1px solid #111;padding:3px 6px;text-align:${head ? "center" : t.align ?? "center"};vertical-align:middle${head ? ";background:#f0f0f0" : ""}">${body}</td>`,
      );
    }
    cells.push(`<tr>${tds.join("")}</tr>`);
  }
  const cols = t.colWidths?.length ? `<colgroup>${t.colWidths.map((w) => `<col style="width:${(100 * w) / t.colWidths!.reduce((a, x) => a + x, 0)}%"/>`).join("")}</colgroup>` : "";
  return `<table style="border-collapse:collapse;width:${t.widthPct ?? 100}%;margin:6px auto;font-size:0.92em;line-height:1.5;${fontCss(t.font)}">${cols}${cells.join("")}</table>`;
}

/** 사람 그림이 없을 때 쓰는 단순한 사람 모양(평가원 삽화 대신). */
const PERSON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 48" style="width:100%;height:auto;display:block"><circle cx="20" cy="13" r="9" fill="#fff" stroke="#111" stroke-width="1.4"/><path d="M4 46c1-12 7-18 16-18s15 6 16 18" fill="#fff" stroke="#111" stroke-width="1.4"/></svg>`;

export function figureInner(f: FigureBlock): string {
  if (f.src) return `<img src="${f.src}" style="width:100%;height:auto;display:block"/>`;
  const svg = f.chart ? buildChartSvg(f.chart) : f.svg;
  if (!svg) return `<div style="border:1px dashed #999;color:#999;text-align:center;padding:18px 0;font-size:12px">(그림 없음)</div>`;
  return svg.replace(/<svg/i, '<svg style="width:100%;height:auto;display:block"');
}

export function blocksHtml(blocks: Block[], inline: (s: string) => string): string {
  return blocks.map((b) => blockHtml(b, inline)).join("");
}

export function blockHtml(b: Block, inline: (s: string) => string): string {
  switch (b.kind) {
    case "text": {
      const size = b.size === "s" ? "font-size:0.88em;" : b.size === "l" ? "font-size:1.12em;" : "";
      const inner = textHtml(b.text, inline, { align: b.align });
      return `<div style="${fontCss(b.font)}${size}${b.bold ? "font-weight:700;" : ""}">${inner}</div>`;
    }
    case "box": {
      const title = b.title?.trim() ? inline(b.title.trim()) : "";
      const pos = title ? b.titlePos ?? "border" : "none";
      const top = pos === "border" ? "16px" : "8px";
      const head =
        pos === "border"
          ? `<div style="position:absolute;top:-0.8em;left:0;right:0;text-align:center"><span style="background:#fff;padding:0 8px">${title}</span></div>`
          : pos === "top"
            ? `<div style="text-align:center;font-weight:700;margin:0 0 6px;${b.frame === "window" ? "border-bottom:1px solid #111;padding-bottom:4px;margin:-8px -10px 8px;background:#f0f0f0;padding-top:4px" : ""}">${title}</div>`
            : "";
      return `<div style="position:relative;${frameCss(b.frame)}padding:${top} 10px 6px;margin:${pos === "border" ? "14px" : "8px"} 0 8px;${fontCss(b.font)}">${head}${blocksHtml(b.blocks, inline)}</div>`;
    }
    case "dialog":
      return `<div style="margin:4px 0 6px;${fontCss(b.font)}">${b.lines
        .map(
          (l) =>
            `<div style="display:flex;gap:4px;margin:0 0 4px;text-align:justify"><span style="flex:none;font-weight:700">${inline(l.who)}${l.who ? ":" : ""}</span><span style="flex:1;min-width:0">${inline(l.text)}</span></div>`,
        )
        .join("")}</div>`;
    case "table":
      return tableHtml(b, inline);
    case "figure": {
      const m = b.align === "left" ? "6px 0" : b.align === "right" ? "6px 0 6px auto" : "6px auto";
      return `<div style="margin:${m};width:${b.widthPct}%">${figureInner(b)}${b.caption ? `<div style="text-align:center;margin-top:3px;font-size:0.92em">${inline(b.caption)}</div>` : ""}</div>`;
    }
    case "bubble": {
      const face = `<div style="flex:none;width:44px;text-align:center">${b.src ? `<img src="${b.src}" style="width:100%;height:auto;display:block"/>` : PERSON_SVG}${b.who ? `<div style="font-size:0.85em;margin-top:2px">${inline(b.who)}</div>` : ""}</div>`;
      const tail = b.side === "right" ? "right:-7px" : "left:-7px";
      const bubble = `<div style="position:relative;flex:1;min-width:0;border:1px solid #111;border-radius:12px;padding:6px 10px;text-align:justify;${fontCss(b.font)}"><span style="position:absolute;top:14px;${tail};width:12px;height:12px;background:#fff;border-left:1px solid #111;border-bottom:1px solid #111;transform:rotate(${b.side === "right" ? "-135deg" : "45deg"})"></span>${inline(b.text).replace(/\n/g, "<br/>")}</div>`;
      return `<div style="display:flex;gap:10px;align-items:flex-start;margin:6px 0">${b.side === "right" ? bubble + face : face + bubble}</div>`;
    }
    case "row":
      return `<div style="display:flex;gap:${b.gap ?? 10}px;align-items:flex-start;margin:6px 0">${b.cols.map((c) => `<div style="flex:1;min-width:0">${blocksHtml(c, inline)}</div>`).join("")}</div>`;
    case "labeled":
      return b.pos === "top"
        ? `<div style="margin:6px 0"><div style="text-align:center;margin-bottom:3px">${inline(b.label)}</div>${blocksHtml(b.blocks, inline)}</div>`
        : `<div style="display:flex;gap:6px;align-items:flex-start;margin:6px 0"><span style="flex:none">${inline(b.label)}</span><div style="flex:1;min-width:0">${blocksHtml(b.blocks, inline)}</div></div>`;
  }
}

/** AI·검색용 짧은 글. */
export function blocksPlain(blocks: Block[]): string {
  const out: string[] = [];
  const walk = (bs: Block[]) => {
    for (const b of bs) {
      if (b.kind === "text") out.push(b.text);
      else if (b.kind === "box") {
        if (b.title) out.push(`[${b.title}]`);
        walk(b.blocks);
      } else if (b.kind === "dialog") b.lines.forEach((l) => out.push(`${l.who}: ${l.text}`));
      else if (b.kind === "table") b.rows.forEach((r) => out.push(r.join(" | ")));
      else if (b.kind === "figure") out.push(`(그림${b.caption ? `: ${b.caption}` : ""}${b.chart ? ` — 그래프 ${b.chart.type}: ${JSON.stringify({ c: b.chart.categories, s: b.chart.series })}` : ""})`);
      else if (b.kind === "bubble") out.push(`${b.who ?? "말풍선"}: ${b.text}`);
      else if (b.kind === "row") b.cols.forEach(walk);
      else if (b.kind === "labeled") {
        out.push(b.label);
        walk(b.blocks);
      }
    }
  };
  walk(blocks);
  return out.join("\n");
}

/* ---------------- AI 왕복: 그림 바이트를 자리표로 ---------------- */

type Media = { svg?: string; src?: string; map?: MapSpec };

/** 그림 블록의 svg·src·map 을 "keep:N" 자리표로 바꾼다(AI 에 큰 그림을 안 보내고, 돌아오면 되살린다). 차례는 restoreMedia 와 같다. */
export function stripMedia(blocks: Block[]): { blocks: Block[]; media: Media[] } {
  const media: Media[] = [];
  const walk = (bs: Block[]): Block[] =>
    bs.map((b) => {
      if (b.kind === "figure" && (b.svg || b.src) && !b.chart) {
        media.push({ svg: b.svg, src: b.src, map: b.map });
        const { svg: _s, src: _r, map: _m, ...rest } = b;
        void _s;
        void _r;
        void _m;
        return { ...rest, svg: `keep:${media.length - 1}` } as Block;
      }
      if (b.kind === "box" || b.kind === "labeled") return { ...b, blocks: walk(b.blocks) };
      if (b.kind === "row") return { ...b, cols: b.cols.map(walk) };
      return b;
    });
  return { blocks: walk(blocks), media };
}

/** AI 가 돌려준 블록(날것)에서 "keep:N" 자리표를 원래 그림으로 되돌린다. */
export function restoreMedia(raw: unknown, media: Media[]): unknown {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    const o = { ...(v as Record<string, unknown>) };
    for (const k of ["svg", "src"]) {
      const m = typeof o[k] === "string" ? /^keep:(\d+)$/.exec(o[k] as string) : null;
      if (m) {
        delete o[k];
        Object.assign(o, media[Number(m[1])] ?? {});
      }
    }
    for (const k of ["blocks", "cols"]) if (o[k]) o[k] = walk(o[k]);
    return o;
  };
  return walk(raw);
}
