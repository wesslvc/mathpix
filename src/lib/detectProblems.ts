/**
 * 한 장에 여러 문제가 있는 지면에서 **문제마다의 영역**을 찾아낸다.
 *
 * Gemini 는 이미지에서 물체의 자리를 `box_2d`(0~1000 으로 정규화된
 * `[ymin, xmin, ymax, xmax]`)로 돌려주도록 되어 있다. 문제 하나를 "물체"로
 * 보고 그 규격을 그대로 쓴다.
 *
 * **왜 Gemini 인가:** 이건 그림을 만드는 일이 아니라 **자리를 재는** 일이라
 * 값이 싸고 빠른 쪽이 맞다(이미지 생성 모델에 시킬 일이 아니다). 결과가
 * 좌표뿐이라 틀려도 사용자가 눈으로 보고 지우면 그만이다.
 */

/** 0~1 로 정규화된 영역. 왼쪽 위가 (0,0). */
export type ProblemBox = { x: number; y: number; w: number; h: number };

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * 쓸 모델. 이름을 **추측하지 않는다** — 기본값이 안 되면 환경변수로 바꾼다.
 * 실패했을 때 조용히 다른 모델로 갈아타지 않는 것도 이 저장소의 원칙이다
 * (고른 적 없는 모델에 요금이 나간 적이 있다).
 */
export const DETECT_MODEL = process.env.GEMINI_DETECT_MODEL ?? "gemini-flash-latest";

const PROMPT = `이 이미지는 한국 고등학교 문제집·모의고사 지면입니다.
**문제 한 개씩** 차지하는 영역을 모두 찾아 주세요.

한 문제의 영역에는 그 문제에 딸린 것이 전부 들어가야 합니다:
- 문제 번호(예: 12.)부터 시작해서
- 발문, 조건 박스, <보기>, 표·그래프·지도 같은 자료,
- 선지(①②③④⑤)의 마지막 줄까지.

지켜 주세요:
- 문제마다 하나씩, 서로 겹치지 않게 잡으세요.
- 지면에 단이 둘이면 왼쪽 단을 위에서 아래로 먼저, 그다음 오른쪽 단 순서로 두세요.
- 머리말, 쪽번호, 여백, 광고, 해설은 넣지 마세요.
- 잘려서 일부만 보이는 문제도 보이는 만큼 잡으세요.
- 글자가 잘리지 않게 사방으로 조금 넉넉하게 잡으세요.

결과는 JSON 배열로만 답하세요. 각 항목은
{"box_2d": [ymin, xmin, ymax, xmax], "label": "12번"} 형식이고
좌표는 0~1000 으로 정규화한 값입니다. 설명은 쓰지 마세요.`;

type GeminiBox = { box_2d?: unknown; label?: unknown };

/** 응답에서 배열을 뽑아 0~1 좌표로 바꾼다. 모양이 이상한 항목은 버린다. */
function toBoxes(raw: unknown): ProblemBox[] {
  if (!Array.isArray(raw)) return [];
  const out: ProblemBox[] = [];
  for (const item of raw as GeminiBox[]) {
    const b = item?.box_2d;
    if (!Array.isArray(b) || b.length !== 4) continue;
    const [ymin, xmin, ymax, xmax] = b.map((n) => Number(n));
    if (![ymin, xmin, ymax, xmax].every(Number.isFinite)) continue;
    const x = Math.min(xmin, xmax) / 1000;
    const y = Math.min(ymin, ymax) / 1000;
    const w = Math.abs(xmax - xmin) / 1000;
    const h = Math.abs(ymax - ymin) / 1000;
    // 너무 작은 것은 문제가 아니라 부스러기다(쪽번호·머리말 조각 등).
    if (w < 0.05 || h < 0.03) continue;
    out.push({
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
      w: Math.min(w, 1 - Math.max(0, Math.min(1, x))),
      h: Math.min(h, 1 - Math.max(0, Math.min(1, y))),
    });
  }
  // 왼쪽 단 → 오른쪽 단, 각 단에서는 위에서 아래로. 모델이 순서를 지키지
  // 않는 경우가 있어 우리가 한 번 더 정렬한다(자른 결과가 문제 순서다).
  const mid = 0.5;
  return out.sort((a, b) => {
    const ca = a.x + a.w / 2 < mid ? 0 : 1;
    const cb = b.x + b.w / 2 < mid ? 0 : 1;
    return ca !== cb ? ca - cb : a.y - b.y;
  });
}

export class DetectError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DetectError";
  }
}

export async function detectProblemBoxes(dataUrl: string): Promise<ProblemBox[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new DetectError("GEMINI_API_KEY가 설정되지 않았습니다.", 500);
  }
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new DetectError("이미지를 읽을 수 없습니다.", 400);

  const res = await fetch(`${ENDPOINT}/${DETECT_MODEL}:generateContent?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inline_data: { mime_type: m[1], data: m[2] } },
            { text: PROMPT },
          ],
        },
      ],
      // 자리를 재는 일이라 매번 같은 답이 나와야 한다.
      generationConfig: { responseMimeType: "application/json", temperature: 0 },
    }),
  });

  const body = await res.text();
  if (!res.ok) {
    // 모델 이름이 틀리면 404 다. 조용히 다른 모델로 갈아타지 않고 그대로 알린다.
    throw new DetectError(
      res.status === 404
        ? `모델 "${DETECT_MODEL}"을 찾을 수 없습니다. GEMINI_DETECT_MODEL 환경변수로 바꿔 주세요.`
        : `문제 영역 인식에 실패했습니다 (HTTP ${res.status}).`,
      res.status,
    );
  }

  let text: string;
  try {
    const json = JSON.parse(body);
    text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  } catch {
    throw new DetectError("모델이 정상적인 응답을 주지 않았습니다.", 502);
  }
  try {
    return toBoxes(JSON.parse(text));
  } catch {
    // 가끔 앞뒤에 설명을 붙여 준다. 배열만 도려내 다시 해 본다.
    const s = text.indexOf("[");
    const e = text.lastIndexOf("]");
    if (s === -1 || e <= s) throw new DetectError("영역을 읽지 못했습니다.", 502);
    try {
      return toBoxes(JSON.parse(text.slice(s, e + 1)));
    } catch {
      throw new DetectError("영역을 읽지 못했습니다.", 502);
    }
  }
}
