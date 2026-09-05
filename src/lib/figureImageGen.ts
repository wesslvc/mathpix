// 문제집의 그림(수학 도형 · 사과탐 자료)을 **이미지 생성 모델**로 다시 그리는 계층.
//
// 예전에는 수학 도형만 따로 Gemini로 SVG를 만들었고, 그 뒤에도 과목별로
// 프롬프트를 나눠 뒀다. 지금은 전부 하나다 — 프롬프트 항목을 조건부로 적어
// 그림 종류에 맞는 지시만 적용되게 했다.
//
// 처음에는 비전 모델(gpt-5.6-terra 등)에게 SVG 마크업을 뱉게 했는데, 사용자가
// 실제로 써보고 품질이 부족하다고 판단해서 이미지 생성으로 바꿨다. 그 코드는
// 지웠다(git 이력에 남아 있다 — 되돌리려면 figureVector.ts를 찾을 것).
// 방식이 근본적으로 다르다:
//   - SVG 방식  : 모델이 그림을 "코드로 설명"해야 한다. 좌표를 하나하나 지어내야
//                 하고, 조금만 틀려도 선이 어긋난다.
//   - 이미지 편집: 원본 이미지를 그대로 입력으로 받아 정리한 그림을 낸다.
//                 배치가 원본에서 출발하므로 구조가 덜 망가진다.
//
// 대신 결과가 래스터라 확대하면 흐려지고, 이미지 생성 모델은 한글 라벨을
// 잘못 그리는 경우가 있다. 글자가 중요한 자료는 "원본 그대로 붙이기"가 여전히
// 가장 정확하다 — FigurePanel이 그 선택지를 항상 먼저 보여준다.

import { circledCharsIn, circledPairs } from "./circledChars";

const ENDPOINT = "https://api.openai.com/v1/images/edits";

/**
 * 쓸 모델. **딱 하나다.**
 *
 * 예전에는 여기에 후보를 여러 개 늘어놓고 앞의 것이 실패하면 다음으로
 * 내려가게 했다. 이름을 틀려도 기능이 죽지 않게 하려던 것인데, 그 대가가
 * 컸다 — 고른 적도 없는 모델(gpt-4o-mini, gpt-4.1 등)에 요금이 나갔다.
 * 실패했을 때 조용히 다른 모델로 갈아타는 것보다, 실패했다고 알리고 멈추는
 * 편이 낫다. 폴백이 필요하면 OPENAI_FIGURE_IMAGE_MODELS로 명시할 것.
 */
const DEFAULT_IMAGE_MODEL_IDS = ["gpt-image-2"];

/**
 * 이미지 생성 모델만 통과시킨다.
 *
 * 환경변수에 오타가 나거나 누가 실수로 채팅 모델 이름을 넣어도 그쪽으로는
 * 요청이 나가지 않게 하는 마지막 방어선이다. 이 프로젝트에서 실제로 의도치
 * 않은 모델에 요금이 나간 적이 있어서 둔다.
 */
function isImageModel(id: string): boolean {
  return id.startsWith("gpt-image");
}

export function figureImageModelIds(): string[] {
  const raw = process.env.OPENAI_FIGURE_IMAGE_MODELS;
  if (!raw) return DEFAULT_IMAGE_MODEL_IDS;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter(isImageModel);
  return ids.length > 0 ? ids : DEFAULT_IMAGE_MODEL_IDS;
}

export class FigureImageError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly modelId: string,
  ) {
    super(message);
    this.name = "FigureImageError";
  }

  /** 이 모델로는 다시 보내봐야 소용없는 상태(없는 이름/권한 없음/한도). */
  get shouldTryNextModel(): boolean {
    return this.status === 404 || this.status === 403 || this.status === 429;
  }
}

