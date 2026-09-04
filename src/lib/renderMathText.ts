import katex from "katex";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 연속된 공백을 살린다.
 *
 * HTML은 공백 여러 칸을 한 칸으로 붙여버려서, 사용자가 본문에서 간격을 벌려
 * 놔도 화면에는 반영되지 않았다. 마지막 한 칸만 보통 공백으로 두고 나머지를
 * 줄바꿈 없는 공백으로 바꾸면, 간격은 그대로 유지되면서 줄바꿈은 정상적으로
 * 일어난다(전부 NBSP로 바꾸면 긴 공백에서 줄이 안 넘어가 카드가 삐져나간다).
 */
function preserveSpaces(escaped: string): string {
  return escaped.replace(/ {2,}/g, (run) => "\u00a0".repeat(run.length - 1) + " ");
}

// 독립적으로 떨어진 숫자(예: "1", "3.5")는 본문 글자가 아니라 수식 폰트로 보여준다.
// 단, 한글/알파벳에 붙은 숫자("2점", "x1", "22.")는 건드리지 않는다.
const WORDISH = /[\wㄱ-ㅎ가-힣]/;

/**
 * 일반 텍스트를 HTML로 변환하되, 홀로 떨어진 숫자는 수식으로 렌더링한다.
 */
function textToInlineHtml(str: string): string {
  const tokens = str.split(/(\d+(?:\.\d+)?)/);
  let html = "";
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (i % 2 === 1) {
      // 숫자 토큰: 앞뒤가 글자(한글/영문)에 붙어 있지 않으면 수식으로.
      const prevCh = (tokens[i - 1] ?? "").slice(-1);
      const nextCh = (tokens[i + 1] ?? "").slice(0, 1);
      const attached = WORDISH.test(prevCh) || WORDISH.test(nextCh);
      if (!attached) {
        html += renderMath(token, false);
        continue;
      }
    }
    html += preserveSpaces(escapeHtml(token)).replace(/\n/g, "<br />");
  }
  return html;
}

// 첨자가 옆이 아니라 위/아래로 붙어야 자연스러운 큰 연산자들.
const LIMIT_OPERATORS = [
  "sum",
  "prod",
  "coprod",
  "bigcup",
  "bigcap",
  "bigsqcup",
  "bigvee",
  "bigwedge",
  "bigodot",
  "bigotimes",
  "bigoplus",
  "biguplus",
];

/**
 * Mathpix가 준 LaTeX를 보기 좋게 자동 보정한다.
 * - ∑, ∏ 같은 큰 연산자는 첨자(n=1, k 등)가 옆이 아니라 위/아래로 붙도록
 *   `\limits`를 강제한다. (이미 \limits/\nolimits가 있으면 건드리지 않는다.)
 */
function enhanceLatex(latex: string): string {
  const ops = LIMIT_OPERATORS.join("|");
  const opPattern = new RegExp(
    "\\\\(" + ops + ")(?![a-zA-Z])(?!\\s*\\\\(?:no)?limits)",
    "g",
  );
  return latex.replace(opPattern, "\\$1\\limits");
}

/**
 * Mathpix가 배열/케이스(구간별 정의) 수식을 여러 줄로 나눠 보내면서 "\left\"
 * 처럼 백슬래시 바로 뒤에 개행이 끼어드는 경우가 있다. TeX는 백슬래시 다음에
 * 오는 공백(개행 포함)을 그대로 컨트롤 시퀀스 이름으로 읽어버려
 * "Invalid delimiter '\ ' after '\left'" 같은 파싱 오류가 나 수식 전체가
 * 렌더링되지 않는다. 백슬래시와 '{'/'}' 사이의 공백(개행 포함)을 제거해
 * 원래 의도한 "\{"/"\}"로 되돌린다.
 */
function sanitizeBrokenDelimiters(latex: string): string {
  return latex.replace(/\\[ \t\r\n]+([{}])/g, "\\$1");
}

function renderMath(latex: string, displayMode: boolean): string {
  // displaystyle을 강제해 인라인 수식에서도 적분·분수·시그마가 큼직하게
  // (교과서처럼) 렌더링되도록 한다.
  const enhanced = `\\displaystyle ${enhanceLatex(sanitizeBrokenDelimiters(latex))}`;
  try {
    return katex.renderToString(enhanced, {
      throwOnError: false,
      displayMode,
      strict: "ignore",
    });
  } catch {
    return `<span class="text-red-500">${escapeHtml(latex)}</span>`;
  }
}

