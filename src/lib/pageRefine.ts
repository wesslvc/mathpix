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
import { inkMapFromImage, snapBoxes, type InkMap } from "./snapBoxes";

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
  // 겹침은 **둘 중 작은 쪽** 기준이다 — 넉넉하게 잡는 모델(원래 자리가 진짜의 2배)은 알맞게 줄인 자리가 원래의 55% 에도 못 미쳐, 예전처럼
  // 원래 자리 기준이면 좋은 다시 보기가 통째로 버려졌다. 줄어든 아랫부분은 `restoreBottom` 이 잉크로 되살린다.
  const an = area(next);
  return an > 0 && overlap(orig, next) / Math.min(a, an) >= 0.7 && an <= a * 2.2 && an >= a * 0.3;
}

/** 창마다 luna 에게 동시에 묻고, 받을 만한 것만 갈아 끼운다. 하나가 실패해도 나머지는 그대로 간다. */
export async function refineProblems(
  problems: DetectedProblem[],
  windows: RefineWindow[],
  label: string,
  /** 다시 맞추기 추론 강도(low|medium|high). 없으면 서버 기본(`OPENAI_REFINE_EFFORT`, medium). */
  effort?: string,
): Promise<{ problems: DetectedProblem[]; refined: number; krw: number }> {
  const next = problems.map((p) => ({ ...p, boxes: [...p.boxes] }));
  let refined = 0;
  let krw = 0;
  await Promise.all(
    windows.map(async (w) => {
      try {
        const image = await enhanceContrast(w.image);
        const { result } = await runAiTask<{ box?: KeepBox | null; number?: string; estKrw?: number }>("crop", {
          label: `${label} · ${w.no ? `${w.no}번` : `${w.index + 1}번째`} 다시 맞추기`,
          images: [image],
          params: { target: { box: w.hint, ...(w.no ? { number: w.no } : {}) }, ...(effort ? { effort } : {}) },
        });
        if (typeof result.estKrw === "number") krw += result.estKrw;
        const r = result.box;
        if (!r) return;
        const orig = problems[w.index].boxes[0];
        const placed = toPage(r, w.win);
        if (!acceptRefined(orig, placed)) return;
        const box: KeepBox & { refined?: boolean; was?: ProblemBox } = { ...placed, refined: true, was: orig };
        if (Array.isArray(r.keep)) box.keep = r.keep.map((k) => toPage(k, w.win));
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
  return { problems: next, refined, krw };
}

/**
 * 찾은 자리를 사진의 글자에 맞춰 다듬는다(`snapBoxes`) — 지면 통째로 넣기와 비교 화면(`/admin/compare-crop`)이 **같은 함수**를 쓴다(보이는
 * 것과 잘리는 것이 같아야 한다). luna 가 짚은 번호·선지와 확대해 다시 본 자리는 `withKeep` 이 지킨다.
 */
export function snapPageProblems(
  img: HTMLImageElement | ImageBitmap,
  width: number,
  height: number,
  problems: DetectedProblem[],
): { problems: DetectedProblem[]; snapped: number } {
  const map = inkMapFromImage(img, width, height);
  if (!map) return { problems, snapped: 0 };
  const res = snapBoxes(map, problems.flatMap((p) => p.boxes));
  let k = 0;
  return {
    problems: problems.map((p) => ({
      ...p,
      boxes: p.boxes.map((orig) => {
        const kept = protectModelBox(withKeep(res.boxes[k++], orig), (orig as ProblemBox & { was?: ProblemBox }).was ?? orig);
        const was = (orig as ProblemBox & { was?: ProblemBox }).was;
        return was ? restoreBottom(map, kept, was) : kept;
      }),
    })),
    snapped: res.changed,
  };
}

/**
 * 모델이 준 박스(서버가 사방 `MODEL_PAD` 넓힌 것) 안쪽 = 모델이 실제로 짚은 자리는 **다듬기가 줄일 수 없다**(2026-10-09, 사용자 정답과 견주니
 * 다시 맞추기를 끄면 다듬기가 14번 위쪽을 6.2%p 잘라 내 모델 원자리(0.70%p)보다 나빠졌다 — 최종 1.34%p). 다듬기는 넓히는 쪽으로만 쓴다.
 * **보호 폭 0** = 서버가 넓힌 박스 전체를 못 줄인다(2026-10-09: 1.2%p 안쪽까지 줄이게 두면 하이쿠 최종이 모델 원자리 0.51 보다 나쁜 1.07%p 였다).
 */
const MODEL_PAD = 0;
function protectModelBox(snapped: ProblemBox, orig: ProblemBox): ProblemBox {
  const px0 = Math.min(1, orig.x + MODEL_PAD);
  const py0 = Math.min(1, orig.y + MODEL_PAD);
  const px1 = Math.max(px0, orig.x + orig.w - MODEL_PAD);
  const py1 = Math.max(py0, orig.y + orig.h - MODEL_PAD);
  const x0 = Math.min(snapped.x, px0), y0 = Math.min(snapped.y, py0);
  const x1 = Math.max(snapped.x + snapped.w, px1), y1 = Math.max(snapped.y + snapped.h, py1);
  return { ...snapped, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 되살릴 때 글자 덩어리를 같은 것으로 보는 가장 큰 흰 간격(지면 높이 대비) — 선지 줄 사이는 이보다 좁고, 다음 문제는 멀다. */
const RESTORE_GAP = 0.025;

/**
 * **다시 본 자리가 원래 자리보다 위에서 끝났을 때, 그 사이에 글자가 있으면 되살린다**(2026-10-09, 사용자 — "다시 맞추기 할 때 밑부분을 갑자기 날려 먹는
 * 경우가 생겨"). 처음에는 아래 변이 원래보다 올라오는 것을 무조건 막았는데(`guardBottom`), 그러면 **넉넉하게 잡는 모델은 아래 흰 여백이 그대로
 * 남는다**(다듬기는 다시 본 자리를 줄이지 못한다 — `withKeep`; 사용자 — "하이쿠가 넉넉하게 잡는 성향이 있네"). 그래서 잉크로 가른다:
 * 다시 본 아래 변과 원래 아래 변 사이를 훑어 **글자가 있으면** 그 덩어리의 마지막 줄까지 되살리고(흰 간격이 `RESTORE_GAP` 을 넘으면 거기서 끝 —
 * 멀리 떨어진 글자는 이웃 문제 것이다), **흰 여백뿐이면 그대로 둔다**(줄인 채).
 */
export function restoreBottom(map: InkMap, cur: ProblemBox, was: ProblemBox): ProblemBox {
  const { ink, w: W, h: H } = map;
  const clampPx = (v: number, hi: number) => Math.max(0, Math.min(hi, v));
  const x0 = clampPx(Math.round(cur.x * W), W - 1);
  const x1 = clampPx(Math.round((cur.x + cur.w) * W) - 1, W - 1);
  const yStart = clampPx(Math.round((cur.y + cur.h) * H), H - 1);
  const yEnd = clampPx(Math.round((was.y + was.h) * H) - 1, H - 1);
  if (yEnd <= yStart || x1 <= x0) return cur;
  const tol = Math.max(3, Math.round((x1 - x0 + 1) * 0.008));
  const maxGap = Math.round(H * RESTORE_GAP);
  let last = -1;
  let gap = 0;
  for (let y = yStart; y <= yEnd; y++) {
    let n = 0;
    const base = y * W;
    for (let x = x0; x <= x1; x++) n += ink[base + x];
    if (n > tol) {
      last = y;
      gap = 0;
    } else if (++gap > maxGap) {
      break;
    }
  }
  if (last < 0) return cur;
  const bottom = (last + 1) / H;
  return bottom > cur.y + cur.h ? { ...cur, h: bottom - cur.y } : cur;
}

/**
 * 번호·선지 둘레 여유(지면 대비). 사진 한 장 자르기(`KEEP_PAD` 1.2%)보다 좁다 — 지면에서는 바로 아래가 다음 문제라 넓게
 * 두르면 그 첫 줄이 딸려 온다.
 */
const PAGE_KEEP_PAD = 0.008;

/**
 * 다듬은 자리가 luna 가 짚은 번호·선지(`keep`)를 다 품게 넓힌다.
 *
 * **문제마다 확대해 다시 본 자리(`refined`)는 다듬기가 줄일 수 없다**(2026-10-09, 사용자 — "여전히 글씨가 잘리는 느낌"). `snapBoxes` 는
 * 변에 걸친 줄이 바깥에 더 걸쳤으면 이웃 것으로 보고 잘라 내는데, luna 가 마지막 줄 바로 위에 변을 두면 그 줄이 통째로 빠진다. 확대해
 * 본 자리는 "빈 띠에 두라"는 지시를 받고 가까이서 본 것이라 더 믿을 만하다 — 그래서 다듬은 자리와 그 자리를 **합친다**(남는 여백 몇 px 이
 * 잘린 글자보다 낫다). 다듬기가 넓힌 것(잘린 줄을 품은 것)은 그대로 산다.
 */
function withKeep(b: ProblemBox, orig: ProblemBox): ProblemBox {
  const o = orig as ProblemBox & { keep?: ProblemBox[]; refined?: boolean };
  let x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
  if (o.refined) {
    x0 = Math.min(x0, o.x);
    y0 = Math.min(y0, o.y);
    x1 = Math.max(x1, o.x + o.w);
    y1 = Math.max(y1, o.y + o.h);
  }
  const keep = o.keep;
  if (!Array.isArray(keep) || keep.length === 0) return { ...b, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  for (const k of keep) {
    x0 = Math.max(0, Math.min(x0, k.x - PAGE_KEEP_PAD));
    y0 = Math.max(0, Math.min(y0, k.y - PAGE_KEEP_PAD));
    x1 = Math.min(1, Math.max(x1, k.x + k.w + PAGE_KEEP_PAD));
    y1 = Math.min(1, Math.max(y1, k.y + k.h + PAGE_KEEP_PAD));
  }
  return { ...b, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