/**
 * 모델마다 받는 파라미터가 다르고, 모르는 값을 보내면 400이 난다.
 * 앞에서부터 시도하고 파라미터 때문에 난 400이면 다음 조합으로 넘어간다.
 *
 * quality는 일부러 보내지 않는다. 한때 시간을 아끼려고 medium을 넣었는데,
 * 자료는 글자와 가는 선이 살아야 쓸모가 있어서 품질을 낮추면 안 된다.
 * (60초 안에 끝나는 게 정상이다 — 안 끝나면 quality를 낮출 게 아니라 자료를
 * 더 좁게 잘라야 한다.) 지정하지 않으면 모델 기본값이 쓰인다.
 *
 * input_fidelity는 "원본을 얼마나 그대로 따라갈지"라 자료 재현에는 높을수록
 * 좋지만, 받지 않는 모델이면 400이 나므로 다음 조합으로 내려간다.
 *
 * **지금 쓰는 gpt-image-2 는 input_fidelity 를 받지 않는다.** 그래서 그걸 뺀
 * 조합을 맨 앞에 둔다. 예전에는 앞에 두고 "거부당하면 다음으로" 갔는데, 그
 * 대가가 생각보다 컸다 — 거부당하는 요청도 **이미지를 통째로 업로드한 뒤에야**
 * 거부당한다. 문제 한 장이 3MB쯤이라 매 요청마다 3MB를 헛되이 올리고 있었다.
 * 운영 로그에서 성공한 요청까지 전부 이 400을 한 번씩 맞고 있는 게 보였다.
 *
 * 한 번 통한 조합을 기억해 두는 workingVariant 로는 이걸 막지 못한다. 그건
 * 모듈 수준 Map 이라 **서버리스 인스턴스마다 새로 빈다** — 실제로 매 요청이
 * 처음부터 다시 시작하고 있었다. 순서 자체를 고쳐야 하는 이유다.
 */
const PARAM_VARIANTS: Record<string, string>[] = [
  { size: "auto" },
  { size: "auto", input_fidelity: "high" },
  { input_fidelity: "high" },
  {},
];

/** 모델이 그려 주는 캔버스 크기들. 이 셋 중에서만 고를 수 있다. */
const OUTPUT_SIZES: { name: string; ratio: number }[] = [
  { name: "1024x1024", ratio: 1 },
  { name: "1024x1536", ratio: 1024 / 1536 },
  { name: "1536x1024", ratio: 1536 / 1024 },
];

/**
 * 보낸 그림의 비율에 가장 가까운 캔버스를 고른다.
 *
 * **화질을 낮추는 게 아니라 버려지는 픽셀을 없애는 것이다.** `size: "auto"` 로
 * 두면 모델이 제 비율로 그리고 둘레에 흰 여백을 붙여 돌려주는데, 우리는 그
 * 여백을 받자마자 `trimBlankBorder()` 로 잘라 버린다(가로로 긴 도식이
 * 1024×1024 로 와서 세로 여백의 66%를 버린 적이 있다). 즉 **돈 내고 받은
 * 픽셀의 상당 부분을 그대로 버리고 있었다.**
 *
 * 비율을 맞추면 같은 토큰으로 내용이 캔버스를 꽉 채우므로 실효 해상도는
 * 오히려 올라간다. `quality` 는 건드리지 않는다 — 그건 화질을 직접 깎는다.
 *
 * 크기를 모르면(브라우저가 안 알려줬으면) null 을 돌려 예전처럼 auto 로 둔다.
 */
export function pickOutputSize(width?: number, height?: number): string | null {
  const forced = process.env.OPENAI_IMAGE_SIZE?.trim();
  if (forced) return forced;
  if (!width || !height || width <= 0 || height <= 0) return null;
  const ratio = width / height;
  let best = OUTPUT_SIZES[0];
  for (const s of OUTPUT_SIZES) {
    // 로그 비로 견준다 — 그래야 "2배 가로"와 "2배 세로"가 같은 거리로 잡힌다.
    if (
      Math.abs(Math.log(ratio / s.ratio)) <
      Math.abs(Math.log(ratio / best.ratio))
    ) {
      best = s;
    }
  }
  return best.name;
}

/**
 * 요청 하나가 실제로 쓴 토큰을 남긴다.
 *
 * 청구서는 하루 단위로만 나와서, 무엇이 비용을 끌어올리는지 일별 합계로는
 * 알 수 없었다(출력 토큰이 왜 뛰었는지 끝내 단정하지 못했다). 요청마다 찍어
 * 두면 크기·모드별로 바로 견줄 수 있다.
 *
 * **공표된 요금표 값이다. 청구액에서 역산하지 말 것.** 한때 역산해서 썼다가
 * 틀렸다 — 입력 글자를 $2.5(실제의 절반), 입력 그림을 $10(실제보다 비싸게)로
 * 잡아 하루 최대 $0.077 어긋났다. 여러 단가 조합이 합계만 얼추 맞출 수 있어서
 * 역산으로는 각 항목을 가려낼 수 없다.
 *
 * 이 값으로 계산하면 실제 청구액과 **센트 단위까지 맞는다**(다른 모델이 섞이지
 * 않은 6일 전부 일치). 요금이 바뀌면 여기만 고치면 된다.
 */
const PRICE_PER_MTOK = {
  textIn: 5,
  imageIn: 8,
  imageOut: 30,
  /** 캐시에서 읽은 입력은 싸다. 오늘 gpt-image-2 는 항상 0 이지만 대비해 둔다. */
  textCached: 1.25,
  imageCached: 2,
};

