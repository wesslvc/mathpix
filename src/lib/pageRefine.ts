"use client";

// **지면 자르기를 문제마다 확대해 한 번 더 맞춘다**(2026-10-09, 사용자 — "지면 짜르기의 경우는 여전히 정확하지 않네").
//
// 지면 영역 찾기(luna)는 지면 **한 장 전체**를 보고 문제 열 몇 개의 자리를 한꺼번에 준다. 비전 모델은 그림을 짧은 변 768px
// 쯤으로 줄여 보므로 문제 하나가 그 안에서 몇십 px 이고, 테두리가 한두 줄씩 어긋난다(끝 선지·번호가 잘리거나 이웃 줄이
// 딸려 온다). 글자에 맞추는 `snapBoxes` 는 "그 줄이 이 문제 것인지"를 모른다.
//
// 그래서 **쪼개서 동시에** 다시 본다: 문제마다 그 둘레를 원본에서 크게 오려(이웃이 조금 걸치게) 자동 자르기(`crop` 작업,
// 번호·선지 다섯 개를 스스로 확인하는 그 프롬프트)에 "이 번호, 대략 이 자리의 문제"라고 표적을 주고 묻는다. 곧바로 부르는
// luna 일이라 문제 열 몇 개가 한꺼번에 돈다(토큰 0, 원가는 장부 `luna 자동 자르기`).
//
// **어긋난 답은 버린다** — 원래 자리와 절반 넘게 겹치고 크기가 터무니없지 않을 때만 받는다(이웃 문제를 짚었으면 원래대로).
// 단을 넘어 이어 붙인 문제(조각 둘 이상)는 손대지 않는다(이어지는 조각에는 번호가 없어 표적을 줄 수 없다).

import { cropImageToDataUrl } from "./cropImage";
import { enhanceContrast } from "./autoContrast";
import { runAiTask } from "./aiTask";
import type { DetectedProblem } from "./detectProblems";
import type { ProblemBox } from "./problemBoxes";

/** 확대 창: 문제 둘레로 지면 대비 이만큼 더 오린다(이웃 줄이 걸쳐야 어디서 끊을지 보인다). */
const WIN_MX = 0.03;
const WIN_MY = 0.05;
/** 보낼 그림의 긴 변(자동 자르기와 같다). */
const WIN_DIM = 2048;

type KeepBox = ProblemBox & { keep?: ProblemBox[] };

export type RefineWindow = { index: number; win: ProblemBox; image: string; hint: ProblemBox; no?: string };

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** 문제마다 확대 창을 오린다. **원본이 열려 있는 동안** 부른다(오린 뒤에는 닫아도 된다). */
export function cutRefineWindows(
  img: CanvasImageSource,
  width: number,
  height: number,
  problems: DetectedProblem[],
): RefineWindow[] {
  const out: RefineWindow[] = [];
  problems.forEach((p, index) => {
    if (p.boxes.length !== 1) return;
    const b = p.boxes[0];
    const x0 = clamp01(b.x - WIN_MX);
    const y0 = clamp01(b.y - WIN_MY);
    const x1 = clamp01(b.x + b.w + WIN_MX);
    const y1 = clamp01(b.y + b.h + WIN_MY);
    const win = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    if (win.w <= 0 || win.h <= 0) return;
    const image = cropImageToDataUrl(
      img,
      { x: Math.round(x0 * width), y: Math.round(y0 * height), width: Math.round(win.w * width), height: Math.round(win.h * height) },
      { maxWidth: WIN_DIM, maxHeight: WIN_DIM },
    );
    const hint = { x: (b.x - x0) / win.w, y: (b.y - y0) / win.h, w: b.w / win.w, h: b.h / win.h };
    out.push({ index, win, image, hint, no: p.no });
  });
  return out;
}

function area(b: ProblemBox) {
  return Math.max(0, b.w) * Math.max(0, b.h);
}
function overlap(a: ProblemBox, b: ProblemBox) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** 창 안 자리(0~1) → 지면 자리. */
function toPage(r: ProblemBox, win: ProblemBox): ProblemBox {
  return { x: win.x + r.x * win.w, y: win.y + r.y * win.h, w: r.w * win.w, h: r.h * win.h };
}

/** 다시 본 자리를 받을지. 이웃 문제를 짚었거나 터무니없이 커지면 원래대로 둔다. */
export function acceptRefined(orig: ProblemBox, next: ProblemBox): boolean {
  const a = area(orig);
  if (a <= 0) return false;
  return overlap(orig, next) / a >= 0.55 && area(next) <= a * 2.2 && area(next) >= a * 0.4;
}

/** 창마다 luna 에게 동시에 묻고, 받을 만한 것만 갈아 끼운다. 하나가 실패해도 나머지는 그대로 간다. */
export async function refineProblems(
  problems: DetectedProblem[],
  windows: RefineWindow[],
  label: string,
): Promise<{ problems: DetectedProblem[]; refined: number }> {
  const next = problems.map((p) => ({ ...p, boxes: [...p.boxes] }));
  let refined = 0;
  await Promise.all(
    windows.map(async (w) => {
      try {
        const image = await enhanceContrast(w.image);
        const { result } = await runAiTask<{ box?: KeepBox | null; number?: string }>("crop", {
          label: `${label} · ${w.no ? `${w.no}번` : `${w.index + 1}번째`} 다시 맞추기`,
          images: [image],
          params: { target: { box: w.hint, ...(w.no ? { number: w.no } : {}) } },
        });
        const r = result.box;
        if (!r) return;
        const box: KeepBox & { refined?: boolean } = { ...toPage(r, w.win), refined: true };
        if (Array.isArray(r.keep)) box.keep = r.keep.map((k) => toPage(k, w.win));
        const orig = problems[w.index].boxes[0];
        if (!acceptRefined(orig, box)) return;
        next[w.index].boxes[0] = box;
        if (!next[w.index].no && result.number) {
          const n = /(\d{1,3})/.exec(result.number)?.[1];
          if (n) next[w.index].no = n;
        }
        refined++;
      } catch {
        // 못 다시 보면 원래 자리 그대로.
      }
    }),
  );
  return { problems: next, refined };
}
