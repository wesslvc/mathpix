import { NextRequest, NextResponse } from "next/server";
import { recognizeImage } from "@/lib/mathpixClient";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: { image?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "잘못된 요청 본문입니다." },
      { status: 400 },
    );
  }

  if (!body.image || typeof body.image !== "string") {
    return NextResponse.json(
      { error: "image(base64 data URL) 필드가 필요합니다." },
      { status: 400 },
    );
  }

  try {
    const result = await recognizeImage(body.image, {
      appId: process.env.MATHPIX_APP_ID,
      appKey: process.env.MATHPIX_APP_KEY,
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
