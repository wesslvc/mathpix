import katex from "katex";
import { plainMath } from "@/lib/kice/solutionLayout";
import { BOGI_LABELS, CIRCLED, pointsLabel, type QDoc } from "./doc";
import { blocksHtml, textHtml } from "./blocks";

/**
 * 문항을 **평가원 문제지 모양의 HTML** 로 만든다. 화면 미리보기와 PDF 용 캡처가 같은 함수를 쓴다(둘이 어긋나면 안 된다).
 * 글 칸 표기: 빈 줄 = 문단, `$…$` 수식, `**굵게**`, `__밑줄__`.
 */
/** 평가원 문제지처럼 글자를 촘촘히(원본은 장평 95%·자간 음수 — 한글 한 글자가 0.88em 간격). */
export const LETTER = "-0.1em";
const SERIF = "'KICE Serif', 'Nanum Myeongjo', 'Noto Serif KR', serif";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 한 문단 안 글(수식·굵게·밑줄)을 HTML 로. */
export function inlineHtml(src: string): string {
  const parts = src.split(/(\$[^$]+\$)/g);
  return parts
    .map((p) => {
      if (/^\$[^$]+\$$/.test(p)) {
        try {
          return `<span style="letter-spacing:normal">${katex.renderToString(p.slice(1, -1), { throwOnError: false, output: "html" })}</span>`;
        } catch {
          return esc(p);
        }
      }
      return esc(p)
        .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
        .replace(/__(.+?)__/g, '<u style="text-underline-offset:3px">$1</u>')
        .replace(/\[\[(.*?)\]\]/g, '<span style="display:inline-block;border:1px solid #111;min-width:2.2em;padding:0 4px;line-height:1.35;text-align:center">$1</span>')
        .replace(/\n/g, "<br/>");
    })
    .join("");
}

const paras = (src: string) => src.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);

/** 선지 배치: 모두 짧으면 한 줄 다섯 칸, 중간이면 3+2, 길면 한 줄에 하나. */
function choicesHtml(choices: string[], layout: QDoc["choiceLayout"]): string {
  const len = Math.max(...choices.map((c) => c.replace(/\$[^$]+\$/g, "xx").length));
  const cols = typeof layout === "number" ? layout : len <= 8 ? 5 : len <= 18 ? 3 : 1;
  const cells = choices
    .map((c, i) => `<div style="display:flex;gap:6px;align-items:baseline"><span>${CIRCLED[i]}</span><span>${inlineHtml(c)}</span></div>`)
    .join("");
  return `<div style="display:grid;grid-template-columns:repeat(${cols},minmax(0,1fr));column-gap:12px;row-gap:1px;margin-top:10px">${cells}</div>`;
}

/** 표 꼴 선지: 첫 줄은 머리(빈 칸 + 열 이름), 다음 줄마다 ①~⑤. */
function choiceTableHtml(t: NonNullable<QDoc["choiceTable"]>): string {
  const head = `<tr><td style="padding:2px 8px"></td>${t.header.map((h) => `<td style="padding:2px 10px;text-align:center">${inlineHtml(h)}</td>`).join("")}</tr>`;
  const rows = t.rows
    .map((r, i) => `<tr><td style="padding:2px 8px">${CIRCLED[i]}</td>${r.map((c) => `<td style="padding:2px 10px;text-align:center">${inlineHtml(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<table style="border-collapse:collapse;margin:12px auto 0">${head}${rows}</table>`;
}

const showPoints = (doc: QDoc) => !Number.isInteger(doc.points) || doc.points >= 3 || doc.showPoints === true;

export function docHtml(doc: QDoc): string {
  const stem = paras(doc.stem);
  const first = stem.shift() ?? "";
  const out: string[] = [];
  // 묻는 문장이 따로 없으면 배점은 발문 끝에 붙는다(평가원 문제지처럼).
  const pts = showPoints(doc) ? ` [${pointsLabel(doc.points)}]` : "";
  const ptsOnStem = !doc.question.trim() && pts;
  const stemTail = (i: number, n: number) => (ptsOnStem && i === n - 1 ? pts : "");
  // 문항 번호는 평가원처럼 굵은 고딕.
  out.push(
    `<p style="margin:0 0 6px;text-align:justify"><b style="font-family:'KICE Gothic','Nanum Gothic',sans-serif;font-size:1.12em;margin-right:5px;letter-spacing:0">${doc.number}.</b>${inlineHtml(first)}${stemTail(0, stem.length + 1)}</p>`,
  );
  if (stem.length) out.push(textHtml(stem.map((p, i) => p + stemTail(i + 1, stem.length + 1)).join("\n\n"), inlineHtml));
  if (doc.figure) {
    out.push(
      `<div style="margin:10px auto 8px;width:${doc.figure.widthPct}%">${doc.figure.svg.replace(/<svg/i, '<svg style="width:100%;height:auto;display:block"')}</div>`,
    );
    if (doc.figure.caption) out.push(`<p style="margin:0 0 8px;text-align:center">${inlineHtml(doc.figure.caption)}</p>`);
  }
  if (doc.blocks?.length) out.push(blocksHtml(doc.blocks, inlineHtml));
  if (doc.question.trim()) {
    out.push(`<p style="margin:4px 0 6px;text-align:justify">${inlineHtml(doc.question.trim())}${pts}</p>`);
  }
  const bogi = doc.bogi.filter((b) => b.trim());
  if (bogi.length) {
    out.push(
      `<div style="position:relative;border:1px solid #111;padding:16px 12px 8px;margin:14px 0 4px">` +
        `<div style="position:absolute;top:-0.75em;left:0;right:0;text-align:center"><span style="background:#fff;padding:0 8px">&lt;보 기&gt;</span></div>` +
        bogi
          .map(
            (b, i) =>
              `<div style="display:flex;gap:6px;margin:0 0 6px;text-align:justify"><span style="flex:none">${BOGI_LABELS[i]}.</span><span>${inlineHtml(b)}</span></div>`,
          )
          .join("") +
        `</div>`,
    );
  }
  if (doc.choiceTable?.header.length) out.push(choiceTableHtml(doc.choiceTable));
  else if (doc.choices.some((c) => c.trim())) out.push(choicesHtml(doc.choices, doc.choiceLayout));
  return `<div style="font-family:${SERIF};font-size:15px;line-height:1.62;letter-spacing:${LETTER};color:#111;background:#fff;padding:8px 6px">${out.join("")}</div>`;
}

/** HWPX·검색용: 표기를 떼고 수식은 읽을 수 있는 글자로. */
export function plainText(src: string): string {
  return src
    .replace(/\$([^$]+)\$/g, (_, t: string) => plainMath(t))
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\[\[(.*?)\]\]/g, "[$1]");
}

export { showPoints };
