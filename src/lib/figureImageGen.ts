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
export function pickOutputSize(
  width?: number,
  height?: number,
): string | null {
  const forced = process.env.OPENAI_IMAGE_SIZE?.trim();
  if (forced) return forced;
  if (!width || !height || width <= 0 || height <= 0) return null;
  const ratio = width / height;
  let best = OUTPUT_SIZES[0];
  for (const s of OUTPUT_SIZES) {
    // 로그 비로 견준다 — 그래야 "2배 가로"와 "2배 세로"가 같은 거리로 잡힌다.
    if (Math.abs(Math.log(ratio / s.ratio)) < Math.abs(Math.log(ratio / best.ratio))) {
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
 * 단가는 **사용자의 실제 청구액에서 역산한 값**이다(8일치 합계 오차
 * $0.13/$10.84). 정확한 청구액이 아니라 **요청끼리 견주는 용도**다.
 */
const PRICE_PER_MTOK = { textIn: 2.5, imageIn: 10, imageOut: 30 };

type ImageUsage = {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { text_tokens?: number; image_tokens?: number };
};

/** 화면과 로그가 같이 쓰는 사용량. 토큰 수와 추정 비용. */
export type FigureUsage = {
  inputText: number;
  inputImage: number;
  output: number;
  /** 위 역산 단가로 계산한 **추정** 비용(달러). 청구액이 아니다. */
  estUsd: number;
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
  const inputText = usage.input_tokens_details?.text_tokens ?? 0;
  const inputImage = usage.input_tokens_details?.image_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const estUsd =
    (inputText * PRICE_PER_MTOK.textIn +
      inputImage * PRICE_PER_MTOK.imageIn +
      output * PRICE_PER_MTOK.imageOut) /
    1e6;
  return { inputText, inputImage, output, estUsd };
}

function logUsage(
  u: FigureUsage | undefined,
  info: { modelId: string; mode: FigureMode; size: string; width?: number; height?: number },
): void {
  if (!u) return;
  const input = info.width && info.height ? `${info.width}x${info.height}` : "?";
  console.info(
    `[figureImageGen] usage model=${info.modelId} mode=${info.mode} size=${info.size} 입력=${input} ` +
      `in=${u.inputText + u.inputImage}(text=${u.inputText} image=${u.inputImage}) ` +
      `out=${u.output} est=$${u.estUsd.toFixed(4)}`,
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
const ERASE_HANDWRITING = `손으로 쓴 것을 전부 지우세요. 이것부터 하세요:
- 연필·볼펜·형광펜·색연필로 쓴 것은 **하나도 남기지 마세요.** 메모, 풀이 과정,
  계산, 밑줄, 동그라미, 세모, 별표, 화살표, 체크, 빗금, 지운 자국, 채점 표시.
- **검은 볼펜으로 쓴 것도 손글씨입니다.** 색으로 판단하지 마세요. 획 굵기가
  들쭉날쭉하거나, 크기·기울기가 제각각이거나, 인쇄 글자와 서체가 다르거나,
  칸 밖으로 삐져나가 있으면 손으로 쓴 것입니다.
- 옅게 남기거나 흐리게 뭉개지 마세요. 그 자리를 **깨끗한 흰 종이로 되돌리고**
  가려져 있던 인쇄 내용만 원래대로 그리세요.
- 인쇄된 밑줄·굵은 글씨는 그대로 두세요(두께가 일정하고 글자와 나란히 반듯합니다).
- 종이 접힌 자국, 얼룩, 그림자, 스캔 줄무늬, 손가락, 기울어짐도 없애세요.`;

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
const CIRCLED_CHARS = `원문자(㉠㉡㉢㉣㉤, ①②③④⑤, ⓐⓑⓒ)는 **동그라미 안에 글자 하나**입니다:
- 통글자로 외워 그리지 말고, 가는 원을 그린 뒤 그 안에 글자를 가운데 맞춰 넣으세요.
  원은 찌그러지지 않은 동그라미여야 하고 안쪽 글자가 원에 닿지 않아야 합니다.
- 안쪽 글자를 다른 것으로 바꾸지 마세요. ㉠㉡㉢㉣㉤㉥㉦ 은 차례로 ㄱㄴㄷㄹㅁㅂㅅ,
  ①②③④⑤ 는 차례로 1 2 3 4 5 입니다.
- 본문에서 가리키는 원문자(예: "밑줄 친 ㉠")와 자료에 찍힌 원문자는 **같은 글자**여야
  합니다. 서로 다르면 문제가 성립하지 않습니다.`;

/**
 * 그림 재구성 프롬프트. **하나뿐이다.**
 *
 * 예전에는 수학용·사과탐용을 따로 두고 사용자가 과목을 고르게 했는데, 고르는
 * 단계가 군더더기였고 한 실모 안에 도형과 자료가 섞이면 오히려 어긋났다.
 * 대신 각 항목을 "…라면"으로 조건부로 적었다 — 삼각형에 지층 순서 지시는,
 * 세포 모식도에 교점 좌표 지시는 모델이 알아서 건너뛴다.
 */
const PROMPT = `이 이미지는 한국 고등학교 문제집(수학·과학탐구·사회탐구)에 실린 그림입니다.
문제를 풀 수 있도록 원본과 최대한 똑같이, 깨끗하고 또렷하게 다시 그려주세요.

${ERASE_HANDWRITING}

어떤 그림이든 반드시:
- 원본에 있는 모든 요소를 그대로 두세요. 무엇 하나 빼거나 새로 만들지 마세요.
- 글자(한글 라벨, 기호, 숫자, 단위)는 원본에 적힌 그대로 옮기세요. 다른 말로 바꾸거나
  번역하지 말고, 읽을 수 없는 글자는 지어내지 마세요.
- ${CIRCLED_CHARS.replace(/\n/g, "\n  ")}
- 개수를 그대로 지키세요(눈금, 층, 입자, 칸, 점, 화살표).
- 작은 표시도 빼지 마세요: 눈금과 눈금 숫자, 단위, 범례, 화살표 머리, 점선과 실선의
  구분, 각도 호, 직각 표시, 같은 길이 표시(빗금), 소수점.

색과 명암(인쇄해서 푸는 자료입니다):
- 색으로만 구분된 것(지도의 지역, 그래프의 계열, 지층, 영역)은 **밝기 차이나
  무늬로도 구분되게** 하세요. 흑백으로 인쇄해도 어느 게 어느 것인지 알 수 있어야
  합니다. 진하기를 뚜렷하게 다르게 하거나 빗금·점무늬를 겹쳐 주세요.
- 색을 없애라는 뜻이 아닙니다. 원본의 색은 유지하되 명암 차이를 함께 주세요.
- 범례가 있으면 범례의 표시와 그림 속 표시를 똑같은 진하기·무늬로 맞추세요.
- 옅은 회색끼리, 비슷한 파스텔끼리 붙여 놓지 마세요. 경계선을 또렷하게 그으세요.

도형이나 그래프라면(원, 삼각형, 좌표평면 등):
- 가장 중요한 건 "어느 점에서 만나는가"입니다. 두 선이 만나는 지점을 원본과 같은
  자리에 두고, 양쪽 선이 정확히 그 점을 지나가게 하세요. 근처에서 어긋나거나
  스치듯 지나가면 안 됩니다.
- 접선이나 접하는 원은 딱 한 점에서만 닿아야 합니다. 파고들거나 떨어지면 안 됩니다.
- 곡선이 축과 만나는 점, 극대·극소, 꼭짓점의 위치를 원본과 같게 맞추세요.
- 한 점에 여러 선이 모이면 모두 정확히 같은 자리에서 만나게 하고, 어떤 점이 선분
  위에 있으면 반드시 그 선분 위에 놓으세요.
- 축·원점 O·눈금 숫자·점근선·색칠된 영역이 있으면 원본대로 두세요.
- 라벨(A, B, P, O 등)은 그 점 바로 옆에 붙이고 서로 겹치지 않게 하세요.

장치도·모식도·단면도라면(실험 장치, 세포, 지층, 회로 등):
- 위치 관계를 원본과 똑같이 하세요: 무엇이 무엇의 위/아래/안/밖/왼쪽/오른쪽인지
  (지층 순서, 세포 속 소기관, 회로 연결 순서, 대기층 높이 등).
- 화살표 방향을 원본과 똑같이 하세요. 반대로 그리면 완전히 다른 자료가 됩니다.
- 선이나 관으로 이어진 것들은 원본과 똑같은 것끼리 이어지게 하세요.

색이 의미를 구분하고 있지 않으면 흰 배경에 검은 선으로 정리하세요.

결과는 배경이 흰색이고 선이 또렷한, 문제집 삽화 같은 그림이어야 합니다.
사진처럼 입체적으로 꾸미거나 그림자를 넣지 마세요(위에서 말한 "구분을 위한
명암 차이"는 예외입니다 — 그건 넣어야 합니다).`;

/**
 * **문제 전체**를 다시 그릴 때 쓰는 프롬프트.
 *
 * 그림 하나를 다시 그리는 것과 요구가 다르다. 그림은 "모양"이 맞아야 하지만
 * 문제 전체는 **글자가 한 자도 틀리면 안 된다** — "옳은/옳지 않은" 하나만
 * 바뀌어도 답이 뒤집히고, 사용자가 나중에 고칠 방법도 없다(결과가 이미지라
 * 본문 수정이 안 된다). 그래서 "그대로 옮겨 적기"를 반복해 못박는다.
 */
const WHOLE_PROBLEM_PROMPT = `이 이미지는 한국 고등학교 문제집(사회탐구·과학탐구)에 실린 **문제 한 개 전체**입니다.
사진을 깨끗한 인쇄물처럼 정서해 주세요. 내용은 무엇 하나 바꾸지 않습니다.

${ERASE_HANDWRITING}

그 다음으로 중요한 것 — 글자:
- 모든 글자를 원본에 적힌 **그대로** 옮기세요. 한 글자도 바꾸거나 다듬거나
  요약하거나 번역하지 마세요.
- "옳은 것"과 "옳지 않은 것", "있는 대로"와 "하나만" 같은 표현은 답을 뒤집습니다.
  원본 그대로 두세요.
- 숫자, 단위, 기호, 연도, 지명, 인명은 원본과 정확히 같아야 합니다.
- 읽기 어려운 글자가 있으면 지어내지 말고 원본의 획을 최대한 그대로 따라 그리세요.

${CIRCLED_CHARS}

구조도 그대로:
- 문제 번호, 발문, 조건 박스, 표, 자료, <보기>, 선지(①②③④⑤)를 원본과 같은
  순서·같은 배치로 두세요. 빼거나 새로 만들지 마세요.
- 표는 행·열 수와 칸 내용을 그대로 두고, 테두리를 또렷하게 그리세요.
- 그림·지도·그래프·모식도는 위치 관계, 화살표 방향, 개수를 그대로 두세요.
- 박스로 둘러싸인 부분은 박스를 유지하세요.

세부까지 살려서:
- 작은 표시를 빼지 마세요: 눈금과 눈금 숫자, 축 이름, 단위, 범례, 화살표 머리,
  점선과 실선의 구분, 각도 호, 직각 표시, 위·아래 첨자, 소수점, 괄호.
- 그래프·도형이 있으면 **만나는 점**이 가장 중요합니다. 두 선이 만나는 자리,
  곡선이 축과 만나는 점, 극대·극소, 접점을 원본과 같은 자리에 두고 양쪽 선이
  정확히 그 점을 지나게 하세요. 근처에서 어긋나거나 스치면 안 됩니다.
- 점 라벨(A, B, P, O 등)은 그 점 바로 옆에 붙이고 서로 겹치지 않게 하세요.

색과 명암(인쇄해서 푸는 자료입니다):
- 색으로만 구분된 것(지도의 지역, 그래프의 계열, 지층, 영역)은 **밝기 차이나
  무늬로도 구분되게** 하세요. 흑백으로 인쇄해도 어느 게 어느 것인지 알 수 있어야
  합니다. 진하기를 뚜렷하게 다르게 하거나 빗금·점무늬를 겹쳐 주세요.
- 색을 없애라는 뜻이 아닙니다. 원본의 색은 유지하되 명암 차이를 함께 주세요.
- 범례가 있으면 범례의 표시와 자료 속 표시를 똑같은 진하기·무늬로 맞추세요.
- 옅은 회색끼리, 비슷한 파스텔끼리 붙여 놓지 마세요. 경계선을 또렷하게 그으세요.

모양:
- 배경은 흰색, 글자는 검은색으로 또렷하게. 인쇄된 문제집 지면처럼 보이게 하세요.
- 글자 크기는 읽기 편하게 고르고, 줄이 겹치거나 잘리지 않게 하세요.`;

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
 * 원문자를 "안에 든 글자"로 풀어 준다. 모르는 글자면 null.
 *
 * 유니코드가 원문자를 **한 코드포인트**로 갖고 있어서 모델은 이걸 통글자로
 * 다루는데, 그러다 안쪽 글자가 바뀐다. 표를 직접 들고 있는 이유는
 * `String.normalize("NFKD")` 로는 원이 사라진 글자만 남을 뿐 "동그라미 안에
 * 무엇" 이라는 정보가 되지 않기 때문이다 — 우리는 그 문장을 만들어야 한다.
 */
function insideCircle(ch: string): string | null {
  const c = ch.codePointAt(0);
  if (c === undefined) return null;
  // ㉠~㉭ (동그라미 안 자음). ㄱ~ㅎ 구간(U+3131~)이 쌍자음·겹받침 때문에
  // 이어져 있지 않아서 표를 그대로 적는다.
  if (c >= 0x3260 && c <= 0x326d) return "ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ"[c - 0x3260];
  // ㉮~㉻ (동그라미 안 가나다)
  if (c >= 0x326e && c <= 0x327b) return "가나다라마바사아자차카타파하"[c - 0x326e];
  // ①~⑳
  if (c >= 0x2460 && c <= 0x2473) return String(c - 0x2460 + 1);
  // Ⓐ~Ⓩ / ⓐ~ⓩ
  if (c >= 0x24b6 && c <= 0x24cf) return String.fromCodePoint(0x41 + c - 0x24b6);
  if (c >= 0x24d0 && c <= 0x24e9) return String.fromCodePoint(0x61 + c - 0x24d0);
  return null;
}

/**
 * 참고 글에 실제로 나온 원문자만 골라 "㉠ = 동그라미 안 ㄱ" 표를 만든다.
 *
 * 프롬프트에 늘 적어 두는 일반 지시(CIRCLED_CHARS)와 별개로, **이 문제에 나온
 * 것만** 짚어 준다. 길게 적을수록 묻힌다는 걸 손글씨 지시에서 이미 겪었으므로,
 * 없으면 한 줄도 넣지 않는다.
 */
function circledNote(text: string): string {
  const seen: string[] = [];
  for (const ch of text) {
    if (insideCircle(ch) !== null && !seen.includes(ch)) seen.push(ch);
  }
  if (seen.length === 0) return "";
  // 나온 차례가 아니라 **원문자 차례**로 늘어놓는다. 본문이 "㉠~㉢" 처럼 범위로
  // 먼저 나오면 나온 차례는 ㉠ ㉢ ㉡ 이 되는데, 바로 아래에서 "순서를 뒤바꾸지
  // 말라"고 해 놓고 우리가 뒤바꾼 목록을 주는 꼴이 된다.
  seen.sort((a, b) => (a.codePointAt(0) ?? 0) - (b.codePointAt(0) ?? 0));
  const pairs = seen.map((ch) => `${ch}(동그라미 안에 ${insideCircle(ch)})`);
  return `
이 문제에는 원문자가 나옵니다: ${pairs.join(", ")}.
괄호 안에 적은 글자를 동그라미 안에 넣어 그리세요. 다른 글자로 바꾸거나 순서를
뒤바꾸지 마세요.`;
}

function withReference(prompt: string, reference: string): string {
  const text = reference.trim();
  if (!text) return prompt;
  return `${prompt}

참고 — 이 문제를 글자 인식기로 읽은 결과입니다(수식은 LaTeX 표기):
"""
${text}
"""
글자를 그릴 때 이 참고를 보고 **그대로 옮겨 적으세요.** 읽기 어려운 글자를
지어내는 것보다 이쪽이 정확합니다.
다만 참고도 틀릴 수 있습니다 — **사진과 어긋나면 사진이 맞습니다.** 참고에
없는 것(표·그림의 배치, 선지 기호, 줄 나눔)은 사진을 그대로 따르세요.
LaTeX 표기는 글자 그대로 쓰지 말고 **수식으로 그리세요**(예: \\frac{1}{2} 는
분수로).${circledNote(text)}`;
}

export async function generateFigureImage(
  imageDataUrl: string,
  modelId: string,
  mode: FigureMode = "figure",
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
      mode === "problem"
        ? withReference(WHOLE_PROBLEM_PROMPT, reference ?? "")
        : PROMPT,
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

