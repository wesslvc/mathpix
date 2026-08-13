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

/**
 * 문제 하나. `boxes` 가 둘 이상이면 **단을 넘어 이어진 문제**다.
 *
 * 모의고사 지면에서는 문제 하나가 왼쪽 단 아래에서 시작해 오른쪽 단 위로
 * 이어지는 경우가 흔하다. 그런 문제는 조각을 따로 잘라 세로로 이어 붙여야
 * 한 문제가 된다.
 */
export type DetectedProblem = { boxes: ProblemBox[] };

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/** 목록을 못 받았을 때 쓸 이름. */
const FALLBACK_MODEL = "gemini-flash-latest";

/**
 * 쓸 모델을 **계정의 실제 목록에서 고른다.**
 *
 * 이름을 지어내면 404 로 기능이 통째로 죽는다(모델 이름은 자주 바뀐다).
 * `GET /v1beta/models` 는 **무료**라 한 번 물어보고 고르는 편이 안전하다.
 * 이 저장소가 OpenAI 쪽에서 세운 원칙과 같다 — 추측하지 말고 물어본다.
 *
 * 다만 **고르는 건 한 번뿐이고 요청은 그 한 모델에만 나간다.** 실패했을 때
 * 조용히 다른 모델로 갈아타며 요금을 흘리는 짓은 하지 않는다(그래서 404 면
 * 캐시만 비우고 그대로 알린다).
 *
 * `GEMINI_DETECT_MODEL` 이 있으면 묻지 않고 그대로 쓴다.
 */
let picked: string | null = null;

function rank(name: string): number {
  // 버전이 높을수록 앞. `gemini-2.5-flash` → 2.5, `gemini-flash-latest` → 큰 값.
  if (/^gemini-flash-latest$/.test(name)) return 1000;
  const m = name.match(/gemini-(\d+(?:\.\d+)?)-flash/);
  return m ? Number(m[1]) : 0;
}

