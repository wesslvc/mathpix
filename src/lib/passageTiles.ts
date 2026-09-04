import { loadImage } from "./cropImage";
import { enhanceContrast } from "./autoContrast";

/**
 * 지문을 **확대한 조각**으로 나눈다.
 *
 * 왜 필요한가: 지문 한 장을 통째로 보내면 폭이 1536px 남짓이라, 한 줄의
 * 글자 높이가 20~30px밖에 안 된다. 그 크기에서 **밑줄이 그어졌는지**,
 * **어디에 네모(sq) 표시가 있는지**, ㄱ/ㄴ/ㄷ 표지가 무엇인지는 사람 눈으로도
 * 아슬아슬하다. 사용자가 "밑줄 친 부분과 원문자 등이 있는 지역들은 확대해서
 * 꼼꼼히 보게 시켜보자"고 한 게 이것이다.
 *
 * **어디를 확대할지 미리 찾지 않는다.** 그러려면 "밑줄이 어디 있나"를 먼저
 * 알아내야 하는데 그건 지금 하려는 일 그 자체다(닭과 달걀). 대신 지문을
 * 위에서 아래로 **겹치게** 잘라 전부 확대해 보낸다 — 어느 조각에 무엇이
 * 있든 한 번은 크게 보인다.
 *
 * **겹쳐서 자르는 게 중요하다.** 딱 붙여 자르면 경계에 걸친 줄이 두 조각
 * 어디에서도 온전히 안 보인다. 밑줄은 글자 **아래**에 그어지므로 줄이
 * 가로로 잘리면 밑줄만 다른 조각으로 넘어가 통째로 놓친다.
 *
 * 원본은 그대로 함께 보낸다 — 조각만 보면 **문단이 어디서 나뉘는지, 상자가
 * 어디까지인지** 같은 전체 구조를 알 수 없다. 둘을 겹쳐 쓰는 셈이다.
 */

/** 조각 하나의 최대 폭. 지문 크롭이 이미 이 폭이라 대개 그대로 쓴다. */
const TILE_WIDTH = 1536;
/** 위아래로 겹치는 비율. 한 줄 높이보다 넉넉해야 한다. */
const OVERLAP = 0.08;
/** 조각 전부를 합친 최대 크기(문자). Vercel 요청 본문 4.5MB 안에 들어가야 한다. */
const MAX_TILES_CHARS = 2_200_000;

/**
 * 조각 수를 정한다. **"확대"가 어디서 오는지 알아야 제대로 정할 수 있다.**
 *
 * 비전 모델은 그림을 그대로 보지 않는다 — `detail: "high"` 면 먼저 2048×2048
 * 안에 들어오게 줄이고, 그 다음 **짧은 변을 768px 로** 줄인다. 그래서 세로로
 * 긴 지문(1536×2600)은 폭이 **768로 반토막** 난 채 읽힌다. 글자 획이 뭉개져
 * 밑줄인지 아닌지, 네모가 있는지 없는지가 그 단계에서 이미 사라진다.
 *
 * 그런데 같은 그림을 **가로로 넓고 세로로 짧은 띠**로 자르면 짧은 변이
 * 768보다 작아져 **줄이는 단계가 아예 일어나지 않는다** — 폭 1536이 그대로
 * 살아 실효 해상도가 두 배가 된다. 확대의 정체가 이것이다(픽셀을 늘리는 게
 * 아니라, 줄어들지 않게 만드는 것이다).
 *
 * 그래서 조각의 세로가 폭의 **절반 이하**가 되게 나눈다(1536 폭이면 768).
 * 여섯을 넘지는 않는다 — 그림 한 장이 곧 입력 토큰이라 끝없이 늘릴 수는 없다.
 */
function tileCountFor(width: number, height: number): number {
  const need = Math.ceil((2 * height) / Math.max(1, width));
  // 여섯까지 허용한다. 넷으로 묶어 두면 **아주 긴 지문**(1536×4000 같은
  // 것)에서 띠 하나가 여전히 1000px 넘게 높아 짧은 변 768 규칙에 걸리고,
  // 그러면 이득이 1.32배로 떨어져 아래 MIN_GAIN 에 막혀 아예 안 만들어진다
  // — 정작 확대가 가장 필요한 경우가 빠지는 셈이었다.
  return Math.min(Math.max(need, 1), 6);
}

