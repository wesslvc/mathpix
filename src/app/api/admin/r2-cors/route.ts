import { NextRequest, NextResponse } from "next/server";
import { requireFontAdmin } from "../kice-font/auth";
import { r2Configured, r2GetBucketCors, r2PutBucketCors } from "@/lib/r2";

/**
 * R2 버킷 CORS 를 보고·넣는다(무제한 계정 전용). 로그인한 브라우저로 `/api/admin/r2-cors` 를 열면 지금 값을,
 * `?apply=1` 을 붙이면 아래 주소들을 넣는다. API 토큰에 버킷 설정 권한이 없으면 403 이 그대로 보인다 — 그때는
 * Cloudflare 대시보드(R2 → 버킷 → Settings → CORS Policy)에서 `suggested` 값을 붙여 넣는다.
 */
export const dynamic = "force-dynamic";

const ORIGINS = [
  "https://reprintocr.vercel.app",
  "https://mathocr-liard.vercel.app",
  "https://mathocr-wesslvcs-projects.vercel.app",
  "https://mathocr-git-main-wesslvcs-projects.vercel.app",
  "http://localhost:3000",
];

const SUGGESTED = [
  {
    AllowedOrigins: ORIGINS,
    AllowedMethods: ["GET", "PUT", "HEAD"],
    AllowedHeaders: ["*"],
    ExposeHeaders: ["ETag"],
    MaxAgeSeconds: 86400,
  },
];

export async function GET(req: NextRequest) {
  const gate = await requireFontAdmin();
  if (!gate.ok) return gate.response;
  if (!r2Configured()) return NextResponse.json({ error: "R2가 설정되어 있지 않습니다." }, { status: 501 });
  try {
    if (req.nextUrl.searchParams.get("apply") === "1") {
      const put = await r2PutBucketCors(ORIGINS);
      const now = await r2GetBucketCors();
      return NextResponse.json({ applied: put.status < 300, put, now, suggested: SUGGESTED });
    }
    return NextResponse.json({ now: await r2GetBucketCors(), suggested: SUGGESTED });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err), suggested: SUGGESTED }, { status: 502 });
  }
}
