import { NextResponse } from "next/server";
import { KICE_FONT_FILES } from "@/lib/kice/fonts";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = new Set(Object.values(KICE_FONT_FILES));

/**
 * 평가원 양식 글꼴을 내려 준다.
 *
 * 글꼴 파일은 **저장소에 없다** — 배포권이 우리에게 없어서 공개 저장소에 담을
 * 수 없다. Supabase 비공개 버킷(`kice-fonts`)에 올려 두고 여기서 꺼내 준다.
 * 로그인한 사용자만 받을 수 있게 막아 두는 이유도 그것이다.
 *
 * 파일 이름은 **미리 정해 둔 목록에서만** 받는다. 그러지 않으면 이 길이 곧
 * 비공개 버킷 전체를 읽는 구멍이 된다(`../` 같은 것도 여기서 걸린다).
 */
export async function GET(_req: Request, { params }: { params: { file: string } }) {
  if (!ALLOWED.has(params.file)) {
    return NextResponse.json({ error: "알 수 없는 글꼴입니다." }, { status: 404 });
  }
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase가 설정되지 않았습니다." }, { status: 503 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const { data, error } = await supabase.storage.from("kice-fonts").download(params.file);
  if (error || !data) {
    return NextResponse.json(
      {
        error:
          "글꼴 파일이 없습니다. `node scripts/upload-kice-fonts.mjs <글꼴 폴더>` 로 올려 주세요.",
      },
      { status: 404 },
    );
  }

  return new NextResponse(await data.arrayBuffer(), {
    headers: {
      "Content-Type": "font/ttf",
      // 사용자마다 같은 파일이지만 로그인이 있어야 받을 수 있으므로 private.
      "Cache-Control": "private, max-age=86400",
    },
  });
}
