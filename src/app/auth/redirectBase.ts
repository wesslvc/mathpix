import type { NextRequest } from "next/server";

/**
 * 리다이렉트에 쓸 **바깥에서 보이는** 주소를 만든다.
 *
 * `new URL(request.url).origin` 을 그대로 쓰면 안 된다. Vercel 같은 프록시
 * 뒤에서는 그 값이 내부 주소일 수 있어서, 확인을 마친 사용자가 엉뚱한 도메인
 * (또는 localhost)으로 튕긴다. 프록시가 붙여 주는 `x-forwarded-host` 가
 * 사용자가 실제로 보고 있는 도메인이다.
 */
export function redirectBase(request: NextRequest): string {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? url.host;
  const proto =
    request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}