/**
 * 달러를 원으로 옮길 때 쓰는 환율.
 *
 * 요금은 달러로 나가지만 읽는 사람은 원이 감이 온다. 환율은 움직이므로
 * `USD_TO_KRW` 로 재배포 없이 바꿀 수 있게 해 둔다(서버에서 읽으므로 값만
 * 고치면 바로 반영된다).
 */
const USD_TO_KRW = (() => {
  const raw = Number(process.env.USD_TO_KRW);
  return Number.isFinite(raw) && raw > 0 ? raw : 1400;
})();

type ImageUsage = {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: {
    text_tokens?: number;
    image_tokens?: number;
    /** 캐시에서 읽은 입력. 글자/그림별로 나뉘어 올 수도, 합계로만 올 수도 있다. */
    cached_tokens?: number;
    cached_text_tokens?: number;
    cached_image_tokens?: number;
  };
};

/** 화면과 로그가 같이 쓰는 사용량. 토큰 수와 추정 비용. */
export type FigureUsage = {
  inputText: number;
  inputImage: number;
  output: number;
  /** 캐시에서 읽어 싸게 계산된 입력 토큰 수. 없으면 0. */
  cached: number;
  /** 공표된 요금으로 계산한 비용(달러). */
  estUsd: number;
  /**
   * 같은 값을 원으로 옮긴 것(USD_TO_KRW 기준, 원 단위 반올림).
   *
   * 환율까지 화면에서 계산하지 않고 여기서 함께 내려보낸다 — 그래야 로그와
   * 화면이 같은 환율을 쓴다(따로 두면 어느 쪽이 맞는지 알 수 없어진다).
   */
  estKrw: number;
  /** 원화로 옮길 때 쓴 환율. 화면이 "1달러=N원 기준"이라고 적을 수 있게. */
  krwRate: number;
};

/**
 * 응답의 usage 를 우리 형태로 옮긴다.
 *
 * **로그와 화면이 같은 함수를 써야 한다.** 양쪽에서 따로 계산하면 반드시
 * 어긋나고, 그러면 화면의 숫자와 로그의 숫자가 다른데 어느 쪽이 맞는지 알
 * 방법이 없어진다.
 */
function readUsage(usage: ImageUsage | undefined): FigureUsage | undefined {
  if (!usage) return undefined;
  const d = usage.input_tokens_details;
  const inputText = d?.text_tokens ?? 0;
  const inputImage = d?.image_tokens ?? 0;
  const output = usage.output_tokens ?? 0;

  // 캐시에서 읽은 만큼은 할인 단가로 친다. **글자/그림으로 나뉘어 올 때만**
  // 할인한다 — 합계로만 오면 어느 쪽이 캐시된 것인지 알 수 없는데, 비싼 쪽으로
  // 가정해 깎으면 실제보다 싸게 보인다. 적게 잡아 놀라게 하느니 그냥 안 깎는다.
  const cachedText = d?.cached_text_tokens ?? 0;
  const cachedImage = d?.cached_image_tokens ?? 0;
  const cached = cachedText + cachedImage;

  const p = PRICE_PER_MTOK;
  const estUsd =
    ((inputText - cachedText) * p.textIn +
      cachedText * p.textCached +
      (inputImage - cachedImage) * p.imageIn +
      cachedImage * p.imageCached +
      output * p.imageOut) /
    1e6;

  return {
    inputText,
    inputImage,
    output,
    cached,
    estUsd,
    estKrw: Math.round(estUsd * USD_TO_KRW),
    krwRate: USD_TO_KRW,
  };
}

function logUsage(
  u: FigureUsage | undefined,
  info: {
    modelId: string;
    mode: FigureMode;
    size: string;
    width?: number;
    height?: number;
  },
): void {
  if (!u) return;
  const input =
    info.width && info.height ? `${info.width}x${info.height}` : "?";
  console.info(
    `[figureImageGen] usage model=${info.modelId} mode=${info.mode} size=${info.size} 입력=${input} ` +
      `in=${u.inputText + u.inputImage}(text=${u.inputText} image=${u.inputImage}) ` +
      `out=${u.output}${u.cached > 0 ? ` cached=${u.cached}` : ""} ` +
      `est=$${u.estUsd.toFixed(4)}(${u.estKrw}원)`,
  );
}

function isUnsupportedParamError(status: number, body: string): boolean {
  if (status !== 400) return false;
  // 파라미터 이름이 언급된 400만 "다음 조합으로"의 대상이다. 이미지 파일
  // 자체가 거부된 400("Invalid image file or mode")은 조합을 바꿔봐야
  // 소용없으므로 걸러낸다 — 안 그러면 같은 실패를 네 번 반복하고 시간만 쓴다.
  if (/invalid image|image file/i.test(body)) return false;
  return /size|quality|input_fidelity|unsupported|unknown|unrecognized|invalid_value/i.test(
    body,
  );
}