// Mathpix는 응답 버전에 따라 "\[ \]"/"\( \)" 델리미터를 쓰기도 하므로 "$"/"$$"로 통일한다.
function normalizeDelimiters(input: string): string {
  return input
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, expr) => `$$${expr}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, expr) => `$${expr}$`);
}

const PROBLEM_NUMBER = /^(\d{1,3}\s*\.)(\s*)/;

// 문제집에서 "(가)", "(나)", "(다)"처럼 조건을 나열할 때 쓰는 표지. Mathpix는
// 이 부분을 ">" 인용 문법 없이 그냥 일반 줄로 보내는 경우가 많아서, 표지로
// 시작하는 줄인지는 별도로 감지해야 한다(원본 문제집에서는 테두리 박스로
// 보이는 부분).
const CONDITION_MARKER = /^\s*\([가나다라마바사아자차카타파하]\)\s*/;

// 합답형 문항의 "<보기>" 머리글. 문제집마다 꺾쇠(<보기>), 홑화살괄호(〈보기〉),
// 대괄호([보기])를 섞어 쓰고 Mathpix도 본 대로 옮겨오므로 다 받아준다.
// 머리글만 있는 줄이어야 한다 — 본문 중에 "보기"라는 낱말이 나오는 것과 구분한다.
const BOGI_HEADER = /^\s*[<〈[]\s*보\s*기\s*[>〉\]]\s*$/;

// "ㄱ.", "ㄴ)", "ㄷ," 처럼 자음 하나로 시작하는 보기 항목 줄.
//
// 한때 표지를 span으로 감싸 1.3배로 키웠다(낱자는 나눔명조에서 음절보다 작게
// 그려진다). 사용자가 그냥 1배가 낫다고 해서 되돌렸다 — 표지는 본문과 같은
// 크기로 그린다. 다시 시도할 거면 globals.css 이력의 .mmd-bogi-marker 참고.
const BOGI_ITEM = /^\s*[ㄱ-ㅎ]\s*[.,)]/;

/**
 * Mathpix가 보기 표지를 "조합용 자모"(U+1100~, ᄀᄂᄃ)로 주는 경우가 있다.
 * 이건 음절을 조립할 때 쓰는 코드라 홀로 쓰면 위첨자처럼 아주 작게 그려져
 * 눈에 띄게 깨져 보이고, 위의 BOGI_ITEM(U+3131~)에도 걸리지 않아 박스 감지
 * 자체가 안 된다. 겉보기가 같은 "호환용 자모"(U+3131~)로 바꿔 둔다.
 *
 * 유니코드 정규화(NFKC)로는 안 된다 — 표준이 정한 방향이 반대라서
 * ㄱ(3131) → ᄀ(1100)으로 가버린다. 그래서 표를 직접 들고 있는다.
 * 두 문자열은 같은 순서의 초성 19자다.
 */
const CHOSEONG_JAMO = "ᄀᄁᄂᄃᄄᄅᄆᄇᄈᄉᄊᄋᄌᄍᄎᄏᄐᄑᄒ";
const COMPAT_JAMO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";

export function normalizeJamo(input: string): string {
  return input.replace(/[ᄀ-ᄒ]/g, (ch) => {
    const i = CHOSEONG_JAMO.indexOf(ch);
    return i === -1 ? ch : COMPAT_JAMO[i];
  });
}

/**
 * 보기 표지("ㄷ.")의 길이. 표지가 아니면 0.
 *
 * 표지에 붙은 마침표는 문장의 끝이 아니다. 이걸 구분하지 않으면
 * "ㄷ. 교점은 두 개이다."에서 첫 마침표(표지의 것)를 문장 끝으로 보고
 * 박스를 거기서 닫아, 표지만 박스에 남고 정작 내용이 박스 밖으로 빠진다.
 */
function markerPrefixLength(line: string): number {
  const m = line.match(BOGI_ITEM);
  return m ? m[0].length : 0;
}

// 한글/CJK 문자(수식이 아니라 설명 텍스트로 간주).
const CJK_PATTERN = /[　-〿㐀-鿿가-힯＀-￯]/;
// 델리미터가 없어도 수식으로 볼 만한 토큰(위/아래 첨자, 중괄호, 백슬래시 명령).
const MATH_TOKEN_PATTERN = /[\\^_{}]/;

/**
 * "$"가 전혀 없어도 통째로 수식으로 렌더할 만한 순수 수식 블록인지 판단한다.
 * (한글이 섞여 있으면 설명 문장으로 보고 그대로 둔다 — 이때는 $...$가 필요.)
 */
function isBareMathBlock(s: string): boolean {
  return (
    !s.includes("$") && !CJK_PATTERN.test(s) && MATH_TOKEN_PATTERN.test(s)
  );
}

// Mathpix가 배열/케이스 수식 안에 빈 줄까지 끼워 보내는 경우, 문단을 빈 줄
// 기준으로 나누는 로직이 "$$...$$" 하나를 여러 조각으로 쪼개버려 LaTeX 원문이
// 그대로 글자로 노출되는 문제가 있었다. 문단/줄 분리를 하기 전에 "$$...$$"
// 전체를 플레이스홀더 토큰(줄바꿈 없는 한 덩어리)으로 바꿔 보호했다가,
// 실제 렌더링 직전(줄 단위)에 원문으로 되돌린다.
const MATH_PLACEHOLDER = /\x00MATH(\d+)\x00/g;

function protectDisplayMath(input: string): { text: string; blocks: string[] } {
  const blocks: string[] = [];
  const text = input.replace(/\$\$[\s\S]+?\$\$/g, (match) => {
    const token = `\x00MATH${blocks.length}\x00`;
    blocks.push(match);
    return token;
  });
  return { text, blocks };
}

function restoreDisplayMath(s: string, blocks: string[]): string {
  if (blocks.length === 0) return s;
  return s.replace(MATH_PLACEHOLDER, (_, i) => blocks[Number(i)]);
}

const MATH_PLACEHOLDER_ONLY_LINE = /^\x00MATH\d+\x00$/;

/**
 * 블록 전체가 디스플레이 수식 플레이스홀더 줄들로만 이루어져 있는지 본다
 * ("(나) ...이고" 다음에 오는 "\[ x=\alpha,... \]"처럼, 조건 문장이 수식
 * 때문에 별도 블록으로 갈라진 경우가 정확히 이 모양이다). 이 조건을 만족할
 * 때만 조건 박스가 블록 경계를 넘어가도 되게 해서 — (가)/(나)가 마침표 없는
 * 순수 수식으로 끝나는 문제(예: "(나) 2×sin(∠ECD)=3×sin(∠EDC)")에서 다음에
 * 오는 무관한 본문("DF의 값은?" 등)까지 마침표를 찾는다고 한없이 삼켜버리는
 * 일이 없게 한다.
 */
function isPureMathPlaceholderBlock(block: string): boolean {
  const lines = block.split("\n").map((l) => l.trim());
  return lines.length > 0 && lines.every((l) => MATH_PLACEHOLDER_ONLY_LINE.test(l));
}

// 표준정규분포표처럼 문제집이 "\begin{tabular}...\end{tabular}"로 표를
// 보내는 경우가 있다. KaTeX는 tabular 환경을 지원하지 않고, 줄 단위 렌더링
// 로직이 표 안의 개행까지 각각 별도 줄로 쪼개버려 표가 아예 사라지거나
// 깨진 글자로 노출됐다. 문단/줄 분리 전에 tabular 블록 전체를 실제 HTML
// <table>로 미리 변환해 플레이스홀더 토큰(줄바꿈 없는 한 줄)으로 바꿔두고,
// renderBlock에서 그 줄을 찾아 표만 따로 떼어 형제 요소로 내보낸다.
// 앞뒤의 "$$"까지 같이 먹는다. Mathpix가 표를 수식 안에 넣어 보내는 경우가
// 있는데($$\begin{tabular}...$$), 표만 토큰으로 바꾸고 "$$"를 남겨두면
// "$$\x00TABLE0\x00$$"가 되어 KaTeX가 NUL 문자를 파싱하다 실패하고,
// 실패한 원문("\displaystyle ...")이 빨간 글씨로 그대로 화면에 찍힌다.
// 열 지정 앞에 배치 옵션이 붙기도 하고(\begin{tabular}[t]{|l|l|}), 열 지정
// 안에 중괄호가 또 들어가기도 한다(@{}ll@{}). 둘 다 안 받으면 패턴이 안 걸려
// 표가 통째로 KaTeX로 넘어가고, 거기서 실패해 원문이 화면에 찍힌다.
//
// 앞뒤 공백은 **"$$"에 붙은 것만** 먹는다. 예전에는 그냥 "\s*"라 표 앞뒤의
// 빈 줄까지 삼켰고, 그러면 토큰이 앞 문장과 같은 줄에 붙어버려 표가 문단
// 안에 갇혔다 — 마크다운 표는 제 줄에 남아 별도 블록이 되는데 tabular만
// 그러지 못해, 같은 표인데 어느 형식으로 왔느냐에 따라 다르게 그려졌다.
// 표를 손으로 끌어 옮기려면 표가 제 블록이어야 한다.
// 한 줄로 늘어놓으면 읽을 수가 없어서 조각으로 나눠 조립한다.
/** 중괄호 한 겹까지 품는 인자. 열 지정에 "@{}ll@{}"나 "p{2cm}"이 들어온다. */
const TB_ARG = String.raw`\{(?:[^{}]|\{[^{}]*\})*\}`;
/**
 * 표를 감싼 수식 델리미터.
 *
 * `$$`뿐 아니라 **홑 `$`**도 받아야 한다. 홑 `$`를 놓치면 `$\x00TABLE0\x00$`가
 * 남아 KaTeX가 NUL을 파싱하다 실패하고 "\displaystyle …"이 빨간 글씨로 찍힌다.
 * `$$\displaystyle\begin{tabular}`처럼 스타일 명령이 끼어드는 것도 받는다.
 *
 * `\s*`가 `$` **뒤에** 있는 게 중요하다 — 앞에 두면 표 앞의 빈 줄까지 삼켜
 * 표가 앞 문단에 붙어버린다.
 */
const TB_STYLE = String.raw`(?:\\(?:display|text|script|scriptscript)style\s*)?`;
// tabularx/tabular*는 열 지정 앞에 폭 인자가 하나 더 붙는다
// (\begin{tabularx}{\textwidth}{|X|X|}). 개수가 달라서 환경별로 나눠 적는다.
const TB_ENV =
  "(?:" +
  String.raw`\\begin\{tabular\}\s*(?:\[[^\]]*\])?\s*${TB_ARG}` +
  "|" +
  String.raw`\\begin\{tabularx\}\s*(?:\[[^\]]*\])?\s*${TB_ARG}\s*${TB_ARG}` +
  "|" +
  String.raw`\\begin\{tabular\*\}\s*(?:\[[^\]]*\])?\s*${TB_ARG}\s*${TB_ARG}` +
  ")";
const TB_BODY = String.raw`([\s\S]*?)\\end\{tabular[x*]?\}`;

/**
 * 델리미터는 **여는 것과 닫는 것을 짝으로** 적는다. "닫는 쪽만 선택적"으로
 * 두면 안 된다 — `\s*(?:\$\$|\$)?`가 표 뒤의 빈 줄을 삼킨 뒤 **다음 문장의
 * 여는 `$`**를 닫는 델리미터로 집어먹는다(실제로 "$P(0<Z<1)$의 값은?"이
 * 통째로 표 안으로 빨려 들어갔다). 그래서 세 가지를 따로 늘어놓는다.
 * `$$` 쪽을 먼저 둬야 `$$`가 `$` 하나로 반쪽만 잡히지 않는다.
 *
 * 본문 캡처가 형태마다 다른 번호로 잡히므로, 쓰는 쪽에서 먼저 잡힌 것을 고른다.
 */
const TABULAR_PATTERN = new RegExp(
  [
    String.raw`\$\$\s*${TB_STYLE}${TB_ENV}${TB_BODY}\s*\$\$`,
    String.raw`\$\s*${TB_STYLE}${TB_ENV}${TB_BODY}\s*\$`,
    `${TB_ENV}${TB_BODY}`,
  ].join("|"),
  "g",
);

/** `s[i]`가 "{"일 때 짝이 맞는 "}"까지 읽는다. 없으면 null. */
function readBraceGroup(s: string, i: number): { text: string; end: number } | null {
  if (s[i] !== "{") return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "{") depth++;
    else if (s[j] === "}") {
      depth--;
      if (depth === 0) return { text: s.slice(i + 1, j), end: j + 1 };
    }
  }
  return null;
}

/**
 * 병합 셀을 알아본다.
 *
 * `\multicolumn{2}{|c|}{구분}` / `\multirow{2}{*}{지역}`. 이걸 모르면 명령이
 * 글자 그대로 표 안에 찍힌다 — 사회탐구 표에는 병합이 아주 흔하다.
 * 내용에 중괄호가 또 들어갈 수 있어서(`{\bf 갑}`) 정규식이 아니라 짝맞추기로 읽는다.
 */
function parseSpanCell(cell: string): {
  content: string;
  colspan: number;
  rowspan: number;
} {
  const plain = { content: cell, colspan: 1, rowspan: 1 };
  const m = cell.match(/^\\(multicolumn|multirow)\s*/);
  if (!m) return plain;

  // 둘 다 인자가 셋이고 **내용은 마지막 인자**다.
  //   \multicolumn{2}{|c|}{인구 구성}   \multirow{2}{*}{A 지역}
  // 가운데(정렬·폭)를 내용으로 잘못 읽으면 칸에 "|c|"가 찍힌다.
  const count = readBraceGroup(cell, m[0].length);
  if (!count) return plain;
  const middle = readBraceGroup(cell, count.end);
  if (!middle) return plain;
  const body = readBraceGroup(cell, middle.end);
  if (!body) return plain;

  // 명령 뒤에 글자가 더 있으면 버리지 않고 붙인다.
  const rest = cell.slice(body.end).trim();
  const n = Number(count.text.trim());
  const span = Number.isInteger(n) && n > 1 ? n : 1;
  return {
    content: (body.text + (rest ? ` ${rest}` : "")).trim(),
    colspan: m[1] === "multicolumn" ? span : 1,
    rowspan: m[1] === "multirow" ? span : 1,
  };
}

function tabularToTableHtml(body: string): string {
  const rows = body
    // 행 끝의 "\\"는 뒤에 간격 지정이 붙기도 한다("\\[2mm]").
    .split(/\\\\/)
    .map((row) =>
      row
        // \hline과 \cline{1-2}는 가로줄 지시라 표시할 내용이 아니다.
        // 남겨두면 "\cline{1-2}"가 글자 그대로 칸 안에 찍힌다.
        .replace(/\\hline|\\cline\s*\{[^}]*\}|\\toprule|\\midrule|\\bottomrule/g, "")
        .replace(/^\s*\[[^\]]*\]/, "")
        .trim(),
    )
    .filter((row) => row.length > 0);

  // 세로 병합(\multirow)이 걸린 열은 다음 행에서 **빈 자리표시 칸**으로 나온다
  //   \multirow{2}{*}{A 지역} & 인구 \\
  //    & 면적 \\        ← 앞의 빈 칸은 위 칸이 차지한 자리다
  // LaTeX는 그 빈 칸이 있어야 하지만 HTML의 rowspan은 아예 없어야 한다.
  // 그대로 두면 칸이 하나씩 밀려 표가 어긋난다. 열마다 남은 행 수를 세어 버린다.
  const covered: number[] = [];
  const rowsHtml = rows
    .map((row, i) => {
      const tag = i === 0 ? "th" : "td";
      const cells = row.split("&");
      let out = "";
      let col = 0;
      for (let ci = 0; ci < cells.length; ) {
        if ((covered[col] ?? 0) > 0) {
          covered[col] -= 1;
          // 자리표시 칸(빈 칸)만 버린다. 내용이 있으면 표가 우리 예상과
          // 다른 것이므로 함부로 버리지 않는다.
          if (cells[ci].trim() === "") ci += 1;
          col += 1;
          continue;
        }
        const c = parseSpanCell(cells[ci].trim());
        const attr =
          (c.colspan > 1 ? ` colspan="${c.colspan}"` : "") +
          (c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : "");
        out += `<${tag}${attr}>${renderInline(c.content)}</${tag}>`;
        if (c.rowspan > 1) {
          for (let k = 0; k < c.colspan; k++) covered[col + k] = c.rowspan - 1;
        }
        col += c.colspan;
        ci += 1;
      }
      return `<tr>${out}</tr>`;
    })
    .join("");

  return `<table class="mmd-table">${rowsHtml}</table>`;
}

// Mathpix의 기본 출력(mmd)은 표를 **마크다운**으로 준다. 이게 지금까지
// 전혀 처리되지 않아서 "| z | P |" 같은 줄이 글자 그대로 찍혔다.
//   | $z$ | $P$ |
//   | :---: | :---: |
//   | 1.0 | 0.3413 |
const MD_TABLE_ROW = /^\s*\|(.+)\|\s*$/;
/** 머리글과 본문을 가르는 줄. 셀이 ---, :---:, ---: 중 하나여야 한다. */
const MD_TABLE_SEPARATOR = /^\s*\|[\s:|-]+\|\s*$/;

/**
 * 바깥 파이프가 없는 표도 있다.
 *   구분 | 값
 *   :---: | :---:
 *   갑 | 1
 * 구분선만은 확실히 알아볼 수 있으므로(대시 묶음이 파이프로 이어진 줄),
 * 그 줄을 기준으로 표를 찾는다. 그냥 "|가 있는 줄"로 잡으면 절댓값 기호가
 * 든 문장이 표로 둔갑한다.
 */
const MD_BARE_SEPARATOR = /^\s*:?-{2,}:?(\s*\|\s*:?-{2,}:?)+\s*$/;
const MD_BARE_ROW = /^[^|\n]*\|[^\n]*$/;

/**
 * 마크다운 표의 한 줄을 셀로 쪼갠다.
 * "$...$" 안의 "|"는 구분자가 아니다(절댓값 기호 등).
 */
function splitMarkdownRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  let inMath = false;
  for (const ch of inner) {
    if (ch === "$") inMath = !inMath;
    if (ch === "|" && !inMath) {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function markdownTableHtml(header: string[], rows: string[][]): string {
  const head = `<tr>${header.map((c) => `<th>${renderInline(c)}</th>`).join("")}</tr>`;
  const body = rows
    .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<table class="mmd-table">${head}${body}</table>`;
}

