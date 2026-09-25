/**
 * 지문 **1차 글자 읽기**를 부른다(브라우저 쪽). 예전에는 이 자리가 `/api/mathpix`
 * 였다 — 지금은 GPT 가 글자만 한 자씩 옮겨 적는다(`transcribeKoreanPassage`).
 *
 * 국어 모드(`KoreanModePanel`)와 저장된 지문 다시 인식(`ProblemGallery`)이 이
 * 함수 하나를 같이 쓴다 — 두 길이 서로 다른 인식기를 쓰면 같은 지문이 넣을 때와
 * 고칠 때 다르게 나온다.
 */
export type PassageTranscript = {
  text: string;
  /** 실제로 읽은 모델. 화면에 그대로 적는다. */
  model?: string;
  /** 일반 계정에 보여 줄 차감 토큰. */
  chargedTokens?: number;
  /** 무제한 계정에만 오는 원가(원). */
  costKrw?: number;
};

export async function transcribePassage(image: string): Promise<PassageTranscript> {
  const res = await fetch("/api/korean-text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image, task: "transcribe" }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    text?: string;
    model?: string;
    chargedTokens?: number | null;
    usage?: { estKrw?: number };
    error?: string;
  };
  if (!res.ok) throw new Error(json.error ?? "지문 글자를 읽지 못했습니다.");
  const text = (json.text ?? "").trim();
  if (text.length < 20) throw new Error("지문 글자가 거의 읽히지 않았습니다.");
  return {
    text,
    model: json.model,
    chargedTokens: typeof json.chargedTokens === "number" ? json.chargedTokens : undefined,
    costKrw: json.usage?.estKrw,
  };
}