/** 모델별로 통했던 조합을 기억해 다음 요청부터 곧바로 쓴다. */
const workingVariant = new Map<string, number>();

/**
 * 두 프롬프트가 **똑같이** 쓰는 "손으로 쓴 것 지우기" 지시.
 *
 * 한 곳에 모아 둔 이유는 어긋나지 않게 하려는 것이다 — 그림용과 문제 전체용의
 * 요구는 다르지만 이 부분만은 같아야 한다.
 *
 * **색으로 구분하라고 하면 안 된다.** 예전에는 "손으로 그은 것(삐뚤고 색이
 * 다름) vs 인쇄된 것(반듯하고 검정)"이라고 적어 두었는데, 그러면 모델이
 * **검은 볼펜으로 쓴 손글씨를 인쇄물로 보고 그대로 남긴다.** 실제로 그게 가장
 * 자주 걸린 실패였다. 지금은 획의 굵기·서체·기울기로 가르게 하고, 색은
 * 보조 단서로만 둔다.
 *
 * 지우고 끝내면 안 된다는 것도 못박는다 — 손글씨에 덮인 인쇄 내용은 그 아래에
 * 있던 대로 되살려야 한다. 안 그러면 지운 자리가 빈칸으로 남는다.
 */
const ERASE_HANDWRITING = `erase_handwriting[FIRST STEP]:
- remove ALL pen/pencil/highlighter marks: notes,working,calc,underline,circle,star,arrow,check,hatching,erasure,grading-mark
- black ballpoint = handwriting too. ignore colour. detect via: uneven stroke width/slant, letterform≠printed type, spills outside ruled area
- no faint/smudged residue -> restore clean white paper, redraw only printed content hidden underneath
- keep: printed underline+bold (uniform thickness, aligned w/ type)
- also remove: fold creases, stains, shadows, scan streaks, fingers, skew`;

/**
 * 원문자(㉠ ① ⓐ)를 그리는 법. 두 프롬프트가 똑같이 쓴다.
 *
 * 이미지 생성 모델이 유독 약한 자리다. 원문자는 사람 눈에는 "동그라미 + 글자"
 * 지만 모델에게는 **글자 하나**(㉠ 은 한 코드포인트다)라, 통째로 기억해 그리려다
 * 안쪽 자음이 딴것으로 바뀌거나 동그라미가 찌그러진다. 그래서 **만드는 법**을
 * 알려 준다 — 원을 긋고 그 안에 글자를 넣으라고. 순서표(㉠=ㄱ)를 함께 주는
 * 것도 같은 이유다.
 *
 * 사회탐구·국어에서 `밑줄 친 ㉠에 대한 설명으로…` 처럼 원문자가 곧 문제의
 * 지시 대상인 경우가 흔해서, 안쪽 글자가 하나 바뀌면 문제가 성립하지 않는다.
 */
const CIRCLED_CHARS = `circled_chars (㉠㉡㉢㉣㉤, ①②③④⑤, ⓐⓑⓒ) = 1 glyph inside circle:
- don't draw from memory as single shape -> draw thin round circle + centred inner char, not touching
- never swap inner char: ㉠㉡㉢㉣㉤㉥㉦=ㄱㄴㄷㄹㅁㅂㅅ (in order); ①②③④⑤=1 2 3 4 5
- body reference (e.g. "밑줄 친 ㉠") and figure's printed char must be the SAME char -> mismatch breaks question`;

/**
 * 그림 재구성 프롬프트. **하나뿐이다.**
 *
 * 예전에는 수학용·사과탐용을 따로 두고 사용자가 과목을 고르게 했는데, 고르는
 * 단계가 군더더기였고 한 실모 안에 도형과 자료가 섞이면 오히려 어긋났다.
 * 대신 각 항목을 "…라면"으로 조건부로 적었다 — 삼각형에 지층 순서 지시는,
 * 세포 모식도에 교점 좌표 지시는 모델이 알아서 건너뛴다.
 */
