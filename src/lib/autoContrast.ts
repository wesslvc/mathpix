/**
 * 사진의 대비를 자동으로 올린다. **모델에 보낼 때만** 쓴다.
 *
 * 문제집을 손으로 찍은 사진은 대개 종이가 회색으로 나오고 글자가 옅다(실내
 * 조명, 그림자, 자동 노출). 사람 눈에는 읽히지만 모델에게는 글자와 종이의
 * 차이가 작아서, 못 읽은 글자를 지어내거나 아예 실패한다.
 *
 * 하는 일은 **히스토그램 늘리기(레벨 보정)** 한 가지다:
 * 밝기 분포에서 아래쪽·위쪽 끝을 조금 잘라 내고(`CUT`) 그 사이를 0~255 로
 * 편다. 종이는 흰색에, 글자는 검정에 가까워진다.
 *
 * **일부러 하지 않는 것들**
 * - 흑백으로 바꾸지 않는다. 사회탐구 지도·그래프는 색이 뜻을 가진다.
 * - 이진화(임계값)하지 않는다. 가는 점선·연한 빗금이 통째로 사라진다.
 * - 채널을 따로 늘리지 않는다. 색이 틀어져(화이트밸런스가 바뀌어) 원본과
 *   다른 자료가 된다.
 * - **채널마다 같은 값을 더하고 빼지도 않는다.** 그렇게 하면 옅은 색이
 *   원색으로 튄다 — 실제로 옅은 빨강 `(180,120,110)` 이 `(184,0,0)` 이 되어
 *   지도의 파스텔 구분이 통째로 날아갔다. 대신 **밝기의 배율**을 구해 세
 *   채널에 똑같이 곱한다. 색조는 그대로 두고 밝기만 펴는 방법이다.
 *
 * **이미 대비가 충분하면 손대지 않는다.** 스캔본이나 캡처 이미지가 그렇다.
 * 그런 그림을 더 늘리면 옅은 회색 면(지층·영역 구분)이 흰색으로 날아간다.
 */

/** 위아래로 잘라 낼 픽셀 비율. 먼지·반사 같은 극단값에 끌려가지 않게 한다. */
const CUT = 0.005;
/** 이 이상 벌어져 있으면 이미 충분한 대비다(0~255). */
const ENOUGH = 205;
/** 이보다 좁으면 거의 단색이다 — 늘리면 없던 얼룩이 도드라진다. */
const TOO_FLAT = 24;
/**
 * 검정으로 끌어내릴 수 있는 밝기의 한계.
 *
 * **가장 어두운 것을 무조건 검정으로 만들면 안 된다.** 글자가 없고 옅은 색면만
 * 있는 자료(색칠된 지도 같은 것)에서는 그 색면이 "가장 어두운 것"이라, 그대로
 * 늘리면 지역이 통째로 새까매진다(실제로 옅은 빨강·파랑이 둘 다 검정이 됐다).
 * 이보다 밝은 곳이 제일 어두운 그림은 애초에 글자가 없는 그림이므로, 검은
 * 점을 여기까지만 내리고 색은 그대로 둔다.
 */
const BLACK_CAP = 90;

/** 늘릴 구간을 정한다. 손댈 필요가 없으면 null. */
function levels(data: Uint8ClampedArray): { low: number; high: number } | null {
  const hist = new Uint32Array(256);
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    // 밝기(Rec. 601). 색은 건드리지 않고 밝기만 본다.
    const y = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    hist[y | 0] += 1;
    count += 1;
  }
  if (count === 0) return null;

  const cut = Math.floor(count * CUT);
  let low = 0;
  let high = 255;
  for (let sum = 0, v = 0; v < 256; v++) {
    sum += hist[v];
    if (sum > cut) {
      low = v;
      break;
    }
  }
  for (let sum = 0, v = 255; v >= 0; v--) {
    sum += hist[v];
    if (sum > cut) {
      high = v;
      break;
    }
  }
  const range = high - low;
  if (range < TOO_FLAT || range >= ENOUGH) return null;
  return { low: Math.min(low, BLACK_CAP), high };
}

/**
 * 대비를 올린 data URL 을 돌려준다. 손댈 필요가 없거나 실패하면 원본 그대로.
 *
 * 실패해도 던지지 않는다 — 대비를 못 올렸다고 인식 자체를 막을 이유는 없다.
 */
export async function enhanceContrast(dataUrl: string): Promise<string> {
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("이미지를 불러오지 못했습니다."));
      el.src = dataUrl;
    });
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return dataUrl;

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0);

    const image = ctx.getImageData(0, 0, w, h);
    const found = levels(image.data);
    if (!found) return dataUrl;

    // 밝기 y 를 y' 로 옮길 때 쓰는 **배율**을 미리 표로 만들어 둔다
    // (픽셀마다 나눗셈을 하면 느리다). y 가 0 이면 어차피 검정이라 0 으로 둔다.
    const gain = new Float32Array(256);
    const scale = 255 / (found.high - found.low);
    for (let v = 1; v < 256; v++) {
      gain[v] = Math.max(0, (v - found.low) * scale) / v;
    }

    const d = image.data;
    for (let i = 0; i < d.length; i += 4) {
      const y = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
      const k = gain[y | 0];
      d[i] = d[i] * k;
      d[i + 1] = d[i + 1] * k;
      d[i + 2] = d[i + 2] * k;
    }
    ctx.putImageData(image, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.9);
  } catch {
    return dataUrl;
  }
}