async function detectModel(key: string): Promise<string> {
  const fixed = process.env.GEMINI_DETECT_MODEL;
  if (fixed) return fixed;
  if (picked) return picked;
  try {
    const res = await fetch(`${ENDPOINT}?key=${key}`);
    if (!res.ok) return FALLBACK_MODEL;
    const json = (await res.json()) as {
      models?: { name?: string; supportedGenerationMethods?: string[] }[];
    };
    const names = (json.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m) => String(m.name ?? "").replace(/^models\//, ""))
      // 자리를 재는 일이라 flash 면 충분하다. 특수 목적 모델은 뺀다.
      .filter((n) => n.includes("flash"))
      .filter((n) => !/(lite|image|audio|tts|native|thinking|exp|preview)/.test(n));
    names.sort((a, b) => rank(b) - rank(a));
    picked = names[0] ?? FALLBACK_MODEL;
    return picked;
  } catch {
    return FALLBACK_MODEL;
  }
}

const PROMPT = `이 이미지는 한국 고등학교 문제집·모의고사 지면입니다.
**문제 한 개씩** 차지하는 영역을 모두 찾아 주세요.

한 문제의 영역에는 그 문제에 딸린 것이 전부 들어가야 합니다:
- 문제 번호(예: 12.)부터 시작해서
- 발문, 조건 박스, <보기>, 표·그래프·지도 같은 자료,
- 선지(①②③④⑤)의 마지막 줄까지.

영역은 **딱 맞게** 잡으세요:
- 내용의 바깥 경계(맨 위 글자의 위, 맨 아래 글자의 아래, 가장 왼쪽·오른쪽 끝)에
  **바짝 붙이세요.** 빈 여백을 넣지 마세요.
- 글자가 잘리지만 않을 정도로 아주 조금만 남기세요. 넉넉하게 잡지 마세요.
- 문제와 문제 사이의 빈 줄, 단 사이의 빈 공간, 종이 가장자리 여백은 넣지 마세요.
- 문제마다 하나씩, 서로 겹치지 않게 잡으세요.
- 지면에 단이 둘이면 왼쪽 단을 위에서 아래로 먼저, 그다음 오른쪽 단 순서로 두세요.
- 머리말, 쪽번호, 광고, 해설은 넣지 마세요.

**단을 넘어 이어진 문제**를 놓치지 마세요. 이게 가장 중요합니다:
- 새 문제는 **반드시 문제 번호로 시작합니다**(예: "12.").
- 그러니 어떤 덩어리가 **번호 없이** 그냥 글자나 선지(①②③④⑤)로 시작하면
  그건 새 문제가 아니라 **앞 문제의 나머지**입니다.
- 특히 오른쪽 단 맨 위가 번호 없이 시작하면, 왼쪽 단 맨 아래 문제가 거기로
  이어진 것입니다. 반대쪽 단으로 넘어간 겁니다.
- 그런 경우 **조각을 따로 하나씩** 잡되, no 에 **앞 조각과 같은 문제 번호**를
  적어 주세요(뒤 조각에 번호가 안 보여도 앞 조각의 번호를 그대로 적습니다).
  그래야 두 조각을 이어 붙여 한 문제로 만들 수 있습니다.
- 이어지는 조각의 영역도 여백 없이 딱 맞게 잡으세요 — 두 조각을 붙였을 때
  원래 한 문제였던 것처럼 이어져야 합니다.

결과는 JSON 배열로만 답하세요. 각 항목은
{"box_2d": [ymin, xmin, ymax, xmax], "no": "12"} 형식이고
좌표는 0~1000 으로 정규화한 값, no 는 문제 번호(숫자만)입니다.
번호를 알 수 없으면 no 를 빈 문자열로 두세요. 설명은 쓰지 마세요.`;

type GeminiBox = { box_2d?: unknown; no?: unknown; label?: unknown };

/** 응답에서 배열을 뽑아 0~1 좌표로 바꾼다. 모양이 이상한 항목은 버린다. */
function toBoxes(raw: unknown): (ProblemBox & { no: string })[] {
  if (!Array.isArray(raw)) return [];
  const out: (ProblemBox & { no: string })[] = [];
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
    // 번호는 숫자만 남긴다("12번", "12." 처럼 붙여 오는 경우가 있다).
    const no = String(item?.no ?? item?.label ?? "").replace(/[^0-9]/g, "");
    out.push({
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
      w: Math.min(w, 1 - Math.max(0, Math.min(1, x))),
      h: Math.min(h, 1 - Math.max(0, Math.min(1, y))),
      no,
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

/**
 * 같은 문제 번호를 단 조각들을 **한 문제로 묶는다.**
 *
 * 단을 넘어 이어진 문제는 조각이 왼쪽 단 맨 아래와 오른쪽 단 맨 위에 있어
 * 순서상 붙어 있지 않다. 번호로 묶으면 자리가 떨어져 있어도 하나가 된다.
 * 번호가 없는 조각은 묶을 근거가 없으므로 각각 한 문제로 둔다.
 *
 * 묶음의 순서는 **첫 조각이 나온 차례**다(자른 차례가 곧 문제 차례다).
 */
function group(boxes: (ProblemBox & { no: string })[]): DetectedProblem[] {
  const out: DetectedProblem[] = [];
  const byNo = new Map<string, DetectedProblem>();
  let prevColumn = -1;
  for (const { no, ...box } of boxes) {
    const column = box.x + box.w / 2 < 0.5 ? 0 : 1;
    const firstInColumn = column !== prevColumn;
    prevColumn = column;

    if (no) {
      const found = byNo.get(no);
      if (found) found.boxes.push(box);
      else {
        const made: DetectedProblem = { boxes: [box] };
        byNo.set(no, made);
        out.push(made);
      }
      continue;
    }
    // **번호가 없는 조각은 새 문제가 아니다.** 새 문제는 반드시 번호로
    // 시작하므로, 번호 없이 시작하는 덩어리는 앞 문제의 나머지다. 그런 일이
    // 생기는 자리는 **단이 바뀐 첫 덩어리**뿐이다(한 단 안에서는 문제가
    // 끊기지 않는다). 지면 맨 처음 조각은 앞 문제가 없으므로 그냥 둔다.
    if (firstInColumn && out.length > 0) {
      out[out.length - 1].boxes.push(box);
      continue;
    }
    out.push({ boxes: [box] });
  }
  return out;
}

export async function detectProblems(dataUrl: string): Promise<DetectedProblem[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new DetectError("GEMINI_API_KEY가 설정되지 않았습니다.", 500);
  }
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new DetectError("이미지를 읽을 수 없습니다.", 400);

  const model = await detectModel(key);
  const res = await fetch(`${ENDPOINT}/${model}:generateContent?key=${key}`, {
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
    // 404 면 골라 둔 이름이 낡은 것이다. 캐시만 비워 다음에 다시 고르게 하고,
    // 조용히 다른 모델로 갈아타지는 않는다(고른 적 없는 모델에 요금이 나간다).
    if (res.status === 404) picked = null;
    throw new DetectError(
      res.status === 404
        ? `모델 "${model}"을 찾을 수 없습니다. 다시 시도하거나 GEMINI_DETECT_MODEL 환경변수로 지정해 주세요.`
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
    return group(toBoxes(JSON.parse(text)));
  } catch {
    // 가끔 앞뒤에 설명을 붙여 준다. 배열만 도려내 다시 해 본다.
    const s = text.indexOf("[");
    const e = text.lastIndexOf("]");
    if (s === -1 || e <= s) throw new DetectError("영역을 읽지 못했습니다.", 502);
    try {
      return group(toBoxes(JSON.parse(text.slice(s, e + 1))));
    } catch {
      throw new DetectError("영역을 읽지 못했습니다.", 502);
    }
  }
}