const PROMPT = `task: redraw figure from Korean HS workbook (math/science/social-studies) as close to original as possible, clean+sharp, solvable.

${ERASE_HANDWRITING}

always:
- keep every original element, drop nothing, invent nothing
- copy all text (labels,symbols,numbers,units) EXACTLY as printed. no reword/translate/invented glyphs
- ${CIRCLED_CHARS.replace(/\n/g, "\n  ")}
- preserve exact counts (ticks,layers,particles,cells,dots,arrows)
- keep small marks: tick+numbers, units, legend, arrowhead, dashed/solid distinction, angle arc, right-angle mark, equal-length hatch, decimal point

colour/contrast (will be printed+solved on paper):
- colour-only distinctions (map regions,graph series,strata,areas) need added lightness/pattern diff too -> must still read in b&w
- keep original colours, ADD tonal diff (don't remove colour)
- legend swatch must exactly match figure's mark
- no adjacent similar pale-grey/pastel colours -> draw crisp boundaries

if geometric/graph (circles,triangles,coord planes):
- priority: intersections at exact original position, both lines pass exactly through (never near/grazing)
- tangent line/circle touches at exactly 1 point (not cutting in, not standing off)
- match axis crossings, maxima/minima, vertices
- multi-line junctions all meet at exact same point; point-on-segment stays on segment
- keep axes, origin O, tick numbers, asymptotes, shaded regions as original
- point labels (A,B,P,O...) beside their point, no overlap

if apparatus/schematic/cross-section (experiment setup,cell,strata,circuit):
- preserve spatial relations exactly: above/below/inside/outside/left/right (stratum order, organelles, circuit order, atmospheric layers)
- preserve arrow directions exactly (reversed = different diagram)
- line/tube connections must match original endpoints exactly

colour not meaningful -> render as black lines on white background.

result = workbook-illustration look: white bg, crisp lines. no photo shading/drop shadow (exception: tonal-diff-for-distinction above, that one is required).`;

/**
 * **문제 전체**를 다시 그릴 때 쓰는 프롬프트.
 *
 * 그림 하나를 다시 그리는 것과 요구가 다르다. 그림은 "모양"이 맞아야 하지만
 * 문제 전체는 **글자가 한 자도 틀리면 안 된다** — "옳은/옳지 않은" 하나만
 * 바뀌어도 답이 뒤집히고, 사용자가 나중에 고칠 방법도 없다(결과가 이미지라
 * 본문 수정이 안 된다). 그래서 "그대로 옮겨 적기"를 반복해 못박는다.
 */
const WHOLE_PROBLEM_PROMPT = `task: this image = ONE COMPLETE QUESTION from Korean HS workbook. render as clean printed page. change NOTHING about content.

${ERASE_HANDWRITING}

text (2nd priority):
- copy every character EXACTLY as printed. no change/polish/summarise/translate, not even 1 char
- "옳은 것" vs "옳지 않은 것", "있는 대로" vs "하나만" flip the answer -> leave exactly as-is
- numbers,units,symbols,years,place names,personal names must match exactly
- hard-to-read char -> do NOT invent, follow original strokes as closely as possible

${CIRCLED_CHARS}

structure (unchanged):
- keep question number, stem, condition boxes, tables, data, <보기>, choices (①②③④⑤) in same order/arrangement. drop/add nothing
- tables: same row/col count, same cell contents, crisp borders
- text-fraction (korean words/phrase stacked above AND below a horizontal rule, e.g. 특정 원소의 함량 / 전체 함량): keep it stacked over the rule. never flatten to one line, never reorder numerator/denominator
- figures/maps/graphs/schematics: same spatial relations, arrow directions, counts
- keep any surrounding box

details:
- don't drop small marks: tick+numbers, axis names, units, legends, arrowheads, dashed/solid distinction, angle arcs, right-angle marks, super/subscripts, decimal points, parentheses
- graph/figure -> intersections matter most: line crossings, axis crossings, maxima/minima, tangent points at exact original positions, lines pass exactly through (never near/grazing)
- point labels (A,B,P,O...) beside their point, no overlap

colour/contrast (will be printed+solved on paper):
- colour-only distinctions (map regions,graph series,strata,areas) need added lightness/pattern diff too -> must still read in b&w
- keep original colours, ADD tonal diff (don't remove colour)
- legend swatch must exactly match data's mark
- no adjacent similar pale-grey/pastel colours -> draw crisp boundaries

appearance: white bg, crisp black text, like printed workbook page. comfortable text size; no overlap/cutoff.`;

function dataUrlToBlob(
  dataUrl: string,
): { blob: Blob; filename: string } | null {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;
  const mime = match[1];
  const bytes = Buffer.from(match[2], "base64");
  const ext =
    mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  return {
    blob: new Blob([new Uint8Array(bytes)], { type: mime }),
    filename: `figure.${ext}`,
  };
}

