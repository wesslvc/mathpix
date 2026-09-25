import { createClient } from "@/lib/supabase/client";
import { rasterToSvg } from "@/lib/figureImage";
import { renderCardOffscreen } from "@/lib/renderCardOffscreen";
import { toStoredFigures, type StoredBoxRange } from "@/lib/storedFigures";
import type { CardFigure } from "@/lib/cardHtml";
import { DEFAULT_FONT_PT, ptToPx } from "@/lib/fontSize";
import type { DiagramLayout } from "@/lib/diagramLayout";
import { enhanceContrast } from "@/lib/autoContrast";
import { parseProblemNumber } from "@/lib/problemNumber";
import type { AnswerByNumber, AnswerEntry } from "@/lib/answerMap";

/**
 * **그림 한 장이 곧 문제**인 것(통째로 다시 그리기 · 원본 그대로 넣기)을 화면
 * 없이 저장하는 데 필요한 것들. 사진 넣기(AddProblemFlow)와 지면 통째로 넣기
 * (BatchSplitPanel)가 같이 쓴다 — 둘이 따로 만들면 반드시 어긋난다.
 * 브라우저 전용이다(카드를 그리고 대비를 올리는 데 캔버스를 쓴다).
 */

/** 카드를 꽉 채우고 위 여백을 두지 않는다 — 이 그림 한 장이 곧 문제다. */
export const WHOLE_PROBLEM_LAYOUT: DiagramLayout = { scale: 100, offsetX: 0, offsetY: 0 };

/**
 * 크롭 한 장으로 카드 PNG 와 저장할 box_range 를 만든다(결과 화면 없이).
 * 본문은 비워 둔다 — 본문이 있으면 "수정" 화면이 본문으로 카드를 다시 그려
 * 그림이 사라진다(storedFigures.ts 주석 참고).
 */
export async function wholeProblemCard(
  id: string,
  crop: string,
): Promise<{ pngDataUrl: string; boxRange: StoredBoxRange }> {
  const figure: CardFigure = {
    id,
    markup: await rasterToSvg(crop),
    layout: WHOLE_PROBLEM_LAYOUT,
    position: 0,
  };
  const pngDataUrl = await renderCardOffscreen({
    text: "",
    boxOverride: undefined,
    fontSizePx: ptToPx(DEFAULT_FONT_PT),
    figures: [figure],
  });
  return {
    pngDataUrl,
    boxRange: { ranges: null, fontPt: DEFAULT_FONT_PT, figures: toStoredFigures([figure]) },
  };
}

/**
 * 크롭 한 장을 Mathpix 에 보내 **문제 번호만** 얻는다. 본문은 쓰지 않는다(위 참고).
 * **실패해도 던지지 않는다.** 번호가 없을 뿐 저장은 되어야 한다.
 */
export async function readNumberWithMathpix(crop: string): Promise<number | null> {
  try {
    const res = await fetch("/api/mathpix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 인식에 보낼 때만 대비를 올린다(화면에 남는 원본은 그대로 둔다).
      body: JSON.stringify({ image: await enhanceContrast(crop) }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { text?: string; latex?: string };
    return parseProblemNumber(json.text || json.latex || "");
  } catch {
    return null;
  }
}

/**
 * 저장된 행에 번호와 (그 번호의) 정답을 붙인다. box_range 를 통째로 내려받지
 * 않고 서버 함수가 합친다(`set_problem_numbers` · `apply_answer_key`).
 * 붙인 정답을 돌려준다(없으면 null).
 */
export async function attachNumberAndAnswer(
  problemId: string,
  number: number,
  answers: AnswerByNumber,
): Promise<AnswerEntry | null> {
  const supabase = createClient();
  const { error } = await supabase.rpc("set_problem_numbers", {
    p_updates: [{ id: problemId, number }],
  });
  if (error) throw error;
  const entry = answers[number];
  if (!entry) return null;
  const { error: ansErr } = await supabase.rpc("apply_answer_key", {
    p_updates: [{ id: problemId, answer: entry.answer, ...(entry.points ? { points: entry.points } : {}) }],
  });
  if (ansErr) throw ansErr;
  return entry;
}
