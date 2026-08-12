import { escapeXml } from "./xml";

/**
 * hwpx 안의 글자를 **눈에 보이는 대로** 찾아 바꾼다.
 *
 * 왜 단순 문자열 치환이 안 되는가: 한글은 글자 한 자마다 서식이 다르면 조각
 * (`<hp:t>`)을 나눈다. 실제로 수학 문제지의 제목은
 *
 *   `<hp:t>2025학년도 </hp:t> … <hp:t>대</hp:t><hp:t>학수학능력시</hp:t>
 *   <hp:t>험 </hp:t><hp:t>문</hp:t><hp:t>제</hp:t><hp:t>지</hp:t>
 *
 * 처럼 **글자 단위로 쪼개져** 있다. `"2025학년도 대학수학능력시험 문제지"` 로
 * 검색하면 어디에도 없다. 그래서 한 문단 안의 조각을 이어 붙여 논리적인
 * 문자열을 만들고, 거기서 찾은 뒤 원래 조각들에 나눠 써 넣는다.
 *
 * 조각 안에는 `<hp:fwSpace/>` 같은 인라인 표시가 섞이기도 한다. 그것들은
 * 이어 붙일 때 **그냥 글자로 취급**한다 — 그러면 표시를 사이에 낀 문자열은
 * 자연히 안 걸리고(원하는 바다), 태그 한복판을 잘라 XML 을 망가뜨리는 일도
 * 없도록 아래에서 한 번 더 막는다.
 */

type Piece = {
  /** 원본 XML 에서 `<hp:t>` 의 **내용물** 범위 */
  start: number;
  end: number;
  /** 이어 붙인 문자열에서 이 조각이 차지하는 범위 */
  from: number;
  to: number;
};

/** 같은 문단(`<hp:p>`)에 속한 `<hp:t>` 조각들을 묶어 돌려준다. */
function paragraphGroups(xml: string): Piece[][] {
  const groups = new Map<number, Piece[]>();
  const stack: number[] = [];
  const re = /<hp:p(\s[^>]*?)?(\/?)>|<\/hp:p>|<hp:t(?:\s[^>]*?)?>([\s\S]*?)<\/hp:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[0].startsWith("</hp:p")) {
      stack.pop();
      continue;
    }
    if (m[0].startsWith("<hp:p")) {
      if (m[2] !== "/") stack.push(m.index);
      continue;
    }
    const owner = stack.length ? stack[stack.length - 1] : -1;
    const content = m[3] ?? "";
    const contentStart = m.index + m[0].indexOf(">") + 1;
    let list = groups.get(owner);
    if (!list) groups.set(owner, (list = []));
    const from = list.length ? list[list.length - 1].to : 0;
    list.push({ start: contentStart, end: contentStart + content.length, from, to: from + content.length });
  }
  return [...groups.values()];
}

/** 이어 붙인 문자열에서 `<...>` 안쪽에 걸치는 위치인지. */
function insideTag(joined: string, from: number, to: number): boolean {
  for (const m of joined.matchAll(/<[^>]*>/g)) {
    const a = m.index ?? 0;
    const b = a + m[0].length;
    if (from < b && to > a) return true;
  }
  return false;
}

type Edit = { start: number; end: number; text: string };

/**
 * `target` 을 `replacement` 로 바꾼다(모든 문단, 모든 등장 위치).
 *
 * 길이가 같으면 조각마다 **원래 길이만큼** 나눠 넣는다. 그래야 조각별 서식이
 * 그대로 유지된다 — `사회탐구` → `과학탐구` 처럼 두 조각(`사회`/`탐구`)의
 * 글꼴 크기가 다를 수 있는데, 한 조각에 몰아넣으면 뒤쪽 서식이 사라진다.
 * 길이가 다르면 어쩔 수 없이 첫 조각에 몰아넣고 나머지를 비운다.
 */
export function replaceLogicalText(xml: string, target: string, replacement: string): string {
  const needle = escapeXml(target);
  const value = escapeXml(replacement);
  if (!needle || needle === value) return xml;

  const edits: Edit[] = [];
  for (const pieces of paragraphGroups(xml)) {
    if (pieces.length === 0) continue;
    const joined = pieces.map((p) => xml.slice(p.start, p.end)).join("");
    const sameLength = needle.length === value.length;

    let at = joined.indexOf(needle);
    while (at >= 0) {
      const end = at + needle.length;
      if (!insideTag(joined, at, end)) {
        let written = 0;
        let first = true;
        for (const p of pieces) {
          const lo = Math.max(p.from, at);
          const hi = Math.min(p.to, end);
          if (lo >= hi) continue;
          const span = hi - lo;
          const text = sameLength
            ? value.slice(written, written + span)
            : first
              ? value
              : "";
          written += span;
          first = false;
          edits.push({ start: p.start + (lo - p.from), end: p.start + (hi - p.from), text });
        }
      }
      at = joined.indexOf(needle, at + needle.length);
    }
  }

  // 뒤에서부터 고쳐야 앞쪽 위치가 밀리지 않는다.
  edits.sort((a, b) => b.start - a.start);
  let out = xml;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** 문단 하나의 `<hp:t>` 내용을 통째로 갈아끼운다(본보기 문단용). */
export function setParagraphText(paragraph: string, text: string): string {
  let done = false;
  return paragraph.replace(/(<hp:t(?:\s[^>]*?)?>)([\s\S]*?)(<\/hp:t>)/g, (_all, open, _old, close) => {
    if (done) return `${open}${close}`;
    done = true;
    return `${open}${escapeXml(text)}${close}`;
  });
}

/** 문단의 `<hp:t>…</hp:t>` 자리에 그림 같은 다른 요소를 끼워 넣는다. */
export function setParagraphContent(paragraph: string, markup: string): string {
  let done = false;
  return paragraph.replace(/<hp:t(?:\s[^>]*?)?>[\s\S]*?<\/hp:t>/g, () => {
    if (done) return "";
    done = true;
    return markup;
  });
}
