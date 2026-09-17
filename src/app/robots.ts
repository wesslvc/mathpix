import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/siteMeta";

/**
 * `/robots.txt` 를 만든다(Next 가 이 파일을 보고 자동으로 내보낸다).
 *
 * **앱 안쪽은 막는다.** 로그인해야 열리는 화면들(`/categories`·`/grades`·
 * `/profile`·`/export`·`/admin`)은 크롤러가 긁어 봐야 전부 `/login` 으로
 * 튕긴다 — 색인에는 아무 도움이 안 되면서 크롤 예산만 쓴다. `/api` 는
 * 애초에 사람이 볼 화면이 아니다.
 *
 * 공개해 둘 것은 소개 화면(`/`)과 로그인 화면(`/login`) 둘뿐이다.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/api/",
        "/admin/",
        "/auth/",
        "/categories/",
        "/export",
        "/grade",
        "/grades",
        "/profile",
        "/answer-sheet",
      ],
    },
    sitemap: `${siteUrl()}/sitemap.xml`,
    host: siteUrl(),
  };
}
