import katex from "katex";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function textToHtml(str: string): string {
  return escapeHtml(str).replace(/\n/g, "<br />");
}

function renderMath(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex, {
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

const LOOKS_LIKE_BARE_LATEX = /\\[a-zA-Z]+/;

/**
 * Mathpix의 mmd(마크다운+수식) 형식 텍스트를 안전한 HTML로 변환한다.
 * "$$...$$"는 블록 수식, "$...$"는 인라인 수식으로, 나머지는 일반 텍스트로 렌더링한다.
 * 델리미터가 전혀 없는데 LaTeX 명령어(백슬래시)만 있는 경우(예: latex_styled를
 * 그대로 받은 경우)는 전체를 블록 수식 하나로 간주해 렌더링한다.
 */
export function renderMathText(input: string): string {
  const normalized = normalizeDelimiters(input);

  if (!normalized.includes("$") && LOOKS_LIKE_BARE_LATEX.test(normalized)) {
    return renderMath(normalized.trim(), true);
  }

  const pattern = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;

  let lastIndex = 0;
  let html = "";
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(normalized)) !== null) {
    const plain = normalized.slice(lastIndex, match.index);
    html += textToHtml(plain);

    if (match[1] !== undefined) {
      html += renderMath(match[1].trim(), true);
    } else if (match[2] !== undefined) {
      html += renderMath(match[2].trim(), false);
    }

    lastIndex = pattern.lastIndex;
  }

  html += textToHtml(normalized.slice(lastIndex));

  return html;
}
