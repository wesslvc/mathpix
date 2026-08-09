import { toPng } from "html-to-image";
import { PROBLEM_CARD_WIDTH } from "./layout";
import { cardHtmlFromSpec, type CardSpec } from "./cardHtml";

/**
 * 화면에 없는 문제 카드를 그려 PNG로 만든다.
 *
 * AI 그림이 완성됐을 때, 그 문제 화면은 이미 닫혀 있고 사용자는 다음 문제를
 * 만지고 있을 수 있다. 그래도 저장된 이미지는 완성된 그림으로 갱신돼야 하므로
 * 눈에 안 보이는 곳에 카드를 똑같이 한 번 그려서 캡처한다.
 *
 * 화면 밖으로 밀어내되 `display:none`이나 `visibility:hidden`은 쓰지 않는다 —
 * 그러면 레이아웃이 계산되지 않아 캡처가 비거나 크기가 0이 된다. 눈에 띄지
 * 않게 하려고 아래 z-index와 pointer-events만 죽여 둔다.
 */
export async function renderCardOffscreen(spec: CardSpec): Promise<string> {
  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.left = "-100000px";
  host.style.top = "0";
  host.style.zIndex = "-1";
  host.style.pointerEvents = "none";

  const card = document.createElement("div");
  card.className =
    "problem-surface rounded-2xl border border-slate-200 bg-white p-8 shadow-sm";
  card.style.width = `${PROBLEM_CARD_WIDTH}px`;

  const content = document.createElement("div");
  content.className = "font-serif leading-relaxed text-ink";
  content.style.fontSize = `${spec.fontSizePx}px`;
  content.innerHTML = cardHtmlFromSpec(spec);

  card.appendChild(content);
  host.appendChild(card);
  document.body.appendChild(host);

  try {
    if (document.fonts?.ready) {
      await Promise.race([
        document.fonts.ready,
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    }
    // 붙인 이미지(그림)가 실제로 그려질 때까지 한 번 기다린다.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    return await toPng(card, { pixelRatio: 2, backgroundColor: "#ffffff" });
  } finally {
    host.remove();
  }
}
