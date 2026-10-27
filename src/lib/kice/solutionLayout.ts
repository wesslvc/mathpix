/**
 * 해설 한 편을 **줄 단위로 조판**한다(순수 계산 — 글자 폭 재기는 밖에서 받는다). 수식(`$…$`)은 `solutionMath` 의 윤곽 상자로,
 * 못 바꾸는 수식(한글이 든 것·오류)은 읽을 수 있는 글자로 대신 적는다. DOM 이 없어 웹 워커에서 돈다.
 */
import { texToMath, type MathBox } from "./solutionMath";

export type SolItem =
  | { t: "text"; x: number; base: number; text: string; bold?: boolean }
  | { t: "math"; x: number; base: number; box: MathBox };
export type SolLine = { h: number; items: SolItem[] };

/** 수식을 못 윤곽으로 만들 때 글로 대신 적는다. */
export function plainMath(t: string): string {
  const rep: [RegExp, string][] = [
    [/\\left|\\right/g, ""],
    [/\\times/g, "×"], [/\\div/g, "÷"], [/\\cdot/g, "·"], [/\\pm/g, "±"],
    [/\\le(?:q)?(?![a-zA-Z])/g, "≤"], [/\\ge(?:q)?(?![a-zA-Z])/g, "≥"], [/\\neq?(?![a-zA-Z])/g, "≠"],
    [/\\to(?![a-zA-Z])|\\rightarrow/g, "→"], [/\\pi(?![a-zA-Z])/g, "π"], [/\\angle/g, "∠"],
    [/\\%/g, "%"], [/\\(?:text|mathrm)\{([^}]*)\}/g, "$1"],
  ];
  let out = t;
  for (let i = 0; i < 3; i++) {
    out = out.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1)/($2)").replace(/\\sqrt\{([^{}]*)\}/g, "√($1)");
  }
  for (const [re, to] of rep) out = out.replace(re, to);
  return out.replace(/[{}]/g, "").replace(/\^2/g, "²").replace(/\\,|\;|\\!/g, " ");
}

type Unit =
  | { k: "t"; text: string; w: number; brk: boolean; space: boolean }
  | { k: "m"; box: MathBox; w: number; brk: boolean };

const NO_LINE_START = new Set([".", ",", ")", "!", "?", ":", ";", "]", "}", "%", "·", "…", "”", "’", "」", "』", "。", "、"]);
const isCjk = (c: string) => /[ᄀ-ᇿ㄰-㆏가-힣぀-ヿ一-鿿＀-￯]/.test(c);

function textUnits(s: string, size: number, measure: (t: string, size: number, bold: boolean) => number, prevSpace: boolean): Unit[] {
  const units: Unit[] = [];
  let word = "";
  let wordBrk = prevSpace;
  const flush = () => {
    if (!word) return;
    units.push({ k: "t", text: word, w: measure(word, size, false), brk: wordBrk, space: false });
    word = "";
  };
  let afterSpace = prevSpace;
  for (const ch of s) {
    if (ch === " " || ch === " ") {
      flush();
      units.push({ k: "t", text: " ", w: measure(" ", size, false), brk: true, space: true });
      afterSpace = true;
      wordBrk = true;
    } else if (isCjk(ch)) {
      flush();
      units.push({ k: "t", text: ch, w: measure(ch, size, false), brk: !NO_LINE_START.has(ch), space: false });
      afterSpace = false;
      wordBrk = true;
    } else {
      if (!word) wordBrk = afterSpace || units.length === 0 || (units[units.length - 1] as Unit).k === "t" && isCjk([...(units[units.length - 1] as { text: string }).text].pop() ?? "") ? !NO_LINE_START.has(ch) : false;
      word += ch;
      afterSpace = false;
    }
  }
  flush();
  return units;
}

/**
 * 해설 본문을 폭 `width` 안에 줄바꿈해 줄 목록으로 돌려준다. 줄 높이·기준선은 줄 안의 수식 크기에 맞춘다.
 */
export function layoutSolutionText(
  text: string,
  width: number,
  size: number,
  measure: (t: string, size: number, bold: boolean) => number,
): SolLine[] {
  const lines: SolLine[] = [];
  const paras = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const para of paras) {
    // 문단 안을 글 / 인라인 수식 / 별행 수식으로 쪼갠다.
    type Seg = { kind: "t"; s: string } | { kind: "m"; tex: string; display: boolean };
    const segs: Seg[] = [];
    let last = 0;
    for (const m of para.matchAll(/\$\$([\s\S]+?)\$\$|\$([^$]+?)\$|\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/g)) {
      if (m.index! > last) segs.push({ kind: "t", s: para.slice(last, m.index) });
      const display = m[1] !== undefined || m[4] !== undefined;
      segs.push({ kind: "m", tex: (m[1] ?? m[2] ?? m[3] ?? m[4]).trim(), display });
      last = m.index! + m[0].length;
    }
    if (last < para.length) segs.push({ kind: "t", s: para.slice(last) });

    const units: Unit[] = [];
    let displayOnly: MathBox | null = null;
    for (const sg of segs) {
      const prevSpace = units.length === 0 || (units[units.length - 1].k === "t" && (units[units.length - 1] as { space: boolean }).space);
      if (sg.kind === "t") {
        units.push(...textUnits(sg.s, size, measure, prevSpace));
      } else {
        const box = texToMath(sg.tex, false);
        if (box) {
          if (sg.display && segs.length === 1) displayOnly = box;
          units.push({ k: "m", box, w: box.w * size, brk: true });
        } else {
          units.push(...textUnits(plainMath(sg.tex), size, measure, prevSpace));
        }
      }
    }

    const emit = (row: Unit[], center: boolean) => {
      while (row.length && row[row.length - 1].k === "t" && (row[row.length - 1] as { space: boolean }).space) row.pop();
      while (row.length && row[0].k === "t" && (row[0] as { space: boolean }).space) row.shift();
      if (!row.length) return;
      let asc = size * 0.8;
      let desc = size * 0.25;
      let total = 0;
      for (const u of row) {
        total += u.w;
        if (u.k === "m") {
          asc = Math.max(asc, u.box.asc * size);
          desc = Math.max(desc, u.box.desc * size);
        }
      }
      const above = Math.max(size * 1.15, asc + 1.5);
      const below = Math.max(size * 0.45, desc + 1.5);
      let x = center ? Math.max(0, (width - total) / 2) : 0;
      const items: SolItem[] = [];
      for (const u of row) {
        if (u.k === "m") items.push({ t: "math", x, base: above, box: u.box });
        else if (!u.space) items.push({ t: "text", x, base: above, text: u.text });
        x += u.w;
      }
      lines.push({ h: above + below, items });
    };

    if (displayOnly) {
      emit(units.slice(), true);
    } else {
      let row: Unit[] = [];
      let w = 0;
      for (const u of units) {
        if (row.length && w + u.w > width + 0.01 && u.brk && !(u.k === "t" && u.space)) {
          emit(row, false);
          row = [];
          w = 0;
        }
        if (!row.length && u.k === "t" && u.space) continue;
        row.push(u);
        w += u.w;
      }
      emit(row, false);
    }
    if (lines.length) lines[lines.length - 1].h += size * 0.35;
  }
  return lines;
}