/**
 * 표(LaTeX tabular, 마크다운) 전부를 미리 HTML로 바꿔 토큰으로 감춘다.
 *
 * 문단/줄 분리를 하기 전에 처리해야 한다 — 안 그러면 표 안의 개행이 각각
 * 별도 줄로 쪼개져 표가 사라지거나 깨진 글자로 노출된다.
 */
function protectTables(input: string): { text: string; tables: string[] } {
  const tables: string[] = [];

  const withoutTabular = input.replace(
    TABULAR_PATTERN,
    (_match, dd?: string, d?: string, bare?: string) => {
      const token = `\x00TABLE${tables.length}\x00`;
      // 세 형태 중 실제로 잡힌 본문 하나를 고른다(위 TABULAR_PATTERN 주석 참고).
      tables.push(tabularToTableHtml(dd ?? d ?? bare ?? ""));
      return token;
    },
  );

  const lines = withoutTabular.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    // ① 구분선이 있는 표(파이프가 바깥에 있든 없든).
    const sepNext =
      i + 1 < lines.length &&
      (MD_TABLE_SEPARATOR.test(lines[i + 1]) || MD_BARE_SEPARATOR.test(lines[i + 1]));
    const rowish = MD_TABLE_ROW.test(lines[i]) || MD_BARE_ROW.test(lines[i]);
    if (rowish && sepNext) {
      const header = splitMarkdownRow(lines[i]);
      const rows: string[][] = [];
      let j = i + 2;
      while (
        j < lines.length &&
        (MD_TABLE_ROW.test(lines[j]) || MD_BARE_ROW.test(lines[j])) &&
        !MD_TABLE_SEPARATOR.test(lines[j]) &&
        !MD_BARE_SEPARATOR.test(lines[j])
      ) {
        rows.push(splitMarkdownRow(lines[j]));
        j++;
      }
      out.push(`\x00TABLE${tables.length}\x00`);
      tables.push(markdownTableHtml(header, rows));
      i = j - 1;
      continue;
    }

    // ② 구분선이 아예 없는 표. Mathpix가 머리글 구분선을 빼고 줄만 주는
    // 경우가 있다. 아무 "|" 줄이나 표로 보면 절댓값이 든 문장("$|x|=3$")이
    // 표로 둔갑하므로, **바깥 파이프가 있고 칸 수가 똑같은 줄이 둘 이상**
    // 이어질 때만 표로 본다.
    if (MD_TABLE_ROW.test(lines[i])) {
      const width = splitMarkdownRow(lines[i]).length;
      let j = i;
      while (
        j < lines.length &&
        MD_TABLE_ROW.test(lines[j]) &&
        !MD_TABLE_SEPARATOR.test(lines[j]) &&
        splitMarkdownRow(lines[j]).length === width
      ) {
        j++;
      }
      if (width >= 2 && j - i >= 2) {
        const block = lines.slice(i, j).map(splitMarkdownRow);
        out.push(`\x00TABLE${tables.length}\x00`);
        tables.push(markdownTableHtml(block[0], block.slice(1)));
        i = j - 1;
        continue;
      }
    }

    out.push(lines[i]);
  }

  return { text: out.join("\n"), tables };
}

