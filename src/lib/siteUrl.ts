/**
 * 확인 메일 링크가 돌아올 **대표 주소**.
 *
 * 예전에는 `window.location.origin` 을 그대로 썼다. 그런데 이 앱은 도메인이
 * 넷이다(`reprintocr` / `mathocr-liard` / `mathocr-wesslvcs-projects` /
 * `mathocr-git-main-...`). 접속한 도메인마다 `emailRedirectTo` 가 달라지므로
 * **네 개를 전부 허용목록에 넣어 두지 않으면** Supabase 가 조용히 Site URL 로
 * 떨어뜨린다 — 사용자는 확인 링크를 눌렀는데 아무 일도 안 일어난 것처럼 보인다.
 * (실제 로그에서 이 실패를 확인했다. 코드는 발급됐는데 교환은 한 번도 일어나지
 * 않았고, 그 요청들의 도착지가 전부 Site URL 이었다.)
 *
 * `NEXT_PUBLIC_SITE_URL` 을 정해 두면 **어느 도메인에서 가입하든 한 곳으로**
 * 돌아오므로 허용목록에 한 줄만 있으면 된다.
 *
 * **localhost 는 예외다.** 개발 중에 가입했는데 확인 링크가 운영 도메인으로
 * 가면 그 자리에서 확인을 못 한다. 로컬에서는 늘 지금 보고 있는 주소를 쓴다.
 */
export function authRedirectOrigin(): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!configured) return origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin)) return origin;
  return configured.replace(/\/+$/, "");
}

/** 가입·재발송이 함께 쓰는 확인 링크 주소. */
export function emailConfirmRedirect(): string {
  return `${authRedirectOrigin()}/auth/callback`;
}
