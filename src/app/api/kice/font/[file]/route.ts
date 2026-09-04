import { createHash } from "node:crypto";
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
export async function GET(req: Request, { params }: { params: { file: string } }) {
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

  const bytes = new Uint8Array(await data.arrayBuffer());

  /**
   * **ETag 를 붙인다 — 이게 없어서 "느리거나 깨지거나" 둘 중 하나였다.**
   *
   * 예전에는 검증자(ETag/Last-Modified)를 하나도 안 보내면서
   * `Cache-Control: max-age=86400` 만 보냈다. 그래서 화면 쪽은 두 가지
   * 나쁜 선택지밖에 없었다 — `force-cache` 로 받으면 **글꼴을 고쳐 올려도
   * 24시간 동안 깨진 옛 사본을 계속 쓰고**(실제로 `(한)신중명조` 사고가
   * 이렇게 재발했다), 그게 무서워 `no-cache` 로 바꾸면 검증할 방법이 없어
   * **매번 통째로 다시 받는다**(다섯 벌 합쳐 1MB 넘는다 — 내보내기 화면을
   * 열 때마다 휴대폰에서 몇 초씩 걸렸다).
   *
   * 내용으로 만든 ETag 를 붙이면 그 딜레마가 사라진다. `no-cache` 는 원래
   * "캐시에 두되 쓰기 전에 반드시 확인하라"는 뜻이라, 검증자만 있으면
   * **안 바뀌었을 때 본문 없는 304** 로 끝난다. 글꼴을 다시 잘라 올리면
   * 내용이 달라져 ETag 도 달라지므로 그 순간 새 파일을 받는다 — 빠르면서
   * 절대 낡지 않는다.
   */
  const etag = `"${createHash("sha256").update(bytes).digest("base64url").slice(0, 27)}"`;
  const headers = {
    "Content-Type": "font/ttf",
    // 사용자마다 같은 파일이지만 로그인이 있어야 받을 수 있으므로 private.
    // `must-revalidate` 로 "쓰기 전에 반드시 물어보라"를 못박는다.
    "Cache-Control": "private, no-cache, must-revalidate",
    ETag: etag,
  };

  if (req.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers });
  }

  return new NextResponse(bytes, { headers });
}
