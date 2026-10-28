import type { RichRun } from "./richText";

/**
 * 지문 문단의 서식 토막(`RichRun[]`)을 **글자로 고칠 수 있는 가벼운 표기**와 오간다 — 수정 화면의 지문 글자 편집기가 쓴다.
 *   `**굵게**` · `__밑줄__` · `[[네모]]`(작은 네모) — 겹쳐 쓸 수 있다(`**__굵고 밑줄__**`). 표기 글자 자체는 `\\` 로 피한다.
 * 순수 모듈(화면 전용 값이 없다). 왕복해도 서식·글자가 그대로여야 한다.
 */

const ESC = /[\\*_[\]]/g;
const esc = (t: string) => t.replace(ESC, (c) => `\\${c}`);

export function runsToMarkup(runs: RichRun[]): string {
  let out = "";
  let b = false;
  let u = false;
  let sq = false;
  for (const r of runs) {
    // 꺼질 것 먼저(안쪽부터), 켜질 것은 바깥부터
    if (sq && !r.sq) { out += "]]"; sq = false; }
    if (u && !r.u) { out += "__"; u = false; }
    if (b && !r.b) { out += "**"; b = false; }
    if (r.b && !b) { out += "**"; b = true; }
    if (r.u && !u) { out += "__"; u = true; }
    if (r.sq && !sq) { out += "[["; sq = true; }
    out += esc(r.t);
  }
  if (sq) out += "]]";
  if (u) out += "__";
  if (b) out += "**";
  return out;
}

export function markupToRuns(src: string): RichRun[] {
  const runs: RichRun[] = [];
  let b = false;
  let u = false;
  let sq = false;
  let buf = "";
  const flush = () => {
    if (!buf) return;
    const last = runs[runs.length - 1];
    if (last && !!last.b === b && !!last.u === u && !!last.sq === sq) last.t += buf;
    else runs.push({ t: buf, ...(b ? { b: true } : {}), ...(u ? { u: true } : {}), ...(sq ? { sq: true } : {}) });
    buf = "";
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length) {
      buf += src[++i];
    } else if (c === "*" && src[i + 1] === "*") {
      flush(); b = !b; i++;
    } else if (c === "_" && src[i + 1] === "_") {
      flush(); u = !u; i++;
    } else if (c === "[" && src[i + 1] === "[") {
      flush(); sq = true; i++;
    } else if (c === "]" && src[i + 1] === "]") {
      flush(); sq = false; i++;
    } else buf += c;
  }
  flush();
  return runs;
}
