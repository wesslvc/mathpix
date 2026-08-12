// hwpx(OWPML) XML 을 다루는 최소한의 도구.
//
// **정규식으로 요소를 통째로 잡으면 안 된다.** hwpx 는 같은 이름의 요소가 깊게
// 겹친다 — 표(hp:tbl) 안에 문단(hp:p)이 있고 그 안에 또 표가 있다. `<hp:p ...>`
// ~ `</hp:p>` 를 게으른 정규식으로 잡으면 안쪽 문단의 닫는 태그에서 끊긴다.
// 그래서 여는/닫는 태그를 세면서 짝을 맞춘다.
//
// 자기닫힘 태그(`<hp:run charPrIDRef="0"/>`)를 깊이에 더하면 영영 안 닫힌다.
// 실제로 처음에 그렇게 짰다가 첫 문단이 문서 절반을 삼켰다.

export type ElementRange = { name: string; start: number; end: number };

const TAG_NAME = "[a-zA-Z][a-zA-Z0-9]*(?::[a-zA-Z][a-zA-Z0-9]*)?";

/** 문자열 안에서 `tag` 인 **최상위** 요소들의 [시작, 끝) 위치를 돌려준다. */
export function topLevelElements(xml: string, tag: string): Array<[number, number]> {
  const re = new RegExp(`<${tag}(\\s[^>]*?)?(/?)>|</${tag}>`, "g");
  const out: Array<[number, number]> = [];
  let depth = 0;
  let start = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[0].startsWith("</")) {
      depth--;
      if (depth === 0) out.push([start, re.lastIndex]);
    } else if (m[2] === "/") {
      if (depth === 0) out.push([m.index, re.lastIndex]);
    } else {
      if (depth === 0) start = m.index;
      depth++;
    }
  }
  return out;
}

/** 요소의 내용물(inner XML)에서 **직계 자식** 요소들을 순서대로 돌려준다. */
export function childElements(inner: string): ElementRange[] {
  const out: ElementRange[] = [];
  const re = new RegExp(`<(${TAG_NAME})(\\s[^>]*?)?(/?)>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) {
    const name = m[1];
    const start = m.index;
    if (m[3] === "/") {
      out.push({ name, start, end: re.lastIndex });
      continue;
    }
    const close = new RegExp(`<${name}(\\s[^>]*?)?(/?)>|</${name}>`, "g");
    close.lastIndex = re.lastIndex;
    let depth = 1;
    let c: RegExpExecArray | null;
    while (depth > 0 && (c = close.exec(inner))) {
      if (c[0].startsWith("</")) depth--;
      else if (c[2] !== "/") depth++;
    }
    if (depth > 0) break; // 짝이 안 맞는 문서 — 남은 건 포기한다
    out.push({ name, start, end: close.lastIndex });
    re.lastIndex = close.lastIndex;
  }
  return out;
}

/** 여는 태그를 뺀 내용물. 자기닫힘이면 빈 문자열. */
export function innerXml(element: string): string {
  if (/\/>\s*$/.test(element) && !/<\/[^>]+>\s*$/.test(element)) return "";
  const open = element.indexOf(">");
  const close = element.lastIndexOf("</");
  if (open < 0 || close < open) return "";
  return element.slice(open + 1, close);
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

export function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}