/**
 * 비전 모델이 이 크기의 그림을 **실제로 몇 px 폭으로** 보게 되는지.
 * `detail: "high"` 규칙 그대로 — 2048 안에 넣고, 짧은 변을 768로 줄인다
 * (줄이기만 하고 늘리지는 않는다).
 */
function effectiveWidth(w: number, h: number): number {
  const fit = Math.min(1, 2048 / Math.max(w, h));
  let W = w * fit;
  let H = h * fit;
  const short = Math.min(W, H);
  if (short > 768) {
    const s = 768 / short;
    W *= s;
    H *= s;
  }
  return W;
}

/**
 * 조각으로 나눌 만한가. **그림 한 장이 곧 토큰**이라 얻는 게 적으면 안 한다.
 *
 * 실제로 재 보면 세로로 긴 지문(1536×2600)은 가로 해상도가 768 → 1536 으로
 * **두 배**가 되는데, 가로로 넓적한 지문(1536×900)은 1311 → 1536 으로 1.17배
 * 밖에 안 오르면서 그림 토큰은 세 배가 된다. 그런 경우는 통째로 보내는 편이 낫다.
 */
const MIN_GAIN = 1.35;

/**
 * 지문 사진을 확대한 조각들로 만든다(위에서 아래로).
 *
 * 조각이 하나뿐이면(짧은 지문) **빈 배열**을 돌려준다 — 원본과 똑같은 그림을
 * 한 장 더 보내 봐야 토큰만 든다.
 */
export async function makeZoomTiles(dataUrl: string): Promise<string[]> {
  try {
    // 원본과 같은 보정을 거친다 — 조각만 대비가 달라 보이면 모델이 헷갈린다.
    const img = await loadImage(await enhanceContrast(dataUrl));
    const { naturalWidth: w, naturalHeight: h } = img;
    const count = tileCountFor(w, h);
    if (count < 2) return [];

    const band = h / count;
    // 얻는 게 적으면 그냥 통째로 보낸다(위 MIN_GAIN 설명 참고).
    const tileW = Math.min(w, TILE_WIDTH);
    const gain =
      effectiveWidth(tileW, band * (1 + OVERLAP * 2) * Math.min(1, TILE_WIDTH / w)) /
      Math.max(1, effectiveWidth(w, h));
    if (gain < MIN_GAIN) return [];

    const tiles: string[] = [];
    for (let i = 0; i < count; i++) {
      // 겹치는 만큼 위아래로 넓혀 자른다(사진 밖으로는 안 나간다).
      const top = Math.max(0, band * i - band * OVERLAP);
      const bottom = Math.min(h, band * (i + 1) + band * OVERLAP);
      const sh = bottom - top;
      if (sh <= 0) continue;

      // 폭은 **줄이기만 한다.** 없는 픽셀을 늘려 봐야 뭉갠 그림이 될 뿐이고
      // 토큰만 는다 — 우리가 얻으려는 것은 "줄어들지 않는 것"이지 확대가 아니다.
      const scale = Math.min(1, TILE_WIDTH / w);
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(sh * scale));
      const canvas = document.createElement("canvas");
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext("2d");
      if (!ctx) return [];
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, top, w, sh, 0, 0, cw, ch);
      tiles.push(canvas.toDataURL("image/jpeg", 0.9));
    }

    // **본문 크기 상한을 넘기면 안 된다**(Vercel 4.5MB). 넘으면 화질을 한 단계
    // 낮춰 다시 만들고, 그래도 넘으면 조각을 아예 붙이지 않는다 — 요청 자체가
    // 실패해 지문 인식이 통째로 안 되는 것보다 낫다.
    const total = (list: string[]) => list.reduce((n, t) => n + t.length, 0);
    if (total(tiles) > MAX_TILES_CHARS) {
      const lighter: string[] = [];
      for (let i = 0; i < count; i++) {
        const top = Math.max(0, band * i - band * OVERLAP);
        const bottom = Math.min(h, band * (i + 1) + band * OVERLAP);
        const sh = bottom - top;
        if (sh <= 0) continue;
        const scale = Math.min(1, TILE_WIDTH / w);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(sh * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) return [];
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, top, w, sh, 0, 0, canvas.width, canvas.height);
        lighter.push(canvas.toDataURL("image/jpeg", 0.72));
      }
      return total(lighter) > MAX_TILES_CHARS ? [] : lighter;
    }
    return tiles;
  } catch {
    // 조각을 못 만들면 원본만으로 간다 — 예전과 같은 동작이라 회귀가 아니다.
    return [];
  }
}