const TABLE_PLACEHOLDER_ONLY = /^\x00TABLE(\d+)\x00$/;
const TABLE_PLACEHOLDER = /\x00TABLE(\d+)\x00/g;

function restoreTables(html: string, tables: string[]): string {
  if (tables.length === 0) return html;
  return html.replace(TABLE_PLACEHOLDER, (_, i) => tables[Number(i)]);
}

// 객관식 보기 표지. Mathpix는 문제집의 "①②③④⑤"를 그대로 주기도 하고
// "(1) (2) ..." 나 "1) 2) ..." 로 풀어서 주기도 한다. 어느 쪽으로 오든 원숫자로 통일한다.
const CHOICE_MARKER_AT_START =
  /^\s*(?:[①-⑳]|\((\d{1,2})\)|(\d{1,2})\))\s*/;

/**
 * 합쳐진 보기 줄에서 각 보기를 나누는 자리(원숫자 표지 바로 앞).
 * 보기 사이 간격은 글자가 아니라 CSS(.mmd-choice-gap)로 준다 — 공백 개수로
 * 벌리면 글자 크기를 바꿀 때마다 간격이 어긋나고, 넓이를 조절하려면 매번
 * 코드를 고쳐야 한다.
 */
const CHOICE_SPLIT = /(?=[\u2460-\u2473])/;

/** 원문에서 보기를 이어붙일 때 쓰는 구분자(화면 간격은 CSS가 정한다). */
const CHOICE_SEPARATOR = " ";

/** 이 줄이 객관식 보기로 시작하는가. */
function isChoiceLine(line: string): boolean {
  return CHOICE_MARKER_AT_START.test(line);
}

/**
 * 보기 표지를 원숫자로 바꾼다. 보기 줄로 확인된 줄에만 적용한다 —
 * 아무 줄에나 돌리면 좌표 "(1)"이나 수식 속 괄호까지 바꿔버린다.
 * 줄 맨 앞이거나 공백 뒤에 오는 "(n)" / "n)" 만 표지로 본다.
 */
function toCircledMarkers(line: string): string {
  return line.replace(
    /(^|\s)(?:\((\d{1,2})\)|(\d{1,2})\))/g,
    (whole, lead: string, paren?: string, bare?: string) => {
      const n = Number(paren ?? bare);
      const circled = n >= 1 && n <= 20 ? String.fromCharCode(0x245f + n) : null;
      return circled ? `${lead}${circled}` : whole;
    },
  );
}

/**
 * 연속된 객관식 보기 줄을 한 줄로 합친다.
 *
 * Mathpix는 보기를 줄마다 하나씩("(1) 1" 개행 "(2) 2" ...) 주는 경우가 많은데,
 * 그대로 렌더링하면 보기가 세로로 길게 깔려 문제집 모양과 달라지고 한 페이지에
 * 한 문제를 넣기도 어려워진다. 문제집처럼 한 줄에 나란히 놓고 띄어쓰기 하나로
 * 잇는다.
 */
