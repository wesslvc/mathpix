import { redirect } from "next/navigation";

/**
 * 채점 기록 목록은 /profile 로 합쳤다 — 추세(요약)와 기록(개별 시행)을
 * 한 화면에서 같이 볼 수 있게 하려는 것이다. 옛 링크·북마크가 깨지지
 * 않도록 이 경로는 남겨 두고 그냥 넘긴다.
 */
export default function GradesPage() {
  redirect("/profile");
}
