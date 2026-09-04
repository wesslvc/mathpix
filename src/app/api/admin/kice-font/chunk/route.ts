import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireFontAdmin } from "../auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 큰 원본 폰트를 조각내 보내므로 조각 자체는 가볍다. 넉넉히 잡는다.
export const maxDuration = 30;

/**
 * 원본 글꼴 조각 하나를 임시 자리에 올려 둔다.
 *
 * Vercel 요청 본문은 4.5MB로 막혀 있어(문제 영역 자동 찾기와 같은 제약),
 * 큰 원본 TTF는 조각을 내어 보낸다(`BulkMappedImportPanel`과 같은 방식).
 * `finish` 가 조각을 다시 이어 붙인다.
 *
 * **서비스 키를 쓴다** — 이 버킷엔 INSERT 정책이 없다(로그인한 사람 누구나
 * 평가원 글꼴을 새로 써넣을 수 있게 하면 안 된다). 그래서 관리자 확인
 * (`requireFontAdmin`)을 통과한 요청만 서비스 키로 대신 써 준다.
 */
export async function POST(req: NextRequest) {
  const gate = await requireFontAdmin();
  if (!gate.ok) return gate.response;

  const form = await req.formData();
  const uploadId = String(form.get("uploadId") ?? "");
  const index = Number(form.get("index"));
  const blob = form.get("chunk");
  if (!uploadId || !Number.isInteger(index) || index < 0 || !(blob instanceof Blob)) {
    return NextResponse.json({ error: "잘못된 조각입니다." }, { status: 400 });
  }
  // uploadId는 우리가 만든 값을 그대로 돌려받는 것이라 검증만 한다
  // (경로에 그대로 쓰이므로 `../` 같은 것을 막는다).
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(uploadId)) {
    return NextResponse.json({ error: "잘못된 업로드 id입니다." }, { status: 400 });
  }

  const admin = createAdminClient();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const { error } = await admin.storage
    .from("kice-fonts")
    .upload(`_tmp/${uploadId}/${index}`, bytes, { upsert: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