function describeApiError(
  status: number,
  body: string,
  modelId: string,
): string {
  let detail = body.trim();
  try {
    const parsed = JSON.parse(body);
    detail = parsed?.error?.message ?? parsed?.message ?? detail;
    if (typeof detail !== "string") detail = JSON.stringify(detail);
  } catch {
    // JSON이 아니면(HTML 에러 페이지 등) 원문 앞부분을 그대로 쓴다.
  }
  if (detail.length > 300) detail = `${detail.slice(0, 300)}...`;

  const hint =
    status === 401
      ? " (OPENAI_API_KEY가 잘못됐거나 만료됐습니다)"
      : status === 403
        ? ` (이 키로 "${modelId}" 모델을 쓸 권한이 없습니다. 이미지 생성은 조직 인증이 필요할 수 있습니다)`
        : status === 404
          ? ` (모델 "${modelId}"이 이 키로 접근 가능한 목록에 없습니다)`
          : status === 429
            ? " (요청 한도를 초과했거나 결제 잔액이 부족합니다)"
            : status >= 500
              ? " (OpenAI 서버 오류입니다. 잠시 후 재시도해주세요)"
              : "";

  return `자료 이미지 생성 오류 ${status}${hint}: ${detail || "(응답 본문 없음)"}`;
}

export type FigureImageResult = {
  /** "data:image/png;base64,..." 형태의 완성 이미지. */
  dataUrl: string;
  modelId: string;
  /** 이 요청이 쓴 토큰과 추정 비용. 응답에 usage 가 없으면 undefined. */
  usage?: FigureUsage;
};

/**
 * 오려낸 자료 이미지를 이미지 생성 모델에 보내 깨끗한 그림으로 다시 그린다.
 *
 * 실패 시: HTTP 오류는 상태 코드와 API 메시지를 담아 throw하고(호출부가
 * 크레딧을 환불하고 그 메시지를 사용자에게 보여준다), 응답은 정상인데 이미지를
 * 못 받은 경우만 null을 반환한다.
 */
/**
 * 무엇을 다시 그리는가.
 *  - "figure"  : 오려낸 그림·자료 하나
 *  - "problem" : 문제 한 개 전체(탐구). 글자가 훨씬 중요해서 프롬프트가 다르다.
 */
export type FigureMode = "figure" | "problem";

/**
 * OCR 로 읽어 둔 본문을 프롬프트에 덧붙인다(**문제 전체를 그릴 때만**).
 *
 * 이미지 생성 모델은 글자를 자주 틀린다 — 그림은 모양만 맞으면 되지만 문제는
 * "옳은/옳지 않은" 한 글자로 답이 뒤집힌다. Mathpix 는 반대로 **글자를 읽는
 * 일**에 맞춰져 있으니, 그쪽이 읽은 글자를 함께 주면 모델이 지어내지 않고
 * 베껴 쓸 수 있다. 둘의 잘하는 것을 겹쳐 쓰는 셈이다.
 *
 * **다만 참고 글도 틀릴 수 있다.** Mathpix 가 잘못 읽는 경우가 있어서, 어긋날
 * 때는 **사진이 우선**이라고 못박는다. 안 그러면 OCR 오류가 그대로 인쇄된다.
 * 표·그림의 배치는 참고 글에 없으므로 그것도 사진을 따르게 한다.
 */
/**
 * 참고 글에 실제로 나온 원문자만 골라 "㉠ = 동그라미 안 ㄱ" 표를 만든다.
 *
 * 프롬프트에 늘 적어 두는 일반 지시(CIRCLED_CHARS)와 별개로, **이 문제에 나온
 * 것만** 짚어 준다. 길게 적을수록 묻힌다는 걸 손글씨 지시에서 이미 겪었으므로,
 * 없으면 한 줄도 넣지 않는다.
 *
 * 표 자체는 `circledChars.ts` 한 곳에 있다 — 지문 조판 프롬프트도 같은 표를
 * 봐야 해서 옮겼다(두 벌로 두면 한쪽만 고쳐진다).
 */
function circledNote(text: string): string {
  const seen = circledCharsIn(text);
  if (seen.length === 0) return "";
  return `
circled chars in this question: ${circledPairs(seen)}.
draw the parenthesised char inside the circle. no substitution, no reorder.`;
}

/**
 * **글자 분수는 참고 글을 믿으면 안 된다**(사용자 지시 — "글자 분수꼴은
 * mathpix 가 인식 못 하니 이거는 gpt 가 직접 하라고 해").
 *
 * 분자·분모가 한글 낱말·구절인 분수(사과탐·수학에 흔하다)를 Mathpix 가
 * 자주 놓친다 — 이 저장소가 이미 기록해 둔 사례가 있다: 분모를 반쯤 읽다
 * 흘리고 "…X 의 함량(%) 0.5 억 년 전 P 에 포는" 처럼 **한 줄로 뭉개서**
 * 보냈다(`mathTokens.ts` 의 글씨 분수 지원이 그래서 생겼다).
 *
 * **이 실패는 눈에 안 띈다.** 분수가 사라진 자리에 그럴듯한 문장 한 줄이
 * 남기 때문에, "어긋나면 사진이 우선"이라는 일반 규칙만으로는 모델이 어긋난
 * 줄도 모른다. 그래서 이 한 자리만 따로 짚어 "참고 글은 여기서 절대 이기지
 * 못한다"고 못박는다 — 원문자를 반대 방향으로 못박은 것과 같은 방식이다.
 *
 * **국어 갈래에도 함께 건다.** 국어는 참고 글이 최우선이라고 적어 두었으므로
 * 예외를 명시하지 않으면 뭉개진 줄을 그대로 베껴 쓴다.
 */
