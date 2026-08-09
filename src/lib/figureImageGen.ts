// 사과탐 자료를 **이미지 생성 모델**로 다시 그리는 계층.
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
 * 후보 이미지 생성 모델. 앞에서부터 쓰고 못 부르면 다음으로 내려간다.
 *
 * 2026-08 프로브에서 네 이름 모두 이 계정에 존재함을 확인했다(400은 프로브가
 * 보낸 이미지가 불량이어서 난 것이지 모델 문제가 아니었다 — models/route.ts의
 * TINY_PNG_BASE64 주석 참고). 사용자가 gpt-image-2를 쓰기로 정했고, 나머지는
 * 그게 막혔을 때를 위한 폴백이다.
 */
const DEFAULT_IMAGE_MODEL_IDS = [
  "gpt-image-2",
  "gpt-image-1.5",
  "gpt-image-1",
  "gpt-image-1-mini",
];

export function figureImageModelIds(): string[] {
  const raw = process.env.OPENAI_FIGURE_IMAGE_MODELS;
  if (!raw) return DEFAULT_IMAGE_MODEL_IDS;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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

const PROMPT = `이 이미지는 한국 고등학교 사회탐구/과학탐구 문제집에 실린 자료입니다.
이 자료를 인쇄해서 문제를 풀 수 있도록 깨끗하고 또렷하게 다시 그려주세요.

반드시 지켜주세요:
- 원본에 있는 모든 요소를 그대로 두세요. 무엇 하나 빼거나 새로 만들지 마세요.
- 글자(한글 라벨, 기호, 숫자, 단위)는 원본에 적힌 그대로 옮기세요. 다른 말로 바꾸거나
  번역하지 말고, 읽을 수 없는 글자는 지어내지 마세요.
- 위치 관계를 원본과 똑같이 하세요: 무엇이 무엇의 위/아래/안/밖/왼쪽/오른쪽인지
  (지층 순서, 세포 속 소기관, 회로 연결 순서, 대기층 높이 등).
- 화살표 방향을 원본과 똑같이 하세요. 반대로 그리면 완전히 다른 자료가 됩니다.
- 개수를 그대로 지키세요(눈금, 층, 입자, 칸, 화살표).
- 그래프라면 축 이름과 눈금 숫자, 곡선의 증가·감소와 최대·최소 위치, 곡선끼리
  만나는 지점을 원본과 같게 하세요.
- 색이 의미를 구분하고 있으면 그 구분을 유지하세요. 그렇지 않으면 흰 배경에
  검은 선으로 정리하세요.

결과는 배경이 흰색이고 선이 또렷한, 문제집 삽화 같은 그림이어야 합니다.
사진처럼 명암을 넣거나 입체적으로 꾸미지 마세요.`;

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
export async function generateFigureImage(
  imageDataUrl: string,
  modelId: string,
): Promise<FigureImageResult | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

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
    form.append("prompt", PROMPT);
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
