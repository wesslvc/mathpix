// **문제 그림에서 원래 번호가 찍힌 자리를 찾는다**(2026-10-04, 사용자 — "여러 개로 묶으면 1번부터 번호를 새로 써,
// 원래 번호 있던 자리에 번호를 덮어 버리는 거지" → "니가 찾지 말고 LUNA 쓰면 어떰"). 브라우저 전용.
//
// ① **luna 가 번호 자리를 찾는다**(`numberBox` 작업 — 대기열 없이 곧바로, 토큰 0). 번호가 없는 문제("밑줄 친 ㉠…")는 null.
// ② 우리는 그 네모를 **글자 덩어리로 확인한다**(`tightenNumberBox`) — 모델 좌표는 몇 픽셀씩 어긋나 그대로 덮으면 번호 끝이
//    삐져나오거나 뒤 글자를 물어뜯는다. 번호를 남김없이 덮을 수 있을 때만 덮고, 조금이라도 애매하면 null.
// null 이면 부르는 쪽이 그 문제는 번호를 안 바꾸고 알린다(원래 번호가 그대로 남는다 — 엉뚱한 글자를 덮는 것보다 낫다).

import { runAiTask } from "@/lib/aiTask";

export type NumberBox = {
  /** 그림 대비 비율(0~1). 덮을 네모(여유 포함). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 원래 번호 잉크의 아래 끝(그림 대비, 0~1) — 새 번호의 글자 줄을 여기에 맞춘다. */
  base: number;
  /** 원래 번호 잉크 높이(그림 대비, 0~1). */
  line: number;
  /**
   * 새 번호가 쓸 수 있는 폭(그림 폭 대비, 덮는 네모 왼쪽부터) — 바로 뒤 글자 앞까지. 새 번호가 더 길어도(3 → 12) 이 안에서
   * 그리면 뒤 글자를 안 덮는다.
   */
  room: number;
  /** 덮는 네모 왼쪽으로 비어 있는 폭(그림 폭 대비) — 새 번호가 넓으면 왼쪽 여백으로 조금 내어 쓴다. */
  lead: number;
};

type Box = { x: number; y: number; w: number; h: number };

/** luna 에 보내는 크기(긴 변). 카드 PNG 는 폭 1280 이라 거의 그대로 간다. */
const SEND_DIM = 1600;

async function openPng(png: Uint8Array) {
  const bmp = await createImageBitmap(new Blob([png.slice().buffer], { type: "image/png" }));
  const k = Math.min(1, SEND_DIM / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) g[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
  return { g, w, h, canvas, dataUrl: canvas.toDataURL("image/jpeg", 0.9) };
}

/**
 * 다시 물을 때 보낼 **왼쪽 위 확대본**. 번호는 늘 문제 왼쪽 위에 있는데, 카드 전체를 보내면 번호가 그림의 1~2% 라 luna(강도 low)가
 * "번호 없음"으로 넘기는 일이 잦았다(같은 그림이 회차마다 됐다 안 됐다 했다). 폭 60% × (그 폭의 절반) 를 잘라 크게 보낸다.
 * 돌려주는 `region` 은 원래 그림 대비 비율이다 — luna 좌표를 원래 그림으로 되돌리는 데 쓴다.
 */
function topLeftZoom(src: HTMLCanvasElement) {
  const sw = Math.max(1, Math.round(src.width * 0.6));
  const sh = Math.max(1, Math.min(src.height, Math.round(sw * 0.5)));
  const k = SEND_DIM / Math.max(sw, sh);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sw * k);
  canvas.height = Math.round(sh * k);
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, sw, sh, 0, 0, canvas.width, canvas.height);
  return {
    dataUrl: canvas.toDataURL("image/jpeg", 0.92),
    region: { x: 0, y: 0, w: sw / src.width, h: sh / src.height },
  };
}

type Comp = { x0: number; y0: number; x1: number; y1: number; n: number; edge: boolean };

