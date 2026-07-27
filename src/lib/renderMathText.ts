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
// 기준으로 나누는 로직이 "$$...$$" 하나를 여러 조각으로 쪽개버려 LaTeX 원문이
// 그대로 글자로 노출되는 문제가 있었다. 문단/줄 분리를 하기 전에 "$$...$$"
// 전체를 플레이스홀더 토큰(줄바꿈 없는 한 덝어리)으로 바꿔 보호했다가,
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

/**
 * 블록의 모든 줄이 ">"로 시작하면(조건 박스 등) 테두리 박스로 렌더링한다.
 * ">"가 없어도 "(가)/(나)/(다)" 같은 조건 표지로 시작하는 줄이 있으면, 그
 * 표지가 처음 나온 줄부터 블록 끝까지를 박스로 묶고(원본 문제집의 테두리
 * 박스에 해당) 그 앞의 문장(예: "30. ... 만족시킨다.")은 평범한 문단으로 둔다.
 */
function renderBlock(
  block: string,
  isFirst: boolean,
  mathBlocks: string[],
): string {
  const lines = block.split("\n");
  const isBoxed = lines.every((line) => /^\s*>/.test(line));

  if (isBoxed) {
    const content = lines.map((line) => line.replace(/^\s*>\s?/, ""));
    return `<div class="mmd-box">${renderLines(content, false, mathBlocks)}</div>`;
  }

  const markerIdx = lines.findIndex((line) => CONDITION_MARKER.test(line));
  if (markerIdx > -1) {
    const introLines = lines.slice(0, markerIdx);
    const conditionLines = lines.slice(markerIdx);
    const introHtml =
      introLines.length > 0
        ? `<p class="mmd-paragraph">${renderLines(introLines, isFirst, mathBlocks)}</p>`
        : "";
    return (
      introHtml +
      `<div class="mmd-box">${renderLines(conditionLines, false, mathBlocks)}</div>`
    );
  }

  return `<p class="mmd-paragraph">${renderLines(lines, isFirst, mathBlocks)}</p>`;
}

/**
 * Mathpix의 mmd(마크다운+수식) 형식 텍스트를 안전한 HTML로 변환한다.
 * 빈 줄로 구분된 블록마다 문단으로 나누고, ">"로 시작하는 블록은 테두리 박스로,
 * 첫 블록 맨 앞의 "21." 같은 문제 번호는 굵게 강조해 실제 문제집처럼 보이게 한다.
 * "$"가 없어도 순수 수식(예: x^2 + 3x - 1 = 0)으로 보이면 통째로 렌더링한다.
 */
export function renderMathText(input: string): string {
  const normalized = normalizeDelimiters(input);
  const { text, blocks: mathBlocks } = protectDisplayMath(normalized);
  const blocks = text.trim().split(/\n\s*\n+/);

  return blocks
    .map((block, idx) => renderBlock(block, idx === 0, mathBlocks))
    .join("");
}
