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
 */
const PARAM_VARIANTS: Record<string, string>[] = [
  { size: "auto", input_fidelity: "high" },
  { size: "auto" },
  { input_fidelity: "high" },
  {},
];

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
분수로).`;
}

export async function generateFigureImage(
  imageDataUrl: string,
  modelId: string,
  mode: FigureMode = "figure",
  /** 문제 전체를 그릴 때 함께 주는 OCR 본문. 없으면 예전과 똑같이 동작한다. */
  reference?: string,
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

  for (let i = 0; i < order.length; i++) {
    const params = order[i];

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
        };
      }
    }
    console.error(
      `[figureImageGen] ${modelId} 응답에 이미지가 없음: ${JSON.stringify(json).slice(0, 1000)}`,
    );
    return null;
  }

  return { dataUrl: `data:image/png;base64,${b64}`, modelId };
}