/**
 * luna 가 준 네모(0~1)를 **글자 덩어리 단위로** 확인해 덮을 자리를 정한다(테스트하기 쉽게 따로 둔다).
 *
 * 규칙은 하나다 — **번호를 남김없이 덮거나, 아예 손대지 않는다**(사용자 — "문제를 가리거나 원래 번호를 덜 가리는 등의 문제는
 * 일으키면 안 되지"). 그래서 모델 좌표를 그대로 덮지 않고:
 *  ① 근처의 잉크를 이어진 덩어리(8방향)로 나눈다. luna 네모에 닿는 덩어리가 번호다.
 *  ② 번호 덩어리가 살펴본 창 끝까지 이어지면(밑줄·박스 테두리·그림에 붙은 것) 어디까지 덮을지 모르므로 손대지 않는다.
 *  ③ 덩어리 수가 luna 가 읽은 글자 수(`text`)보다 적으면 luna 네모가 글자를 잘라 먹은 것이다 — 바로 옆의 숫자 크기 덩어리를
 *     차례로 더해 맞추고, 그래도 안 맞으면 손대지 않는다(번호 일부가 남는 것보다 낫다).
 *  ④ 덮을 네모(여유 포함)가 번호 아닌 덩어리에 조금이라도 걸치면 여유를 줄이고, 그래도 걸치면 손대지 않는다.
 *  ⑤ 새 번호가 넓을 때 내어 쓸 수 있는 폭도 덩어리로 잰다 — 그 줄에서 다음 글자 앞 / 앞 글자 뒤까지.
 */