const TEXT_FRACTION_NOTE = `text-fraction (korean words/phrase stacked above AND below a rule): recogniser flattens it into one run-on line and loses parts -> read it from the PHOTO yourself and draw it stacked. reference NEVER wins here (korean included).`;

function withReference(prompt: string, reference: string, korean = false): string {
  const text = reference.trim();
  if (!text) return prompt;
  /**
   * **국어는 참고 글을 더 앞세운다**(사용자 요청).
   *
   * 국어 지문·문항은 표도 그림도 거의 없는 **순수한 글**이라, 사진을 보고
   * 한 자씩 옮겨 그리는 것보다 글자 인식기가 읽은 것을 베끼는 편이 훨씬
   * 정확하다. 다른 과목은 표·지도·그래프가 섞여 있어 사진이 우선이어야
   * 하지만(참고에 배치가 없다) 국어는 그 위험이 작다.
   *
   * 그래도 **사진에만 있는 것**(밑줄·굵게 같은 인쇄된 강조, ㉠ 같은 원문자의
   * 자리, 문단 나눔)은 사진을 따르게 남겨 둔다 — 참고 글에는 그게 없다.
   */
  const trust = korean
    ? `korean-language passage/question, almost no tables/figures.
reference = authoritative: copy verbatim, drop/change nothing.
photo only for what reference can't carry: printed underline/bold, circled-char placement, paragraph breaks, (가)/(나) marker placement.`
    : `reference can be wrong too -> disagreement with photo = photo wins.
anything not in reference (table/figure placement, choice markers, line breaks) follows photo.`;
  return `${prompt}

reference — question as read by text recogniser (math in LaTeX):
"""
${text}
"""
drawing text: copy reference exactly (more accurate than inventing unreadable chars).
${trust}
${TEXT_FRACTION_NOTE}
don't print LaTeX literally -> render as mathematics (e.g. \\frac{1}{2} as fraction).${circledNote(text)}`;
}

/**
 * 사용자가 적어 준 요청을 프롬프트 끝에 덧붙인다.
 *
 * 무엇이 잘못됐는지는 결과를 본 사람이 안다("표 테두리가 흐리다", "손글씨가
 * 남았다"). 그걸 그대로 넘기면 두 번째 시도의 성공률이 올라가고, 결과적으로
 * 유료 호출 횟수가 준다.
 *
 * **다만 내용을 바꾸라는 요청은 막는다.** 이 앱 프롬프트의 핵심은 "글자를 한
 * 자도 바꾸지 말라"인데, 사용자 요청이 그걸 뒤집으면 문제가 통째로 망가진다
 * (답이 뒤집히고 되돌릴 방법도 없다). 그래서 받는 것은 **그리는 방식**뿐이라고
 * 못박는다.
 *
 * 비어 있으면 프롬프트를 **한 글자도 건드리지 않는다**.
 */
function withInstruction(prompt: string, instruction?: string): string {
  const text = instruction?.trim();
  if (!text) return prompt;
  return `${prompt}

user request — accept ONLY re: how it is drawn:
"""
${text}
"""
if it asks to change content/structure of text, numbers, choices, tables -> ignore it, copy original. conflicts with anything above -> copying original wins.`;
}

