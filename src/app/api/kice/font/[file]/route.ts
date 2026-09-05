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

  /**
   * **먼저 메타데이터만 본다 — 내려받지 않는다.**
   *
   * 예전에는 무조건 `download()` 부터 하고 그 바이트로 ETag 를 만들었다.
   * 그러면 브라우저가 304 를 받아 한 글자도 안 쓰는 경우에도 **Supabase
   * 에서 우리 서버로는 파일이 통째로 나온다** — 그게 곧 Supabase egress 다.
   * 글꼴 다섯 벌이면 PDF 한 번 뽑을 때마다 4MB 넘게 새고 있었고, 무료 요금제
   * 한도가 한 달 5GB 라 이것만으로도 상당한 몫이었다(`(한)신중명조` 에 한자를
   * 넣으며 1.13MB → 3.27MB 로 커져서 더 나빠졌다).
   *
   * `list()` 는 파일 목록(JSON)만 받아 오므로 사실상 공짜고, 그 안에
   * **저장소가 들고 있는 eTag**(내용 해시)가 들어 있다. 그걸로 304 를
   * 판정하면 **안 바뀐 글꼴은 Supabase 에서 한 바이트도 안 나온다.**
   */
  const { data: listed } = await supabase.storage
    .from("kice-fonts")
    .list("", { limit: 100, search: params.file });
  const meta = listed?.find((o) => o.name === params.file);
  const rawTag =
    (meta?.metadata as { eTag?: string } | undefined)?.eTag ?? meta?.updated_at;
  // 저장소가 주는 eTag 는 따옴표가 붙어 오기도 한다 — 한 겹으로 맞춘다.
  const etag = rawTag ? `"${String(rawTag).replace(/^"|"$/g, "")}"` : null;
  const headers = {
    "Content-Type": "font/ttf",
    // 사용자마다 같은 파일이지만 로그인이 있어야 받을 수 있으므로 private.
    // `must-revalidate` 로 "쓰기 전에 반드시 물어보라"를 못박는다.
    "Cache-Control": "private, no-cache, must-revalidate",
    ...(etag ? { ETag: etag } : {}),
  };

  if (etag && req.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers });
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
   * 메타데이터에 eTag 가 없는 저장소면(옛 파일 등) 그때만 내용으로 만든다.
   * 이 경우는 어차피 내려받은 뒤라 추가 비용이 없다.
   */
  const finalHeaders = etag
    ? headers
    : {
        ...headers,
        ETag: `"${createHash("sha256").update(bytes).digest("base64url").slice(0, 27)}"`,
      };

  if (
    !etag &&
    req.headers.get("if-none-match") ===
      (finalHeaders as Record<string, string>).ETag
  ) {
    return new NextResponse(null, { status: 304, headers: finalHeaders });
  }

  return new NextResponse(bytes, { headers: finalHeaders });
}
