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

/**
 * Mathpix의 mmd(마크다운+수식) 형식 텍스트를 안전한 HTML로 변환한다.
 * "$$...$$"는 블록 수식, "$...$"는 인라인 수식으로, 나머지는 일반 텍스트로 렌더링한다.
 */
export function renderMathText(input: string): string {
  const pattern = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;

  let lastIndex = 0;
  let html = "";
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(input)) !== null) {
    const plain = input.slice(lastIndex, match.index);
    html += textToHtml(plain);

    if (match[1] !== undefined) {
      html += renderMath(match[1].trim(), true);
    } else if (match[2] !== undefined) {
      html += renderMath(match[2].trim(), false);
    }

    lastIndex = pattern.lastIndex;
  }

  html += textToHtml(input.slice(lastIndex));

  return html;
}
