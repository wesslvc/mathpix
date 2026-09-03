/**
 * 평가원 문제지 틀 — 원본이 조판해 둔 좌표를 그대로 담아 둔 것.
 *
 * 제목 표·성명칸·둥근 교시 딱지·쪽번호 사선 상자는 눈대중으로 다시 그릴 수
 * 있는 물건이 아니다. 원본 hwpx 를 rhwp 로 그려 좌표를 뽑아 두고
 * (`scripts/kice/build-frames.mjs`) 런타임에는 그것을 재생하기만 한다.
 * 단위는 pt.
 */

export type FrameBox = { x0: number; y0: number; x1: number; y1: number };

export type FrameItem =
  | {
      k: "rect";
      x: number;
      y: number;
      w: number;
      h: number;
      fill: string | null;
      stroke: string | null;
      sw: number;
      rx: number;
    }
  | {
      k: "line";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      stroke: string;
      sw: number;
      dash: string | null;
    }
  | { k: "circle"; cx: number; cy: number; r: number; fill: string }
  | { k: "image"; file: string; x: number; y: number; w: number; h: number }
  | {
      k: "text";
      x: number;
      y: number;
      sx: number;
      size: number;
      font: string;
      fill: string;
      len: number | null;
      t: string;
      /** 쪽마다 값이 달라지는 자리. 글자로 짝지어 찾을 수 없어서 표를 붙여 둔다. */
      role?: "pageNo" | "pageTotal";
      /** 자릿수가 늘어나도 오른쪽 끝이 그대로여야 하는 자리(홀수 쪽 번호 등). */
      alignRight?: number;
      /** 다른 글자와 한 덩어리로 묶이면 안 되는 조각. */
      standalone?: boolean;
    };

export type Frame = {
  width: number;
  height: number;
  items: FrameItem[];
  /** 이 네모 안에 통째로 들어가는 항목은 그리지 않는다(예: `5지선다형` 딱지). */
  drop?: FrameBox[];
};

export type FrameSet = { first: Frame; even: Frame; odd: Frame };
export type KiceFrames = {
  tamgu: FrameSet;
  math: FrameSet;
  korean: FrameSet;
  english: FrameSet;
};

/**
 * 탐구(사회·과학)는 틀 하나를 같이 쓰고 영역·과목명만 갈아끼운다.
 * 수학·국어·영어는 각자 틀이 있다(교시 딱지와 영역명이 틀에 박혀 있다).
 */
export type KiceArea = "사회탐구" | "과학탐구" | "수학" | "국어" | "영어";

/**
 * 국어 틀은 **수학 틀에서 만들었다**(`scripts/kice/make-korean-frame.mjs`).
 * 국어 문제지 hwpx 원본이 없어서 rhwp 로 뽑을 수가 없었는데, 수학과 국어는
 * 판형·단 구성이 같고 다른 것은 영역명(수학→국어)과 교시 딱지(제2교시→
 * 제1교시)뿐이라 그대로 옮겨 쓸 수 있다. 그래서 수학과 마찬가지로 표지에
 * 성명·수험번호 칸이 없다 — 원본을 구하면 그때 다시 뽑을 것.
 *
 * 영어 틀도 같은 방법으로 만들었다(`make-english-frame.mjs`). 다만 **표지의
 * 교시 딱지가 제2교시 그대로다** — 영어는 제3교시인데 실제 문제지에서 오려낸
 * 그림이 없다. 그래서 영어는 문제지 내보내기(`KICE_AREAS`)에 넣지 않고
 * 정답표 생성기에서만 쓴다. 정답표는 본문 쪽 틀에 그려지고 그 쪽에는 교시
 * 딱지가 아예 없어서 이 한계에 걸리지 않는다.
 */
export const frameKeyFor = (area: KiceArea): keyof KiceFrames =>
  area === "수학"
    ? "math"
    : area === "국어"
      ? "korean"
      : area === "영어"
        ? "english"
        : "tamgu";

let cached: Promise<KiceFrames> | null = null;

/**
 * **`force-cache` 를 쓰면 안 된다.** 그러면 브라우저가 오래된 사본을 그대로
 * 내주어서, 틀을 고쳐 배포해도 쓰던 사람에게는 며칠씩 옛 문제지가 나온다
 * (실제로 수학 표지에서 없앤 칸이 계속 보였다). `no-cache` 는 캐시를 쓰되
 * 매번 확인은 한다 — 안 바뀌었으면 304 라 26KB 를 다시 받지 않는다.
 */
export function loadKiceFrames(): Promise<KiceFrames> {
  cached ??= fetch("/kice/frames.json", { cache: "no-cache" }).then((res) => {
    if (!res.ok) throw new Error("평가원 문제지 틀을 불러오지 못했습니다.");
    return res.json() as Promise<KiceFrames>;
  });
  return cached;
}

/** 틀이 쓰는 그림(교시 딱지)을 모두 받아 온다. */
export async function loadFrameImages(set: FrameSet): Promise<Record<string, Uint8Array>> {
  const names = new Set<string>();
  for (const frame of Object.values(set)) {
    for (const item of frame.items) if (item.k === "image") names.add(item.file);
  }
  const out: Record<string, Uint8Array> = {};
  await Promise.all(
    [...names].map(async (name) => {
      const res = await fetch(`/kice/${name}`, { cache: "no-cache" });
      if (!res.ok) throw new Error(`틀 그림을 불러오지 못했습니다 (${name}).`);
      out[name] = new Uint8Array(await res.arrayBuffer());
    }),
  );
  return out;
}