function mergeChoiceLines(lines: string[]): string[] {
  const out: string[] = [];
  let run: string[] = [];

  const flush = () => {
    if (run.length === 0) return;
    // 조각마다 앞뒤 공백을 떼고 공백 두 칸(CHOICE_SEPARATOR)으로 잇는다.
    out.push(run.map((l) => toCircledMarkers(l).trim()).join(CHOICE_SEPARATOR));
    run = [];
  };

  for (const line of lines) {
    if (isChoiceLine(line)) {
      run.push(line);
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return out;
}

/** 한 줄(내부 줄바꿈 없음)을 렌더링한다. 순수 수식이면 통째로, 아니면 "$...$" 단위로. */
function renderLineContent(line: string, mathBlocks: string[]): string {
  const restored = restoreDisplayMath(line, mathBlocks);
  if (isBareMathBlock(restored)) {
    return renderMath(restored.trim(), true);
  }
  return renderInline(restored);
}

/**
 * 보기 줄을 원숫자 표지마다 잘라 각각 렌더링하고, 사이에 빈 span을 끼워
 * 넣는다. 간격을 CSS(.mmd-choice-gap)가 정하므로 글자 크기를 바꿔도 비율이
 * 유지되고, 넓이를 조절할 때 코드가 아니라 스타일만 고치면 된다.
 * (공백 문자로 벌리면 폰트마다 폭이 달라 문제집처럼 고르게 나오지 않는다.)
 */
function renderChoiceLine(line: string, mathBlocks: string[]): string {
  const parts = line.split(CHOICE_SPLIT).filter((p) => p.trim() !== "");
  if (parts.length <= 1) return renderLineContent(line, mathBlocks);
  // 각 보기를 통째로 묶어 표지(⑤)와 값(12)이 서로 다른 줄로 갈라지지 않게 한다.
  return parts
    .map(
      (p) =>
        `<span class="mmd-choice">${renderLineContent(p.trim(), mathBlocks)}</span>`,
    )
    .join('<span class="mmd-choice-gap"></span>');
}

/**
 * 블록 안의 각 줄을 "이미 줄바꿈된" 단위로 보고 한 줄씩 렌더링한다.
 * 원본에 줄바꿈이 있던 자리에만 여백(.mmd-line)을 줘서 위아래 수식이 너무
 * 붙지 않게 하고, 한 줄 안의 띄어쓰기는 그대로 둔다(새 줄바꿈을 만들지 않음).
 */
function renderLines(
  lines: string[],
  firstLineHasNumber: boolean,
  mathBlocks: string[],
): string {
  return renderLineList(lines, firstLineHasNumber, mathBlocks).join("");
}

/**
 * 위와 같지만 이어붙이지 않고 줄 하나씩 배열로 돌려준다.
 *
 * 조건 박스·보기 박스 **안에** 도형이나 자료를 끼워 넣으려면 박스 속 줄
 * 사이사이가 어디인지 알아야 한다. 박스를 통짜 문자열로 만들어 버리면 그
 * 경계가 사라진다.
 */
function renderLineList(
  lines: string[],
  firstLineHasNumber: boolean,
  mathBlocks: string[],
): string[] {
  // 보기는 한 줄로 합쳐서 문제집처럼 나란히 놓는다. 문제번호가 붙는 첫 줄은
  // 보기 줄이 아니므로 합치기 뒤에도 인덱스 0 그대로다.
  return mergeChoiceLines(lines)
    .map((line, i) => {
      let inner: string;
      if (firstLineHasNumber && i === 0) {
        const m = line.match(PROBLEM_NUMBER);
        if (m) {
          const rest = line.slice(m[0].length);
          inner = `<strong class="mmd-problem-number">${escapeHtml(
            m[1],
          )}</strong> ${renderLineContent(rest, mathBlocks)}`;
        } else {
          inner = renderLineContent(line, mathBlocks);
        }
      } else if (isChoiceLine(line)) {
        inner = renderChoiceLine(line, mathBlocks);
      } else {
        inner = renderLineContent(line, mathBlocks);
      }
      // 보기 줄은 줄 간격을 따로 주려고 표시해둔다(위 문장과 붙어 보이지 않게).
      const cls = isChoiceLine(line) ? "mmd-line mmd-choices" : "mmd-line";
      return `<span class="${cls}">${inner}</span>`;
    });
}

/** 한 문단(블록) 안의 "$$...$$"/"$...$" 수식과 일반 텍스트를 인라인 HTML로 변환한다. */
function renderInline(text: string): string {
  const pattern = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;

  let lastIndex = 0;
  let html = "";
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    html += textToInlineHtml(text.slice(lastIndex, match.index));

    if (match[1] !== undefined) {
      html += renderMath(match[1].trim(), true);
    } else if (match[2] !== undefined) {
      html += renderMath(match[2].trim(), false);
    }

    lastIndex = pattern.lastIndex;
  }

  html += textToInlineHtml(text.slice(lastIndex));

  return html;
}

// 문장 끝을 나타내는 마침표. 종결어미(-다/-이다 등) 패턴이 아니라 글자
// 그대로의 "."로만 판단한다. 소수점(예: "10.5")은 문장 끝이 아니므로 제외.
const SENTENCE_END = /\.(?!\d)/;

// (가)/(나) 조건이 마침표 없는 순수 수식으로 끝나는 문제(예: "(나) 2×sin(∠ECD)
// =3×sin(∠EDC)")도 있다. 이때 마침표를 찾겠다고 뒤쪽 줄을 계속 뒤지면, 조건과
// 무관한 실제 질문("DF의 값은?")이나 객관식 선택지(①~⑤, (1)~(5))에는 애초에
// 마침표가 없으니 문서 끝까지(또는 다음 마침표가 나오는 아무 데나) 삼켜버릴
// 위험이 있다. 그래서 마침표를 찾는 도중 이런 줄을 만나면 그 자리를 "조건
// 목록이 끝났다"는 확실한 벽으로 보고, 마침표를 못 찾은 것과 똑같이 처리해
// 더 뒤로는 절대 넘어가지 않는다.
const QUESTION_OR_CHOICE_LINE = /[?？]|^\s*(?:[①②③④⑤⑥⑦⑧⑨⑩]|\(\d+\))/;

/**
 * 마지막 조건 표지가 달린 줄을 "그 조건 문장의 마침표"에서 끊는다. 마침표
 * 뒤에 다른 문장(문제 본문)이 이어 붙어 있으면 그 부분은 박스 밖으로 뺀다.
 * 마침표가 없으면(원본에 마침표가 없는 경우) 줄 전체를 그대로 박스에 둔다.
 */
function splitAtSentenceEnd(line: string): { head: string; rest: string | null } {
  // 보기 표지("ㄷ.")의 마침표는 건너뛰고 그 뒤에서 문장 끝을 찾는다.
  const from = markerPrefixLength(line);
  const match = line.slice(from).match(SENTENCE_END);
  if (!match || match.index === undefined) {
    return { head: line, rest: null };
  }
  const cut = from + match.index + 1;
  const head = line.slice(0, cut);
  const rest = line.slice(cut).trim();
  return { head, rest: rest.length > 0 ? rest : null };
}

/**
 * 이 줄에 "문장이 끝났다고 볼 마침표"가 있는지 판단한다. "$$...$$"(디스플레이
 * 수식)는 protectDisplayMath가 플레이스홀더 토큰(예: "\x00MATH2\x00")으로
 * 감춰둔 상태라, 마침표가 "\[ x=\alpha,... \text{ 에서 극소이다. } \]"처럼
 * 수식 안쪽에 있으면 줄의 원문에는 마침표가 안 보인다. 그래서 원문에 없으면
 * 복원한(플레이스홀더를 실제 수식으로 되돌린) 내용까지 확인한다.
 */
function lineHasSentenceEnd(line: string, mathBlocks: string[]): boolean {
  const restored = restoreDisplayMath(line, mathBlocks);
  // 보기 표지의 마침표는 문장 끝이 아니다.
  return SENTENCE_END.test(restored.slice(markerPrefixLength(restored)));
}

/**
 * 조건 문장이 끝나는 줄을 박스에 마저 담는다. 마침표가 줄 원문에 그대로
 * 보이면(일반 텍스트 줄) 기존처럼 그 지점에서 잘라 뒤쪽을 박스 밖으로 뺀다.
 * 마침표가 디스플레이 수식 플레이스홀더 안에 숨어 있는 경우(원문엔 마침표가
 * 안 보임)는 그 자리에서 안전하게 자를 수 없으므로 — 잘라내면 "$$"/"}" 같은
 * 수식 델리미터가 반토막 나 렌더링이 깨진다 — 줄 전체를 그대로 박스에 넣고
 * 아무것도 박스 밖으로 빼지 않는다.
 */
function closeBoxAtLine(
  line: string,
  mathBlocks: string[],
): { head: string; rest: string | null } {
  if (SENTENCE_END.test(line.slice(markerPrefixLength(line)))) {
    return splitAtSentenceEnd(line);
  }
  return { head: line, rest: null };
}

/** 조건 박스로 묶을 줄 범위(양끝 포함). 줄 번호는 getTextLines()의 인덱스다. */
export type BoxRange = { start: number; end: number };

/**
 * 사용자가 지정한 박스.
 *
 * 지금 쓰는 형태는 `{ ranges: [...] }` 하나뿐이고 빈 배열이 "박스 없음"이다.
 * 나머지 두 형태는 DB(problems.box_range)에 이미 저장돼 있는 옛 값들이라
 * 읽기만 한다 — 박스를 하나만 만들 수 있던 시절의 `{ start, end }`와,
 * "박스 없음"을 뜻하던 `{ none: true }`. 옛 행을 마이그레이션하지 않고도
 * 그대로 열리게 하려고 남겨둔다.
 */
export type BoxOverride =
  | { ranges: BoxRange[] | null; fontPt?: number }
  | BoxRange
  | { none: true }
  | null;

/**
 * 범위 목록을 정리한다: 뒤집힌 범위를 바로잡고, 앞에서부터 정렬하고,
 * 겹치는 범위는 하나로 합친다. 겹친 채로 그리면 같은 줄이 박스 두 개에
 * 중복해서 나오므로 그리기 전에 반드시 거쳐야 한다.
 *
 * 딱 붙어 있는 범위(앞 박스의 끝 다음 줄이 뒤 박스의 시작)는 합치지 않는다 —
 * 사이에 아무 줄도 없는 박스 두 개를 일부러 나란히 두는 경우가 있다.
 */
export function normalizeBoxRanges(ranges: BoxRange[]): BoxRange[] {
  const sorted = ranges
    .filter(
      (r) =>
        Number.isFinite(r?.start) && Number.isFinite(r?.end),
    )
    .map((r) => ({
      start: Math.min(r.start, r.end),
      end: Math.max(r.start, r.end),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const out: BoxRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
      continue;
    }
    out.push({ ...r });
  }
  return out;
}

/**
 * 저장된 값을 범위 배열로 통일한다. 옛 형태(단일 범위 / `{ none: true }`)도
 * 여기서 흡수하므로, 이 함수를 거친 뒤로는 아무도 형태를 따질 필요가 없다.
 *
 * `null`을 돌려주면 "사용자가 정한 게 없으니 자동 감지에 맡긴다"는 뜻이고,
 * 빈 배열은 "사용자가 박스 없음을 골랐다"는 뜻이다. 둘은 다르다.
 */
export function toBoxRanges(
  override: BoxOverride | undefined,
): BoxRange[] | null {
  if (override === undefined || override === null) return null;
  if ("ranges" in override) {
    // ranges가 null이면 "박스는 자동 감지에 맡긴다"는 뜻이다. 글자 크기 같은
    // 다른 설정만 저장하려고 객체를 쓰는 경우가 있어서 필요하다.
    if (override.ranges === null) return null;
    return normalizeBoxRanges(
      Array.isArray(override.ranges) ? override.ranges : [],
    );
  }
  if ("none" in override) return [];
  return normalizeBoxRanges([override]);
}

/** 범위 배열을 저장·전달용 형태로 감싼다. */
export function fromBoxRanges(ranges: BoxRange[]): BoxOverride {
  return { ranges: normalizeBoxRanges(ranges) };
}

type Block = { lines: string[]; start: number };

/**
 * 빈 줄로 구분된 문단(블록)으로 나누되, 각 블록이 원래 몇 번째 줄에서
 * 시작했는지도 같이 들고 있는다. 박스 범위를 줄 번호로 알려주려면 이 대응이
 * 필요하다(예전엔 split만 해서 원래 위치를 잃어버렸다).
 */
function toBlocks(allLines: string[]): Block[] {
  const blocks: Block[] = [];
  let cur: string[] = [];
  let curStart = 0;
  for (let i = 0; i < allLines.length; i++) {
    if (allLines[i].trim() === "") {
      if (cur.length > 0) {
        blocks.push({ lines: cur, start: curStart });
        cur = [];
      }
      continue;
    }
    if (cur.length === 0) curStart = i;
    cur.push(allLines[i]);
  }
  if (cur.length > 0) blocks.push({ lines: cur, start: curStart });
  return blocks;
}

/**
 * 박스 범위 편집 UI가 쓰는 줄 목록. 렌더러가 내부적으로 나누는 단위와 정확히
 * 같아야 줄 번호가 어긋나지 않으므로, 여기서도 똑같이 델리미터 정규화 →
 * 표/디스플레이 수식 보호를 거친 뒤 나눈다("$$...$$"가 여러 줄에 걸쳐 있어도
 * 한 줄로 취급된다).
 */
export function getTextLines(input: string): string[] {
  const { text: withoutTables } = protectTables(normalizeDelimiters(normalizeJamo(input)));
  return protectDisplayMath(withoutTables).text.split("\n");
}

/** 줄 하나를 화면에 미리 보여주기 위한 HTML(수식은 실제로 렌더링해서 보여준다). */
export function renderPreviewLine(line: string, input: string): string {
  const { text: withoutTables } = protectTables(normalizeDelimiters(normalizeJamo(input)));
  const { blocks } = protectDisplayMath(withoutTables);
  return renderLineContent(line, blocks);
}

/**
 * 빈 줄 아닌 줄들을 문단으로 묶어 렌더링한다(표 토큰은 형제 요소로 뺀다).
 *
 * 이어붙인 문자열이 아니라 최상위 요소 하나씩을 담은 배열을 돌려준다. 문제
 * 카드에서 도형·자료를 문단 **사이**에 끼워 넣으려면 경계를 알아야 하기 때문이다.
 */
function renderPlainRange(
  allLines: string[],
  from: number,
  to: number,
  isFirst: boolean,
  mathBlocks: string[],
  tables: string[],
): RenderedBlock[] {
  if (to < from) return [];
  const parts: RenderedBlock[] = [];
  let first = isFirst;
  for (const block of toBlocks(allLines.slice(from, to + 1))) {
    const lines = block.lines;
    const tableLineIdx = lines.findIndex((line) =>
      TABLE_PLACEHOLDER_ONLY.test(line.trim()),
    );
    if (tableLineIdx !== -1) {
      const match = lines[tableLineIdx].trim().match(TABLE_PLACEHOLDER_ONLY)!;
      const before = lines.slice(0, tableLineIdx);
      const after = lines.slice(tableLineIdx + 1);
      if (before.length > 0) {
        parts.push({
          kind: "plain",
          html: `<p class="mmd-paragraph">${renderLines(before, first, mathBlocks)}</p>`,
        });
        first = false;
      }
      parts.push({
        kind: "table",
        id: tableBlockId(Number(match[1])),
        html: tables[Number(match[1])],
      });
      if (after.length > 0) {
        parts.push({
          kind: "plain",
          html: `<p class="mmd-paragraph">${renderLines(after, false, mathBlocks)}</p>`,
        });
      }
      first = false;
      continue;
    }
    parts.push({
      kind: "plain",
      html: `<p class="mmd-paragraph">${renderLines(lines, first, mathBlocks)}</p>`,
    });
    first = false;
  }
  return parts;
}

/**
 * 카드에 그려지는 최상위 요소 하나.
 *
 * 박스는 통짜 HTML이 아니라 줄 배열로 들고 있는다 — 박스 **안에도** 도형·자료를
 * 끼워 넣을 수 있어야 하는데, 문자열로 합쳐 버리면 줄 사이 경계가 사라진다.
 */
export type RenderedBlock =
  | { kind: "plain"; html: string }
  /**
   * 표는 문단과 따로 구분한다 — 도형·자료처럼 손으로 끌어 옮길 수 있어야 해서,
   * 카드를 조립하는 쪽이 "이건 옮길 수 있는 물건"임을 알아야 한다.
   * id는 원문에서 몇 번째 표인지로 만든다(같은 원문이면 항상 같은 값이라
   * 다시 그려도 놓아둔 자리가 유지된다).
   */
  | { kind: "table"; id: string; html: string }
  | { kind: "box"; lines: string[] };

/** 블록 하나를 최종 HTML로. 사이에 아무것도 끼우지 않을 때 쓴다. */
export function blockToHtml(block: RenderedBlock): string {
  if (block.kind === "plain" || block.kind === "table") return block.html;
  return `<div class="mmd-box">${block.lines.join("")}</div>`;
}

/** 표 블록 하나. 표를 옮길 수 있게 하려고 자리 계산에서 따로 다룬다. */
export function tableBlockId(index: number): string {
  return `table-${index}`;
}

/** 박스 한 개를 그린다. 안이 빈 줄뿐이면 아무것도 그리지 않는다(빈 테두리 방지). */
function renderBox(
  allLines: string[],
  range: BoxRange,
  mathBlocks: string[],
): RenderedBlock | null {
  // 박스 안에서는 빈 줄을 없애고(빈 줄이 있으면 박스가 어색하게 벌어진다)
  // ">" 인용 표시가 남아 있으면 떼어낸다.
  const boxLines = allLines
    .slice(range.start, range.end + 1)
    .filter((line) => line.trim() !== "")
    .map((line) => line.replace(/^\s*>\s?/, ""));
  if (boxLines.length === 0) return null;
  return { kind: "box", lines: renderLineList(boxLines, false, mathBlocks) };
}

/**
 * 사용자가 정한 범위대로만 박스를 친다. 자동 감지 규칙(마침표/질문줄 등)은
 * 일절 적용하지 않는다 — 사용자가 이미 눈으로 보고 고른 결과이기 때문이다.
 *
 * 범위를 여러 개 받아 박스를 여러 개 그린다(조건 박스와 <보기> 박스가 한
 * 문제에 같이 나오는 경우). 범위 사이의 줄은 평범한 문단으로 둔다.
 */
function renderWithForcedBoxes(
  allLines: string[],
  ranges: BoxRange[],
  mathBlocks: string[],
  tables: string[],
): RenderedBlock[] {
  const lastLine = allLines.length - 1;
  const boxes = normalizeBoxRanges(
    ranges.map((r) => ({
      start: Math.max(0, Math.min(r.start, lastLine)),
      end: Math.max(0, Math.min(r.end, lastLine)),
    })),
  );

  if (boxes.length === 0) {
    return renderPlainRange(allLines, 0, lastLine, true, mathBlocks, tables);
  }

  const parts: RenderedBlock[] = [];
  let cursor = 0;
  // 문제번호를 굵게 처리하는 건 카드에서 맨 처음 나오는 문단 하나뿐이다.
  // 앞에 아무것도 안 그려졌을 때만 "첫 문단"이 유지된다.
  let isFirst = true;

  for (const box of boxes) {
    const before = renderPlainRange(
      allLines,
      cursor,
      box.start - 1,
      isFirst,
      mathBlocks,
      tables,
    );
    parts.push(...before);
    if (before.length > 0) isFirst = false;

    const boxBlock = renderBox(allLines, box, mathBlocks);
    if (boxBlock !== null) {
      parts.push(boxBlock);
      isFirst = false;
    }

    cursor = box.end + 1;
  }

  parts.push(
    ...renderPlainRange(allLines, cursor, lastLine, isFirst, mathBlocks, tables),
  );
  return parts;
}

/**
 * 블록의 모든 줄이 ">"로 시작하면(조건 박스 등) 테두리 박스로 렌더링한다.
 * ">"가 없어도 "(가)/(나)/(다)" 같은 조건 표지로 시작하는 줄이 있으면, 그
 * 표지가 처음 나온 줄부터 시작해 "마지막 표지가 달린 문장의 마침표"까지만
 * 박스로 묶는다(원본 문제집의 테두리 박스에 해당). 그 마침표 뒤에 같은 줄에
 * 이어 붙은 문장이나, 표지 앞/뒤의 다른 줄은 박스 밖 평범한 문단으로 둔다 —
 * 박스가 블록 끝까지 무조건 이어지지 않게 한다.
 *
 * 조건 문장의 마침표가 같은 블록(빈 줄로 구분된 문단) 안에 없으면 — 예를 들어
 * Mathpix가 "x=0에서 극대이고"와 그 다음 문장 "x=α, x=β에서 극소이다."를
 * 디스플레이 수식 때문에 서로 다른 문단으로 나눠 보내는 경우 — 박스가 그
 * 블록에서 그냥 끝나버리면 뒤 문장이 박스 밖으로 새어나간다. 그래서 다음
 * 블록이 순수 디스플레이 수식 플레이스홀더뿐이면(그 문장의 나머지일 가능성이
 * 높음) 박스를 "열어둔 채" 딱 한 블록만 더 넘어가 본다.
 *
 * 반대로 (가)/(나) 조건이 애초에 마침표 없는 순수 수식으로 끝나는 문제도
 * 있다(예: "(나) 2×sin(∠ECD)=3×sin(∠EDC)"). 이런 경우 다음 블록이 위 조건에
 * 안 맞으면(순수 수식 플레이스홀더가 아니라 "DF의 값은?" 같은 일반 본문이면)
 * 마침표를 찾겠다고 계속 뒤져서는 안 되므로 — 그러면 무관한 본문을 끝없이
 * 삼킬 수 있다 — 그 블록에서 바로 박스를 닫는다. 블록 경계를 넘는 것도
 * 한 번으로 제한한다(그 다음 블록에서도 마침표가 없으면 거기서 닫는다).
 */
export function renderMathText(input: string, boxOverride?: BoxOverride): string {
  return renderMathTextWithInfo(input, boxOverride).html;
}

/**
 * 렌더링 결과와 함께 "조건 박스를 어디에 쳤는지"를 돌려준다. 사용자가 박스
 * 범위를 손볼 수 있게 하려면 자동 감지 결과를 화면에 보여줘야 하는데, 그
 * 규칙이 이 함수 안에 있으므로 렌더링하면서 같이 알려주는 편이 확실하다
 * (같은 규칙을 UI 쪽에 한 번 더 구현하면 반드시 어긋난다).
 *
 * boxOverride를 주면 자동 감지를 아예 건너뛰고 지정한 범위만 박스로 만든다.
 * 빈 범위 목록은 "박스 없음"을 사용자가 명시한 경우다.
 */
export function renderMathTextWithInfo(
  input: string,
  boxOverride?: BoxOverride,
): { html: string; blocks: RenderedBlock[]; boxes: BoxRange[]; lines: string[] } {
  // 조합용 자모를 먼저 호환용으로 바꾼다. 1:1 치환이라 줄 수가 달라지지 않아
  // 박스 범위의 줄 번호에 영향을 주지 않는다.
  const normalized = normalizeDelimiters(normalizeJamo(input));
  const { text: withoutTables, tables } = protectTables(normalized);
  const { text, blocks: mathBlocks } = protectDisplayMath(withoutTables);
  const canonicalLines = text.split("\n");
  const blocks = toBlocks(canonicalLines);

  /** 최상위 요소(문단/박스/표) 하나씩. 도형·자료를 그 사이에 끼워 넣는다. */
  const finish = (raw: RenderedBlock[]) => {
    const restored: RenderedBlock[] = raw.map((part) => {
      // 표 블록은 이미 실제 <table> 마크업이라 되돌릴 토큰이 없다.
      if (part.kind === "table") return part;
      return part.kind === "plain"
        ? { kind: "plain", html: restoreTables(part.html, tables) }
        : { kind: "box", lines: part.lines.map((l) => restoreTables(l, tables)) };
    });
    return { html: restored.map(blockToHtml).join(""), blocks: restored };
  };

  // 사용자가 범위를 직접 정했으면 자동 감지 로직은 건드리지 않고 그대로 따른다.
  const forced = toBoxRanges(boxOverride);
  if (forced !== null) {
    return {
      ...finish(renderWithForcedBoxes(canonicalLines, forced, mathBlocks, tables)),
      boxes: forced,
      lines: canonicalLines,
    };
  }

  const parts: RenderedBlock[] = [];
  let isFirst = true;
  // 마침표를 못 찾아 아직 안 닫힌 박스의 줄들(여러 블록에 걸쳐 쌓인다). null이면
  // 현재 열린 박스가 없다는 뜻.
  let openBoxLines: string[] | null = null;
  // 열린 박스가 시작된 canonical 줄 번호(박스 범위를 알려주기 위해 기록한다).
  let openBoxStart = 0;
  /**
   * 자동으로 그린 박스를 전부 기록한다. 박스 범위 편집 UI가 이 목록을 그대로
   * 출발점으로 삼으므로, 실제로 그린 박스와 하나라도 어긋나면 안 된다.
   */
  const boxes: BoxRange[] = [];
  const recordBox = (start: number, end: number) => {
    if (end >= start) boxes.push({ start, end });
  };

  for (let bi = 0; bi < blocks.length; bi++) {
    const lines = blocks[bi].lines;
    const offset = blocks[bi].start;

    if (openBoxLines !== null) {
      let closeIdx = -1;
      let hardStopIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (QUESTION_OR_CHOICE_LINE.test(lines[i])) {
          hardStopIdx = i;
          break;
        }
        if (lineHasSentenceEnd(lines[i], mathBlocks)) {
          closeIdx = i;
          break;
        }
      }

      if (closeIdx === -1) {
        // 블록 경계를 넘어가는 건 한 번만 허용한다(그 이상은 무관한 본문까지
        // 삼킬 위험이 있다) — 여기서도 마침표를 못 찾으면 그냥 여기서 닫는다.
        // 실제 질문/선택지를 만났다면(hardStopIdx) 그 앞까지만 담는다.
        const stopAt = hardStopIdx !== -1 ? hardStopIdx : lines.length;
        openBoxLines.push(...lines.slice(0, stopAt));
        parts.push({ kind: "box", lines: renderLineList(openBoxLines, false, mathBlocks) });
        recordBox(openBoxStart, offset + stopAt - 1);
        openBoxLines = null;

        if (hardStopIdx !== -1) {
          const trailingLines = lines.slice(hardStopIdx);
          parts.push({
      kind: "plain",
      html: `<p class="mmd-paragraph">${renderLines(trailingLines, false, mathBlocks)}</p>`,
    });
        }
        isFirst = false;
        continue;
      }

      const { head, rest } = closeBoxAtLine(lines[closeIdx], mathBlocks);
      openBoxLines.push(...lines.slice(0, closeIdx), head);
      parts.push({ kind: "box", lines: renderLineList(openBoxLines, false, mathBlocks) });
      recordBox(openBoxStart, offset + closeIdx);
      openBoxLines = null;

      const trailingLines = [
        ...(rest !== null ? [rest] : []),
        ...lines.slice(closeIdx + 1),
      ];
      if (trailingLines.length > 0) {
        parts.push({
      kind: "plain",
      html: `<p class="mmd-paragraph">${renderLines(trailingLines, false, mathBlocks)}</p>`,
    });
      }
      isFirst = false;
      continue;
    }

    // "<table>"은 블록 레벨 요소라 "<p>"/"<span>" 안에 넣으면 브라우저가 HTML
    // 파싱 중 <p>를 강제로 닫아버려(스펙상 <table>은 <p> 안에 못 들어감) 뒤에
    // 오는 문장이 문단 스타일을 잃는 문제가 생긴다. 표 토큰이 있는 줄을 찾으면
    // 그 앞/뒤 줄만 각각 별도 문단으로 두고 표는 형제 요소로 내보낸다.
    const tableLineIdx = lines.findIndex((line) =>
      TABLE_PLACEHOLDER_ONLY.test(line.trim()),
    );
    if (tableLineIdx !== -1) {
      const tableMatch = lines[tableLineIdx].trim().match(TABLE_PLACEHOLDER_ONLY)!;
      const tableHtml = tables[Number(tableMatch[1])];
      const beforeLines = lines.slice(0, tableLineIdx);
      const afterLines = lines.slice(tableLineIdx + 1);

      if (beforeLines.length > 0) {
        parts.push({
      kind: "plain",
      html: `<p class="mmd-paragraph">${renderLines(beforeLines, isFirst, mathBlocks)}</p>`,
    });
      }
      parts.push({
        kind: "table",
        id: tableBlockId(Number(tableMatch[1])),
        html: tableHtml,
      });
      if (afterLines.length > 0) {
        parts.push({
      kind: "plain",
      html: `<p class="mmd-paragraph">${renderLines(afterLines, false, mathBlocks)}</p>`,
    });
      }
      isFirst = false;
      continue;
    }

    const isBoxedAll = lines.every((line) => /^\s*>/.test(line));
    if (isBoxedAll) {
      const content = lines.map((line) => line.replace(/^\s*>\s?/, ""));
      parts.push({ kind: "box", lines: renderLineList(content, false, mathBlocks) });
      recordBox(offset, offset + lines.length - 1);
      isFirst = false;
      continue;
    }

    const markerIndices = lines.reduce<number[]>((acc, line, i) => {
      if (CONDITION_MARKER.test(line)) acc.push(i);
      return acc;
    }, []);

    // "<보기>" 박스. 머리글 줄부터 마지막 ㄱ/ㄴ/ㄷ 항목 문장의 마침표까지 묶는다.
    // (가)/(나) 조건이 머리글보다 앞에 있으면 그건 그것대로 기존 규칙에
    // 맡기고 여기서는 손대지 않는다 — 안 그러면 조건이 박스 밖으로 새어나간다.
    const bogiIdx = lines.findIndex((line) => BOGI_HEADER.test(line));
    // Mathpix가 "<보기>" 다음에 빈 줄을 넣어 항목을 다른 문단으로 보내기도
    // 한다. 그러면 이 블록에는 머리글만 있으므로 다음 블록까지 이어서 본다.
    const hasItemHere =
      bogiIdx !== -1 &&
      lines.slice(bogiIdx + 1).some((line) => BOGI_ITEM.test(line));
    const nextBlock = blocks[bi + 1];
    const useNext =
      bogiIdx !== -1 &&
      !hasItemHere &&
      nextBlock !== undefined &&
      nextBlock.lines.some((line) => BOGI_ITEM.test(line));
    const firstMarkerIdx = markerIndices.length > 0 ? markerIndices[0] : -1;

    if (
      bogiIdx !== -1 &&
      // 항목이 하나도 없으면 머리글만 덩그러니 박스에 갇힌다. 그건 박스가 아니다.
      (hasItemHere || useNext) &&
      (firstMarkerIdx === -1 || firstMarkerIdx > bogiIdx)
    ) {
      const introLines = lines.slice(0, bogiIdx);
      if (introLines.length > 0) {
        parts.push({
          kind: "plain",
          html: `<p class="mmd-paragraph">${renderLines(introLines, isFirst, mathBlocks)}</p>`,
        });
        isFirst = false;
      }

      const startAbs = offset + bogiIdx;
      const rangeEnd = useNext
        ? nextBlock.start + nextBlock.lines.length - 1
        : offset + lines.length - 1;

      // 마지막 항목 줄을 찾는다. 실제 질문이나 선택지 줄을 만나면 거기서 멈춘다.
      let lastItem = -1;
      let hardStop = -1;
      for (let i = startAbs + 1; i <= rangeEnd; i++) {
        const line = canonicalLines[i];
        if (line.trim() === "") continue;
        if (BOGI_ITEM.test(line)) {
          lastItem = i;
          continue;
        }
        if (QUESTION_OR_CHOICE_LINE.test(line)) {
          hardStop = i;
          break;
        }
      }

      const limit = hardStop === -1 ? rangeEnd : hardStop - 1;
      let endAbs = startAbs;
      if (lastItem !== -1) {
        endAbs = lastItem;
        // 마지막 항목에 마침표가 없으면(수식 때문에 줄이 갈린 경우 등) 뒤에서
        // 첫 마침표를 찾아 거기까지 늘린다. 못 찾으면 항목 줄에서 끝낸다 —
        // 무작정 늘리면 뒤의 무관한 본문까지 삼킨다.
        if (!lineHasSentenceEnd(canonicalLines[lastItem], mathBlocks)) {
          for (let i = lastItem + 1; i <= limit; i++) {
            if (canonicalLines[i].trim() === "") continue;
            if (lineHasSentenceEnd(canonicalLines[i], mathBlocks)) {
              endAbs = i;
              break;
            }
          }
        }
      }

      const { head, rest } = closeBoxAtLine(canonicalLines[endAbs], mathBlocks);
      const boxLines = [
        ...canonicalLines.slice(startAbs, endAbs).filter((l) => l.trim() !== ""),
        head,
      ];
      parts.push({
        kind: "box",
        lines: renderLineList(boxLines, false, mathBlocks),
      });
      recordBox(startAbs, endAbs);

      const trailingLines = [
        ...(rest !== null ? [rest] : []),
        ...canonicalLines.slice(endAbs + 1, rangeEnd + 1),
      ].filter((l) => l.trim() !== "");
      if (trailingLines.length > 0) {
        parts.push({
          kind: "plain",
          html: `<p class="mmd-paragraph">${renderLines(trailingLines, false, mathBlocks)}</p>`,
        });
      }

      // 다음 블록까지 끌어 썼으면 그 블록은 여기서 소비된 것이다.
      if (useNext) bi++;
      isFirst = false;
      continue;
    }

    if (markerIndices.length > 0) {
      const firstIdx = markerIndices[0];
      const lastIdx = markerIndices[markerIndices.length - 1];

      let closeIdx = -1;
      let hardStopIdx = -1;
      for (let i = lastIdx; i < lines.length; i++) {
        if (QUESTION_OR_CHOICE_LINE.test(lines[i])) {
          hardStopIdx = i;
          break;
        }
        if (lineHasSentenceEnd(lines[i], mathBlocks)) {
          closeIdx = i;
          break;
        }
      }

      const introLines = lines.slice(0, firstIdx);
      if (introLines.length > 0) {
        parts.push({
      kind: "plain",
      html: `<p class="mmd-paragraph">${renderLines(introLines, isFirst, mathBlocks)}</p>`,
    });
      }

      if (closeIdx === -1) {
        // 이 블록 안에서 조건 문장이 끝나지 않았다. 실제 질문("DF의 값은?")이나
        // 선택지(①~⑤, (1)~(5))를 만났다면(hardStopIdx) 그 앞에서 바로 닫는다
        // — (가)/(나)가 마침표 없는 순수 수식으로 끝나는 문제가 이 경우다.
        // 그런 벽을 안 만났고 블록이 그냥 끝난 것뿐이라면, 바로 다음 블록이
        // 순수 디스플레이 수식 플레이스홀더뿐일 때만(예: "(나)...이고" 다음에
        // 오는 "$$x=\alpha,...$$") 그 문장의 나머지일 가능성이 높으니 박스를
        // 열어둔 채 딱 한 블록만 더 넘어가 본다.
        if (hardStopIdx === -1) {
          const nextBlock = blocks[bi + 1];
          if (
            nextBlock !== undefined &&
            isPureMathPlaceholderBlock(nextBlock.lines.join("\n"))
          ) {
            openBoxLines = lines.slice(firstIdx);
            openBoxStart = offset + firstIdx;
            isFirst = false;
            continue;
          }
        }

        const stopAt = hardStopIdx !== -1 ? hardStopIdx : lines.length;
        const conditionLines = lines.slice(firstIdx, stopAt);
        parts.push({ kind: "box", lines: renderLineList(conditionLines, false, mathBlocks) });
        recordBox(offset + firstIdx, offset + stopAt - 1);

        if (hardStopIdx !== -1) {
          const trailingLines = lines.slice(hardStopIdx);
          parts.push({
      kind: "plain",
      html: `<p class="mmd-paragraph">${renderLines(trailingLines, false, mathBlocks)}</p>`,
    });
        }
        isFirst = false;
        continue;
      }

      const { head, rest } = closeBoxAtLine(lines[closeIdx], mathBlocks);
      const conditionLines = [...lines.slice(firstIdx, closeIdx), head];
      parts.push({ kind: "box", lines: renderLineList(conditionLines, false, mathBlocks) });
      recordBox(offset + firstIdx, offset + closeIdx);

      const trailingLines = [
        ...(rest !== null ? [rest] : []),
        ...lines.slice(closeIdx + 1),
      ];
      if (trailingLines.length > 0) {
        parts.push({
      kind: "plain",
      html: `<p class="mmd-paragraph">${renderLines(trailingLines, false, mathBlocks)}</p>`,
    });
      }
      isFirst = false;
      continue;
    }

    parts.push({
      kind: "plain",
      html: `<p class="mmd-paragraph">${renderLines(lines, isFirst, mathBlocks)}</p>`,
    });
    isFirst = false;
  }

  // 마지막까지 마침표를 못 찾은 채 끝나면(원본에 마침표가 없는 등) 남은 줄을
  // 그대로 박스로 닫아 최소한 내용이 사라지지 않게 한다.
  if (openBoxLines !== null) {
    parts.push({ kind: "box", lines: renderLineList(openBoxLines, false, mathBlocks) });
    recordBox(openBoxStart, canonicalLines.length - 1);
  }

  return {
    ...finish(parts),
    boxes: normalizeBoxRanges(boxes),
    lines: canonicalLines,
  };
}
