import { LAYOUT } from "./pdf";

/**
 * 지문을 두 단에 나눠 흘릴 때 **어디서 가를지** 정한다(그림 높이의 0~1).
 *
 * 실제 국어 문제지는 지문이 좌단을 채우고 우단으로 이어진다. 쪽 전체에 맞춰
 * 줄이면 세로로 긴 지문이 가운데 좁은 띠가 되어 글자가 작아진다 — 사용자가
 * "크기를 줄여서 억지로 넣지 말고 우단에 밀어넣으라"고 한 것이 이 얘기다.
 *
 * **아무 데서나 자르면 글자 줄이 반으로 잘린다.** 그래서 이상적인 자리 근처에서
 * **잉크가 가장 적은 가로줄**(줄과 줄 사이 빈 띠)을 찾아 거기서 가른다.
 *
 * 좌단만으로 충분하면 `null` 을 돌려준다 — 그때는 좌단에 몰아넣는다.
 */
export async function passageSplitAt(
  png: Uint8Array,
  columnHeight: number,
): Promise<number | null> {
  const url = URL.createObjectURL(new Blob([png.slice().buffer], { type: "image/png" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();

    // 단 폭에 맞췄을 때의 높이. 이게 단 높이보다 작으면 나눌 이유가 없다.
    const k = LAYOUT.columnWidth / img.naturalWidth;
    const full = img.naturalHeight * k;
    if (full <= columnHeight) return null;

    const ideal = Math.min(0.95, Math.max(0.05, columnHeight / full));

    // 줄 사이 빈 띠를 찾으려고 가로줄마다 잉크 양을 센다. 세로만 정확하면
    // 되므로 가로는 크게 줄여 그린다(빠르고 결과는 같다).
    const W = 200;
    const H = Math.min(2000, img.naturalHeight);
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const g = c.getContext("2d", { willReadFrequently: true });
    if (!g) return ideal;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, W, H);
    g.drawImage(img, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;

    const ink = new Array<number>(H).fill(0);
    for (let y = 0; y < H; y++) {
      let n = 0;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if ((d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 < 160) n += 1;
      }
      ink[y] = n;
    }

    // 이상적인 자리에서 위아래로 조금씩만 옮긴다. 멀리 가면 한쪽 단이 휑해진다.
    const center = Math.round(ideal * H);
    const reach = Math.round(H * 0.06);
    let best = center;
    let bestInk = Infinity;
    for (let y = Math.max(1, center - reach); y <= Math.min(H - 2, center + reach); y++) {
      // 한 줄만 보면 획 사이 틈에 걸린다. 위아래 두 줄을 함께 본다.
      const v = ink[y - 1] + ink[y] + ink[y + 1];
      // 같은 값이면 이상적인 자리에 가까운 쪽을 고른다.
      if (v < bestInk || (v === bestInk && Math.abs(y - center) < Math.abs(best - center))) {
        bestInk = v;
        best = y;
      }
    }
    return best / H;
  } catch {
    // 못 재면 나누지 않는다 — 좌단에 몰아넣는 것이 안전한 기본값이다.
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
