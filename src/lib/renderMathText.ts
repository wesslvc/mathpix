import katex from "katex";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
    html += escapeHtml(token).replace(/\n/g, "<br />");
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
const TABULAR_PATTERN = /\\begin\{tabular\}\{[^}]*\}([\s\S]*?)\\end\{tabular\}/g;

function tabularToTableHtml(body: string): string {
  const rows = body
    .split(/\\\\/)
    .map((row) => row.replace(/\\hline/g, "").trim())
    .filter((row) => row.length > 0);

  const rowsHtml = rows
    .map((row, i) => {
      const cells = row.split("&").map((cell) => cell.trim());
      const tag = i === 0 ? "th" : "td";
      const cellsHtml = cells
        .map((cell) => `<${tag}>${renderInline(cell)}</${tag}>`)
        .join("");
      return `<tr>${cellsHtml}</tr>`;
    })
    .join("");

  return `<table class="mmd-table">${rowsHtml}</table>`;
}

function protectTabular(input: string): { text: string; tables: string[] } {
  const tables: string[] = [];
  const text = input.replace(TABULAR_PATTERN, (_match, body: string) => {
    const token = `\x00TABLE${tables.length}\x00`;
    tables.push(tabularToTableHtml(body));
    return token;
  });
  return { text, tables };
}

const TABLE_PLACEHOLDER_ONLY = /^\x00TABLE(\d+)\x00$/;
const TABLE_PLACEHOLDER = /\x00TABLE(\d+)\x00/g;

function restoreTables(html: string, tables: string[]): string {
  if (tables.length === 0) return html;
  return html.replace(TABLE_PLACEHOLDER, (_, i) => tables[Number(i)]);
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
 * 블록 안의 각 줄을 "이미 줄바꿈된" 단위로 보고 한 줄씩 렌더링한다.
 * 원본에 줄바꿈이 있던 자리에만 여백(.mmd-line)을 줘서 위아래 수식이 너무
 * 붙지 않게 하고, 한 줄 안의 띄어쓰기는 그대로 둔다(새 줄바꿈을 만들지 않음).
 */
function renderLines(
  lines: string[],
  firstLineHasNumber: boolean,
  mathBlocks: string[],
): string {
  return lines
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
      } else {
        inner = renderLineContent(line, mathBlocks);
      }
      return `<span class="mmd-line">${inner}</span>`;
    })
    .join("");
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
  const match = line.match(SENTENCE_END);
  if (!match || match.index === undefined) {
    return { head: line, rest: null };
  }
  const cut = match.index + 1;
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
  return SENTENCE_END.test(restoreDisplayMath(line, mathBlocks));
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
  if (SENTENCE_END.test(line)) {
    return splitAtSentenceEnd(line);
  }
  return { head: line, rest: null };
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
export function renderMathText(input: string): string {
  const normalized = normalizeDelimiters(input);
  const { text: withoutTables, tables } = protectTabular(normalized);
  const { text, blocks: mathBlocks } = protectDisplayMath(withoutTables);
  const blocks = text.trim().split(/\n\s*\n+/);

  let html = "";
  let isFirst = true;
  // 마침표를 못 찾아 아직 안 닫힌 박스의 줄들(여러 블록에 걸쳐 쌓인다). null이면
  // 현재 열린 박스가 없다는 뜻.
  let openBoxLines: string[] | null = null;

  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    const lines = block.split("\n");

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
        html += `<div class="mmd-box">${renderLines(openBoxLines, false, mathBlocks)}</div>`;
        openBoxLines = null;

        if (hardStopIdx !== -1) {
          const trailingLines = lines.slice(hardStopIdx);
          html += `<p class="mmd-paragraph">${renderLines(trailingLines, false, mathBlocks)}</p>`;
        }
        isFirst = false;
        continue;
      }

      const { head, rest } = closeBoxAtLine(lines[closeIdx], mathBlocks);
      openBoxLines.push(...lines.slice(0, closeIdx), head);
      html += `<div class="mmd-box">${renderLines(openBoxLines, false, mathBlocks)}</div>`;
      openBoxLines = null;

      const trailingLines = [
        ...(rest !== null ? [rest] : []),
        ...lines.slice(closeIdx + 1),
      ];
      if (trailingLines.length > 0) {
        html += `<p class="mmd-paragraph">${renderLines(trailingLines, false, mathBlocks)}</p>`;
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
        html += `<p class="mmd-paragraph">${renderLines(beforeLines, isFirst, mathBlocks)}</p>`;
      }
      html += tableHtml;
      if (afterLines.length > 0) {
        html += `<p class="mmd-paragraph">${renderLines(afterLines, false, mathBlocks)}</p>`;
      }
      isFirst = false;
      continue;
    }

    const isBoxedAll = lines.every((line) => /^\s*>/.test(line));
    if (isBoxedAll) {
      const content = lines.map((line) => line.replace(/^\s*>\s?/, ""));
      html += `<div class="mmd-box">${renderLines(content, false, mathBlocks)}</div>`;
      isFirst = false;
      continue;
    }

    const markerIndices = lines.reduce<number[]>((acc, line, i) => {
      if (CONDITION_MARKER.test(line)) acc.push(i);
      return acc;
    }, []);

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
        html += `<p class="mmd-paragraph">${renderLines(introLines, isFirst, mathBlocks)}</p>`;
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
          if (nextBlock !== undefined && isPureMathPlaceholderBlock(nextBlock)) {
            openBoxLines = lines.slice(firstIdx);
            isFirst = false;
            continue;
          }
        }

        const stopAt = hardStopIdx !== -1 ? hardStopIdx : lines.length;
        const conditionLines = lines.slice(firstIdx, stopAt);
        html += `<div class="mmd-box">${renderLines(conditionLines, false, mathBlocks)}</div>`;

        if (hardStopIdx !== -1) {
          const trailingLines = lines.slice(hardStopIdx);
          html += `<p class="mmd-paragraph">${renderLines(trailingLines, false, mathBlocks)}</p>`;
        }
        isFirst = false;
        continue;
      }

      const { head, rest } = closeBoxAtLine(lines[closeIdx], mathBlocks);
      const conditionLines = [...lines.slice(firstIdx, closeIdx), head];
      html += `<div class="mmd-box">${renderLines(conditionLines, false, mathBlocks)}</div>`;

      const trailingLines = [
        ...(rest !== null ? [rest] : []),
        ...lines.slice(closeIdx + 1),
      ];
      if (trailingLines.length > 0) {
        html += `<p class="mmd-paragraph">${renderLines(trailingLines, false, mathBlocks)}</p>`;
      }
      isFirst = false;
      continue;
    }

    html += `<p class="mmd-paragraph">${renderLines(lines, isFirst, mathBlocks)}</p>`;
    isFirst = false;
  }

  // 마지막까지 마침표를 못 찾은 채 끝나면(원본에 마침표가 없는 등) 남은 줄을
  // 그대로 박스로 닫아 최소한 내용이 사라지지 않게 한다.
  if (openBoxLines !== null) {
    html += `<div class="mmd-box">${renderLines(openBoxLines, false, mathBlocks)}</div>`;
  }

  return restoreTables(html, tables);
}
