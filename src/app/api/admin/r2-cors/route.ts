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

/**
 * 이 브라우저가 실제로 R2 와 직접 주고받는지는 버킷 설정을 읽는 것보다 이 쿠키가 정확하다 — 앱이 열릴 때 서명 주소로
 * 직접 받기·올리기를 해 보고 남긴 결과다(`r2Direct.ts`). 토큰에 버킷 설정 권한이 없어 위 값이 403 이어도 이게 "1" 이면 된다.
 */
function browserState(req: NextRequest): string {
  const v = req.cookies.get("r2d")?.value;
  if (v === "1") return "직접 연결 됨 (r2d=1) — 그림이 Vercel 을 거치지 않습니다";
  if (v === "0") return "직접 연결 안 됨 (r2d=0) — 1시간 뒤 다시 시험합니다(시크릿 창으로 바로 볼 수 있음)";
  return "아직 시험 전 — 앱 화면을 한 번 연 뒤 다시 보세요";
}

const TOKEN_NOTE =
  "403 은 API 토큰에 버킷 설정 권한이 없다는 뜻입니다(파일 읽기·쓰기만 됨). 대시보드에서 CORS 를 넣었다면 무시하고 browser 값을 보세요.";

export async function GET(req: NextRequest) {
  const gate = await requireFontAdmin();
  if (!gate.ok) return gate.response;
  if (!r2Configured()) return NextResponse.json({ error: "R2가 설정되어 있지 않습니다." }, { status: 501 });
  const browser = browserState(req);
  try {
    if (req.nextUrl.searchParams.get("apply") === "1") {
      const put = await r2PutBucketCors(ORIGINS);
      const now = await r2GetBucketCors();
      const note = put.status === 403 ? TOKEN_NOTE : undefined;
      return NextResponse.json({ browser, applied: put.status < 300, note, put, now, suggested: SUGGESTED });
    }
    const now = await r2GetBucketCors();
    const note = now.status === 403 ? TOKEN_NOTE : undefined;
    return NextResponse.json({ browser, note, now, suggested: SUGGESTED });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err), suggested: SUGGESTED }, { status: 502 });
  }
}
