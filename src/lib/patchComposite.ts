import sharp from "sharp";

/**
 * **수정 결과에서 안 바뀐 곳을 지금 그림의 픽셀 그대로 되돌린다.**
 *
 * 편집 모델은 "적힌 곳만 고쳐라"를 받아도 나머지를 조금씩 다시 그린다(글자 획 두께, 선 위치, 색조).
 * 프롬프트로는 막을 수 없으므로 — 가이드도 "픽셀 그대로여야 하면 합성하라"고 한다 — 편집 전 그림(base)과
 * 편집 결과(edited)를 견줘 **실제로 달라진 칸만** 결과에서 가져오고 나머지는 base 를 쓴다.
 *
 * 순수 함수에 가깝다(네트워크·환경변수 없음). 실패하면 null 이라 부르는 쪽이 edited 를 그대로 쓴다.
 */

/** 칸 한 변(px). 글자 한두 자가 한 칸에 들어가는 크기. */
const TILE = 12;
/** 이 값 넘게 다른 픽셀을 "달라졌다"고 센다(0~255, 채널 최대 차). 색조가 살짝 변한 건 무시한다. */
const DIFF = 56;
/** 한 칸에서 달라진 픽셀이 이만큼 이상이면 그 칸을 바뀐 칸으로 본다. */
const MIN_PIXELS = 3;
/** 바뀐 칸을 이만큼(칸 수) 넓혀 글자 전체·번짐까지 결과에서 가져온다. */
const GROW = 2;
/** 바뀐 칸이 이 비율을 넘으면 모델이 통째로 다시 그렸거나 위치가 밀린 것이라 합성하지 않는다. */
const GIVE_UP = 0.55;

export type PatchComposite = {
  bytes: Buffer;
  mime: "image/jpeg";
  /** 결과의 몇 %가 base 픽셀 그대로인가(0~1). */
  keptRatio: number;
};

export async function compositePatch(baseBytes: Buffer, editedBytes: Buffer): Promise<PatchComposite | null> {
  const edited = sharp(editedBytes).removeAlpha();
  const meta = await edited.metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) return null;

  const editedRaw = await edited.clone().raw().toBuffer();
  const baseRaw = await sharp(baseBytes)
    .removeAlpha()
    .resize(w, h, { fit: "fill" })
    .raw()
    .toBuffer();
  if (editedRaw.length !== w * h * 3 || baseRaw.length !== editedRaw.length) return null;

  // 잡티·압축 노이즈를 줄이려고 살짝 흐려서 견준다.
  const blur = (raw: Buffer) => sharp(raw, { raw: { width: w, height: h, channels: 3 } }).blur(1).raw().toBuffer();
  const [bb, eb] = await Promise.all([blur(baseRaw), blur(editedRaw)]);

  const tw = Math.ceil(w / TILE);
  const th = Math.ceil(h / TILE);
  const count = new Uint16Array(tw * th);
  for (let y = 0; y < h; y++) {
    const rowT = Math.floor(y / TILE) * tw;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const d = Math.max(Math.abs(bb[i] - eb[i]), Math.abs(bb[i + 1] - eb[i + 1]), Math.abs(bb[i + 2] - eb[i + 2]));
      if (d > DIFF) count[rowT + Math.floor(x / TILE)]++;
    }
  }

  // 바뀐 칸 → GROW 만큼 넓히기.
  let changed = new Uint8Array(tw * th);
  for (let i = 0; i < changed.length; i++) if (count[i] >= MIN_PIXELS) changed[i] = 1;
  for (let g = 0; g < GROW; g++) {
    const next = changed.slice();
    for (let ty = 0; ty < th; ty++) {
      for (let tx = 0; tx < tw; tx++) {
        if (!changed[ty * tw + tx]) continue;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = tx + dx;
            const ny = ty + dy;
            if (nx >= 0 && ny >= 0 && nx < tw && ny < th) next[ny * tw + nx] = 1;
          }
        }
      }
    }
    changed = next;
  }
  let changedTiles = 0;
  for (let i = 0; i < changed.length; i++) changedTiles += changed[i];
  if (changedTiles / changed.length > GIVE_UP) return null;

  // 칸 마스크 → 픽셀 마스크(가장자리는 흐려서 이음매가 안 보이게).
  const maskPx = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    const rowT = Math.floor(y / TILE) * tw;
    for (let x = 0; x < w; x++) if (changed[rowT + Math.floor(x / TILE)]) maskPx[y * w + x] = 255;
  }
  const alphaRaw = await sharp(maskPx, { raw: { width: w, height: h, channels: 1 } }).blur(3).raw().toBuffer({ resolveWithObject: true });
  // 흐린 뒤에도 한 채널이라고 믿지 않는다(라이브러리가 채널을 늘려 돌려주는 경우가 있다).
  const aStride = alphaRaw.info.channels;
  const alpha = alphaRaw.data;

  const out = Buffer.alloc(w * h * 3);
  for (let p = 0, i = 0; p < w * h; p++, i += 3) {
    const a = alpha[p * aStride] / 255;
    out[i] = Math.round(baseRaw[i] * (1 - a) + editedRaw[i] * a);
    out[i + 1] = Math.round(baseRaw[i + 1] * (1 - a) + editedRaw[i + 1] * a);
    out[i + 2] = Math.round(baseRaw[i + 2] * (1 - a) + editedRaw[i + 2] * a);
  }
  const bytes = await sharp(out, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
  return { bytes, mime: "image/jpeg", keptRatio: 1 - changedTiles / changed.length };
}