export function tightenNumberBox(
  g: ArrayLike<number>,
  w: number,
  h: number,
  box: Box,
  text = "",
): NumberBox | null {
  const INK = 140;
  const bx0 = box.x * w;
  const by0 = box.y * h;
  const bx1 = (box.x + box.w) * w;
  const by1 = (box.y + box.h) * h;
  const bh = Math.max(4, by1 - by0);
  // 살펴볼 창: luna 네모 둘레로 넉넉히(오른쪽은 다음 글자까지 보이게 더).
  const rx0 = Math.max(0, Math.floor(bx0 - bh * 2));
  const rx1 = Math.min(w - 1, Math.ceil(bx1 + bh * 3));
  const ry0 = Math.max(0, Math.floor(by0 - bh * 1.2));
  const ry1 = Math.min(h - 1, Math.ceil(by1 + bh * 1.2));
  const rw = rx1 - rx0 + 1;
  const rh = ry1 - ry0 + 1;
  const label = new Int32Array(rw * rh);
  const comps: Comp[] = [];
  const stack: number[] = [];
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const i = y * rw + x;
      if (label[i] || g[(y + ry0) * w + (x + rx0)] >= INK) continue;
      const id = comps.length + 1;
      const c: Comp = { x0: x, y0: y, x1: x, y1: y, n: 0, edge: false };
      label[i] = id;
      stack.push(i);
      while (stack.length) {
        const j = stack.pop()!;
        const cx = j % rw;
        const cy = (j - cx) / rw;
        c.n++;
        if (cx < c.x0) c.x0 = cx;
        if (cx > c.x1) c.x1 = cx;
        if (cy < c.y0) c.y0 = cy;
        if (cy > c.y1) c.y1 = cy;
        if (cx === 0 || cy === 0 || cx === rw - 1 || cy === rh - 1) c.edge = true;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
            const k = ny * rw + nx;
            if (label[k] || g[(ny + ry0) * w + (nx + rx0)] >= INK) continue;
            label[k] = id;
            stack.push(k);
          }
        }
      }
      // 창 좌표 → 그림 좌표
      c.x0 += rx0;
      c.x1 += rx0;
      c.y0 += ry0;
      c.y1 += ry0;
      comps.push(c);
    }
  }
  // 아주 작은 점(잡티)은 덮을지 말지에 끼지 않는다 — 마침표보다 훨씬 작은 것만(한 변이 줄 높이의 5% 미만) 버린다.
  const tiny = (c: Comp) => c.n < Math.max(2, (bh * 0.05) ** 2);
  const touches = (c: Comp, m: number) =>
    c.x1 >= bx0 - m && c.x0 <= bx1 + m && c.y1 >= by0 - m && c.y0 <= by1 + m;
  const m0 = bh * 0.12;
  // 가운데가 luna 네모 안에 드는 덩어리만 번호로 본다 — 네모가 뒤 글자에 살짝 걸쳤다고 그 글자까지 덮으면 안 된다.
  const centered = (c: Comp) => {
    const mx = (c.x0 + c.x1) / 2;
    const my = (c.y0 + c.y1) / 2;
    return mx >= bx0 - m0 && mx <= bx1 + m0 && my >= by0 - m0 && my <= by1 + m0;
  };
  const want = [...text.replace(/\s/g, "")].length;
  // luna 가 번호 글자를 안 알려 주면 몇 개를 덮어야 하는지 모른다 — 손대지 않는다.
  if (want === 0) return null;
  let mine = comps.filter((c) => !tiny(c) && touches(c, m0) && centered(c));
  if (!mine.length) return null;
  // ② 끝없이 이어지는 것(밑줄·테두리·그림)에 닿았으면 손대지 않는다.
  if (mine.some((c) => c.edge || c.x1 - c.x0 > bh * 2.5 || c.y1 - c.y0 > bh * 1.8)) return null;
  const others = () => comps.filter((c) => !tiny(c) && !mine.includes(c));
  const union = () => ({
    x0: Math.min(...mine.map((c) => c.x0)),
    y0: Math.min(...mine.map((c) => c.y0)),
    x1: Math.max(...mine.map((c) => c.x1)),
    y1: Math.max(...mine.map((c) => c.y1)),
  });
  // ③ luna 가 읽은 글자 수만큼 덩어리가 있어야 한다(괄호·네모 표지가 있으면 덩어리가 더 많을 수 있어 "모자랄 때"만 본다).
  //    네모 밖으로 가운데가 나간 숫자(luna 가 잘라 먹은 것)는 여기서 다시 붙는다.
  let guard = 0;
  while (mine.length < want && guard++ < 4) {
    const u = union();
    const H = u.y1 - u.y0 + 1;
    const near = others()
      .filter((c) => c.y1 >= u.y0 && c.y0 <= u.y1) // 같은 줄
      .filter((c) => c.y1 - c.y0 + 1 <= H * 1.15 && c.x1 - c.x0 + 1 <= H * 0.9) // 숫자·마침표만 한 크기
      .map((c) => ({ c, gap: c.x0 > u.x1 ? c.x0 - u.x1 : u.x0 - c.x1 }))
      .filter((o) => o.gap > 0 && o.gap <= H * 0.45)
      .sort((a, b) => a.gap - b.gap)[0];
    if (!near || near.c.edge) return null;
    mine = [...mine, near.c];
  }
  if (mine.length < want) return null;
  // 너무 많이 잡혔으면(낱말을 번호로 잘못 짚었을 때 — 자모 조각이 여럿 나온다) 손대지 않는다. 괄호·네모 표지만큼은 봐준다.
  if (mine.length > want + 2) return null;
  // 숫자다운가 — 다른 덩어리를 통째로 감싸는 표지(네모·동그라미)와 마침표는 빼고, 나머지는 한글 음절보다 좁아야 한다.
  {
    const encloses = (a: Comp) => mine.every((c) => c === a || (c.x0 >= a.x0 && c.x1 <= a.x1 && c.y0 >= a.y0 && c.y1 <= a.y1));
    const body = mine.filter((c) => !(mine.length > 1 && encloses(c)));
    const H = Math.max(...body.map((c) => c.y1 - c.y0 + 1));
    const glyphs = body.filter((c) => c.y1 - c.y0 + 1 > H * 0.35); // 마침표·쉼표 빼고
    if (!glyphs.length) return null;
    if (glyphs.some((c) => c.x1 - c.x0 + 1 > H * 0.85)) return null;
    // 숫자는 서로 키가 같다(±15%) — 한글 음절이 자모로 쪼개진 덩어리(ㄱ·ㅏ)는 키가 다르다.
    const hs = glyphs.map((c) => c.y1 - c.y0 + 1);
    if (Math.min(...hs) < Math.max(...hs) * 0.85) return null;
    // 숫자 덩어리 수가 luna 가 읽은 숫자 수와 같아야 한다("가." 를 "7." 로 읽었으면 덩어리가 둘이라 걸린다).
    const digits = (text.match(/[0-9]/g) ?? []).length;
    if (digits > 0 && glyphs.length !== digits) return null;
  }

  const u = union();
  const lineH = u.y1 - u.y0 + 1;
  const hits = (x0: number, y0: number, x1: number, y1: number) =>
    others().some((c) => c.x1 >= x0 && c.x0 <= x1 && c.y1 >= y0 && c.y0 <= y1);
  // ④ 여유를 주되 남의 글자에 걸치면 줄이고, 여유 없이도 걸치면 손대지 않는다.
  let pad = Math.max(1, Math.round(lineH * 0.12));
  while (pad > 0 && hits(u.x0 - pad, u.y0 - pad, u.x1 + pad, u.y1 + pad)) pad--;
  if (hits(u.x0 - pad, u.y0 - pad, u.x1 + pad, u.y1 + pad)) return null;
  const cx0 = Math.max(0, u.x0 - pad);
  const cy0 = Math.max(0, u.y0 - pad);
  const cx1 = Math.min(w - 1, u.x1 + pad);
  const cy1 = Math.min(h - 1, u.y1 + pad);
  // ⑤ 같은 줄(덮는 네모의 위아래 안)에서 다음 글자 앞 / 앞 글자 뒤까지가 새 번호에 내줄 수 있는 폭이다.
  const rowOthers = others().filter((c) => c.y1 >= cy0 && c.y0 <= cy1);
  const keep = Math.max(1, Math.round(lineH * 0.15));
  const nextX = Math.min(rx1 + 1, ...rowOthers.filter((c) => c.x0 > cx1).map((c) => c.x0));
  const prevX = Math.max(rx0 - 1, ...rowOthers.filter((c) => c.x1 < cx0).map((c) => c.x1));
  const roomEnd = Math.max(cx1 + 1, nextX - keep);
  const leadStart = Math.min(cx0, prevX + 1 + keep);
  return {
    x: cx0 / w,
    y: cy0 / h,
    w: (cx1 - cx0 + 1) / w,
    h: (cy1 - cy0 + 1) / h,
    base: (u.y1 + 1) / h,
    line: lineH / h,
    room: (roomEnd - cx0) / w,
    lead: Math.max(0, cx0 - leadStart) / w,
  };
}

