import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/siteMeta";

/**
 * `/sitemap.xml`.
 *
 * **공개된 화면만 싣는다.** 로그인해야 열리는 화면을 적어 두면 크롤러가
 * 가 봐야 `/login` 으로 튕기고, 구글 서치 콘솔에는 "색인 생성됨: 아니요"가
 * 잔뜩 쌓여 진짜 문제를 가린다.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  return [
    {
      url: base,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${base}/login`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.3,
    },
  ];
}