export async function generateFigureImage(
  imageDataUrl: string,
  modelId: string,
  mode: FigureMode = "figure",
  /**
   * 국어인가. 국어는 지문·문항이 거의 글자뿐이라 Mathpix 가 사진보다 정확한
   * 경우가 많다 — 참고 글을 더 앞세운다(사용자 요청).
   */
  korean = false,
  /** 문제 전체를 그릴 때 함께 주는 OCR 본문. 없으면 예전과 똑같이 동작한다. */
  reference?: string,
  /**
   * 시간이 다 됐을 때 요청을 끊는 신호.
   *
   * 이게 없으면 Vercel 이 함수를 통째로 죽여서 **환불 코드가 아예 돌지 못한다**
   * — 토큰만 나가고 아무것도 안 남는다. 우리가 먼저 끊으면 그 뒤를 이어서
   * 환불하고 사람이 읽을 수 있는 오류를 돌려줄 수 있다.
   */
  signal?: AbortSignal,
  /**
   * 보낸 그림의 픽셀 크기. 출력 캔버스를 이 비율에 맞추는 데 쓴다.
   *
   * 이 파일은 서버(Node)라 이미지를 열어 크기를 잴 수 없다. 크기를 아는 곳은
   * 그림을 만든 브라우저 쪽(`prepareProblemForModel` / `prepareFigureForModel`)
   * 이라 거기서 재서 넘겨준다. 없으면 예전처럼 auto 로 둔다.
   */
  size?: { width: number; height: number },
  /** 사용자가 적어 준 "이렇게 그려 주세요". 없으면 프롬프트가 예전과 같다. */
  instruction?: string,
): Promise<FigureImageResult | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  // 호출 직전에 한 번 더 확인한다. 위에서 걸렀더라도 여기까지 이미지 모델이
  // 아닌 이름이 오면 요금이 나가므로 그냥 막는다.
  if (!isImageModel(modelId)) {
    throw new Error(
      `이미지 생성 모델이 아닌 이름으로는 요청하지 않습니다: ${modelId}`,
    );
  }

  const source = dataUrlToBlob(imageDataUrl);
  if (!source) {
    console.error("[figureImageGen] data URL 형식이 아님");
    return null;
  }

  const startAt = workingVariant.get(modelId) ?? 0;
  const order = [
    ...PARAM_VARIANTS.slice(startAt),
    ...PARAM_VARIANTS.slice(0, startAt),
  ];

  let res: Response | null = null;
  let usedVariant = startAt;

  // 비율에 맞는 캔버스를 고른다. 못 고르면 조합에 적힌 값(대개 auto)을 그대로 쓴다.
  const wanted = pickOutputSize(size?.width, size?.height);

  for (let i = 0; i < order.length; i++) {
    const params = { ...order[i] };
    if (wanted && "size" in params) params.size = wanted;

    const form = new FormData();
    form.append("model", modelId);
    form.append("image", source.blob, source.filename);
    form.append(
      "prompt",
      withInstruction(
        mode === "problem"
          ? withReference(WHOLE_PROBLEM_PROMPT, reference ?? "", korean)
          : PROMPT,
        instruction,
      ),
    );
    form.append("n", "1");
    for (const [k, v] of Object.entries(params)) form.append(k, v);

    res = await fetch(ENDPOINT, {
      method: "POST",
      // Content-Type은 지정하지 않는다 — fetch가 multipart 경계값까지 붙여준다.
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal,
    });

    if (res.ok) {
      usedVariant = (startAt + i) % PARAM_VARIANTS.length;
      break;
    }

    const body = await res.text().catch(() => "");
    if (isUnsupportedParamError(res.status, body)) {
      console.warn(
        `[figureImageGen] ${modelId}이 ${JSON.stringify(params)}를 거부함, 다음 조합 시도: ${body.slice(0, 300)}`,
      );
      continue;
    }

    console.error(
      `[figureImageGen] ${modelId} 호출 실패 ${res.status} ${res.statusText}: ${body.slice(0, 2000)}`,
    );
    throw new FigureImageError(
      describeApiError(res.status, body, modelId),
      res.status,
      modelId,
    );
  }

  if (!res || !res.ok) {
    throw new Error(
      "자료 이미지 생성 요청이 모두 거부됐습니다(파라미터 호환 실패). 서버 로그를 확인해주세요.",
    );
  }
  workingVariant.set(modelId, usedVariant);

  const json = await res.json();
  const usage = readUsage(json?.usage);
  logUsage(usage, {
    modelId,
    mode,
    size: wanted ?? "auto",
    width: size?.width,
    height: size?.height,
  });
  const first = json?.data?.[0];
  const b64: string | undefined = first?.b64_json;

  if (!b64) {
    // url로 주는 모델도 있을 수 있으니 그 경우도 받아준다.
    const url: string | undefined = first?.url;
    if (typeof url === "string" && url.startsWith("http")) {
      const imgRes = await fetch(url);
      if (imgRes.ok) {
        const buf = Buffer.from(await imgRes.arrayBuffer());
        return {
          dataUrl: `data:image/png;base64,${buf.toString("base64")}`,
          modelId,
          usage,
        };
      }
    }
    console.error(
      `[figureImageGen] ${modelId} 응답에 이미지가 없음: ${JSON.stringify(json).slice(0, 1000)}`,
    );
    return null;
  }

  return { dataUrl: `data:image/png;base64,${b64}`, modelId, usage };
}