/** 못 덮은 까닭 — none: luna 가 번호를 못 봄, unsafe: 찾았지만 남김없이·남의 글자 없이 덮을 수 없음, error: 호출 실패. */
export type NumberMiss = "none" | "unsafe" | "error";

type LunaNumber = { box: Box | null; text?: string };

async function askLuna(dataUrl: string, label: string, effort?: string): Promise<LunaNumber | null> {
  try {
    const { result } = await runAiTask<LunaNumber>("numberBox", {
      label: `번호 자리 · ${label}`.slice(0, 100),
      images: [dataUrl],
      params: effort ? { effort } : undefined,
    });
    return result ?? null;
  } catch {
    return null;
  }
}

/**
 * 문제 그림(PNG)에서 원래 번호 자리 — luna 가 찾고 잉크에 맞게 조인다.
 * 처음엔 그림 전체를 강도 low 로, 못 찾았거나 안전하게 못 덮으면 **왼쪽 위를 확대해 강도 medium 으로 한 번 더** 묻는다.
 * 두 번째도 좌표만 luna 것이고 덮을지 말지는 같은 규칙(`tightenNumberBox`)으로 원래 그림에서 정한다.
 */
export async function findNumberBox(
  png: Uint8Array,
  label: string,
): Promise<{ box: NumberBox | null; miss?: NumberMiss }> {
  let opened: Awaited<ReturnType<typeof openPng>>;
  try {
    opened = await openPng(png);
  } catch {
    return { box: null, miss: "error" };
  }
  const { g, w, h, canvas, dataUrl } = opened;
  const settle = (r: LunaNumber | null, map?: Box): NumberBox | null => {
    if (!r?.box) return null;
    const b = map
      ? { x: map.x + r.box.x * map.w, y: map.y + r.box.y * map.h, w: r.box.w * map.w, h: r.box.h * map.h }
      : r.box;
    return tightenNumberBox(g, w, h, b, r.text ?? "");
  };
  const first = await askLuna(dataUrl, label);
  const firstBox = settle(first);
  if (firstBox) return { box: firstBox };
  const zoom = topLeftZoom(canvas);
  const second = await askLuna(zoom.dataUrl, `${label} (다시)`, "medium");
  const secondBox = settle(second, zoom.region);
  if (secondBox) return { box: secondBox };
  if (!first && !second) return { box: null, miss: "error" };
  return { box: null, miss: first?.box || second?.box ? "unsafe" : "none" };
}
