import { cardUrl } from "./cardUrl";

/**
 * 변형문제가 **어느 원본에서 왔는지**(`problems.box_range.variantOf`). 변형문제 만들기(`variant` 작업)가 적는다.
 * 같은 원본에서 나온 변형들은 `key` 가 같다 — 내보낼 때 "원본 → 그 변형들" 순서로 묶는 데 쓴다.
 * 이 파일에는 네트워크 호출도 환경변수도 없다(서버와 화면이 함께 읽는다).
 */
export type VariantOfInfo = {
  key: string;
  label: string;
  /** 원본 그림이 저장된 경로(`/api/card/…` 로 본다). */
  imageUrl: string;
  no?: number;
  /** 원본의 정답(sol 이 푼 것) — 없을 수 있다. */
  answer?: string;
};

export function readVariantOf(raw: unknown): VariantOfInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.key !== "string" || !v.key || typeof v.path !== "string" || !v.path) return null;
  if (v.path.includes("..")) return null;
  return {
    key: v.key.slice(0, 200),
    label: typeof v.label === "string" ? v.label.slice(0, 120) : "",
    imageUrl: cardUrl(v.path),
    ...(typeof v.no === "number" && v.no > 0 ? { no: v.no } : {}),
    ...(typeof v.answer === "string" && v.answer.trim() ? { answer: v.answer.trim().slice(0, 40) } : {}),
  };
}
