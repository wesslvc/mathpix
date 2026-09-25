import { loadImage } from "./cropImage";
import { ensureDataUrl } from "./figureImage";
import {
  applyMarksReview,
  describeMarksReview,
  reviewParagraphs,
  type MarksReviewPara,
} from "./kice/marksReview";
import type { RichBlock } from "./kice/richText";

/**
 * **서식 검수**를 부른다(브라우저 쪽, 두 번째 호출 — `marksReview.ts` 주석 참고).
 *
 * 국어 모드·수정 화면의 다시 인식하기·비교 화면이 이 파일 하나를 쓴다 — 셋이
 * 다르게 자르면 같은 지문이 넣을 때와 고칠 때 다르게 나온다.
 */

/**
 * 띠 하나의 높이 = 폭 × 이 값. **짧게** 자른다(2026-09-25, 밑줄 길이를 정확히 보려고).
 * 비전 모델은 사진을 2048 안에 넣은 뒤 **짧은 변을 768 로** 맞춰 본다(`detail:high`).
 * 띠가 짧을수록 그 768 이 글자 줄 몇 개에만 쓰이므로, 우리가 미리 키워 보내면
 * 글자와 밑줄 끝점이 실제로 크게 보인다(`STRIP_ZOOM`).
 */
const STRIP_ASPECT = 0.4;
/** 띠끼리 겹치는 비율 — 경계에 걸친 밑줄·원문자를 한쪽에서는 온전히 보게. */
const STRIP_OVERLAP = 0.15;
const MAX_STRIPS = 9;
/** 띠를 키우는 상한. 짧은 변이 768, 긴 변이 2048 을 넘지 않는 데까지만 키운다. */
const STRIP_ZOOM = 2;
/** 요청 본문 상한(Vercel 4.5MB)보다 넉넉히 아래. */
const BODY_BUDGET = 3_900_000;

function toJpeg(img: HTMLImageElement, sx: number, sy: number, sw: number, sh: number, scale: number, q: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("캔버스를 만들 수 없습니다.");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", q);
}

/**
 * 지문 사진을 **전체 한 장(작게) + 가로 띠 여러 장(확대)** 으로 자른다.
 * 전체 사진은 어느 띠가 어디인지 알게 하려는 것이라 작아도 된다 — 확대는 띠가 한다.
 */
export async function passageStrips(crop: string): Promise<{ overview: string; strips: string[] }> {
  const img = await loadImage(await ensureDataUrl(crop));
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  let stripH = Math.round(W * STRIP_ASPECT);
  const step = () => Math.round(stripH * (1 - STRIP_OVERLAP));
  // 띠가 너무 많아지면 띠를 키운다(요청이 커지고 시간이 는다).
  while (Math.ceil(Math.max(0, H - stripH) / step()) + 1 > MAX_STRIPS) stripH = Math.round(stripH * 1.15);
  stripH = Math.min(stripH, H);
  // 모델이 다시 줄이지 않는 데까지만 키운다 — 넘치게 키우면 도로 줄어 헛수고다.
  const zoom = Math.max(1, Math.min(STRIP_ZOOM, 768 / stripH, 2048 / W));

  const cut = (scale: number, q: number) => {
    const strips: string[] = [];
    for (let y = 0; ; y += step()) {
      const top = Math.min(y, Math.max(0, H - stripH));
      strips.push(toJpeg(img, 0, top, W, Math.min(stripH, H - top), scale, q));
      if (top + stripH >= H) break;
    }
    return strips;
  };
  const overview = (q: number) => toJpeg(img, 0, 0, W, H, Math.min(1, 1200 / Math.max(W, H)), q);

  for (const [scale, q] of [
    [zoom, 0.88],
    [zoom, 0.78],
    [Math.max(1, zoom * 0.8), 0.75],
    [1, 0.75],
  ] as const) {
    const ov = overview(Math.min(q, 0.8));
    const strips = cut(scale, q);
    const size = ov.length + strips.reduce((n, x) => n + x.length, 0);
    if (size <= BODY_BUDGET) return { overview: ov, strips };
  }
  // 그래도 크면 띠를 줄여 보낸다 — 검수를 통째로 못 하는 것보다 낫다.
  return { overview: overview(0.7), strips: cut(Math.min(1, 1024 / W), 0.7) };
}

export type MarksReviewResult = {
  blocks: RichBlock[];
  /** 화면에 보여 줄 한 줄. */
  note: string;
  ok: boolean;
  /** 검수 결과 그대로 — 그림을 붙인 뒤의 블록에 다시 입힐 때 쓴다(문단 번호는 그림과 무관하다). */
  review?: MarksReviewPara[];
  chargedTokens?: number;
  costKrw?: number;
  model?: string;
};

/**
 * 첫 번째 호출이 읽은 블록에 서식 검수를 붙인다. **실패하면 첫 결과를 그대로**
 * 돌려준다 — 검수가 안 됐다고 지문을 버릴 이유가 없다.
 */
export async function reviewPassageMarks(crop: string, blocks: RichBlock[]): Promise<MarksReviewResult> {
  const paragraphs = reviewParagraphs(blocks);
  if (paragraphs.length === 0) return { blocks, note: "", ok: false };
  let strips: { overview: string; strips: string[] };
  try {
    strips = await passageStrips(crop);
  } catch (err) {
    return { blocks, note: `서식 검수 실패 — 사진을 자르지 못했습니다 (${String(err)})`, ok: false };
  }
  // **서식 검수는 빠지면 안 된다**(사용자 — "서식 검수를 무조건 넣고"). 한 번 실패하면
  // 한 번 더 걸어 본다. 402(토큰 부족)·400 은 다시 해도 같으므로 바로 멈춘다.
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch("/api/korean-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "marks", image: strips.overview, strips: strips.strips, paragraphs }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        review?: MarksReviewPara[];
        error?: string;
        chargedTokens?: number | null;
        usage?: { estKrw?: number };
        model?: string;
      };
      if (!res.ok || !Array.isArray(json.review)) {
        lastError = json.error ?? `HTTP ${res.status}`;
        if (res.status === 400 || res.status === 401 || res.status === 402) break;
        continue;
      }
      const applied = applyMarksReview(blocks, json.review);
      return {
        blocks: applied.blocks,
        note: describeMarksReview(applied.stats),
        ok: true,
        review: json.review,
        chargedTokens: typeof json.chargedTokens === "number" ? json.chargedTokens : undefined,
        costKrw: json.usage?.estKrw,
        model: json.model,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    blocks,
    note: `서식 검수 실패 — 첫 결과의 서식을 씁니다 (${lastError})`,
    ok: false,
  };
}
