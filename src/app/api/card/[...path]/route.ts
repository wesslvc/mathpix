import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { r2Configured, r2Get } from "@/lib/r2";

/**
 * 저장된 카드 그림을 **우리 주소로** 내보낸다.
 *
 * 예전에는 화면이 Supabase 서명 URL 을 그대로 `<img src>` 에 넣었다. 그게
 * Supabase egress 의 거의 전부였고, 줄일 방법이 없었다 — **브라우저 캐시는
 * 주소로 걸리는데 `createSignedUrl` 은 부를 때마다 토큰이 다른 새 주소를
 * 준다.** 그래서 실모 화면에 들어갔다 나왔다 하거나 PDF 를 두 번 뽑으면
 * 같은 그림을 그때마다 통째로 다시 받았다(카드 PNG 평균 787kB × 문제 수).
 * 서명해 둔 주소를 잠깐 들고 있는 장치(`signedUrls.ts`, 지금은 지웠다)를 붙여 봤지만
 * **서버리스 인스턴스마다 따로 비어서** 적중률이 들쭉날쭉했다.
 *
 * 지금은 주소가 **경로 하나당 하나로 고정**이다. 경로에 uuid 가 들어 있고
 * 그림을 고칠 때마다 새 uuid 로 올리므로 같은 주소의 내용이 바뀌는 일이
 * 없다 — 그래서 `immutable` 로 1년을 준다. 두 번째부터는 요청 자체가 안 나가
 * Supabase egress 가 0 이다.
 *
 * **`private` 다.** 공개로 두면 Vercel CDN 이 대신 받아 줘서 egress 가 더
 * 줄지만, 그러려면 주소를 아는 사람 누구나 남의 문제지를 볼 수 있게 된다.
 * 캐시를 아끼자고 치를 값이 아니다 — 브라우저 캐시만으로도 **되풀이해서
 * 받는 것**(이게 대부분이다)은 사라진다.
 *
 * 인증은 두 겹이다: ① 로그인 세션이 있어야 하고 ② 경로의 첫 조각이 그
 * 사용자 id 여야 한다. 그리고 실제 내려받기도 사용자 토큰으로 하므로
 * 스토리지 RLS 가 그대로 한 번 더 건다.
 */
export const dynamic = "force-dynamic";

const BUCKET = "problem-images";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path: segments } = await params;
  const path = segments.join("/");

  let supabase;
  try {
    supabase = await createClient();
  } catch {
    return NextResponse.json({ error: "저장소가 설정되어 있지 않습니다." }, { status: 503 });
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  // 스토리지 경로의 첫 조각이 곧 소유자다(0001 마이그레이션의 RLS 정책과 같은
  // 규칙). 남의 경로를 받으면 내려받기 전에 끊는다.
  if (segments[0] !== user.id) {
    return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });
  }

  // **R2 를 먼저 본다.** 그림은 R2 로 옮겨 가는 중이라 두 곳에 나뉘어 있다 —
  // 여기서 한쪽씩 차례로 보면 이관이 끝나기 전에도 둘 다 정상으로 보인다.
  // R2 가 꺼져 있으면(환경변수 없음) 이 블록은 통째로 건너뛴다.
  if (r2Configured()) {
    try {
      const hit = await r2Get(path);
      if (hit) return imageResponse(hit.body, hit.headers.get("Content-Type"), path);
    } catch (err) {
      // R2 가 잠깐 안 되더라도 **그림이 안 뜨는 것보다는** Supabase 에서
      // 찾아보는 편이 낫다. 조용히 넘어가지는 않는다 — 로그에는 남긴다.
      console.error("[card] R2 읽기 실패, Supabase 로 넘어감:", err);
    }
  }

  let file = await supabase.storage.from(BUCKET).download(path);

  // **미리보기가 없으면 원본을 준다.** 옛 문제에는 `.thumb.webp` 가 없는데,
  // 그걸 화면이 미리 알아내려면 목록을 열 때마다 존재 확인을 한 번 더 해야
  // 한다. 여기서 대신 받아 주면 화면은 늘 미리보기 주소만 적으면 되고,
  // 미리보기가 생기는 순간(그 문제를 한 번 저장하면 생긴다) 저절로 작은
  // 그림으로 바뀐다.
  if (file.error && path.endsWith(".thumb.webp")) {
    // `thumbPathFor` 가 `.png` 를 떼고 `.thumb.webp` 를 붙이므로 되돌리는 것도
    // 그 반대로 한다(원본은 `.png` 하나뿐이다).
    const original = `${path.replace(/\.thumb\.webp$/, "")}.png`;
    if (r2Configured()) {
      try {
        const hit = await r2Get(original);
        if (hit) return imageResponse(hit.body, hit.headers.get("Content-Type"), path);
      } catch (err) {
        console.error("[card] R2 원본 읽기 실패:", err);
      }
    }
    file = await supabase.storage.from(BUCKET).download(original);
  }

  if (file.error || !file.data) {
    // **조용히 404 를 주면 안 된다.** 이걸 받는 쪽은 `<img>`(빈 자리로 보인다)
    // 와 번호 인식(그냥 "못 읽었어요"가 된다)이라, 여기서 안 남기면 그림이
    // 없는 것인지 인식이 안 되는 것인지 끝내 알 수 없다.
    console.error(`[card] 그림 없음: ${path} (r2=${r2Configured()}) ${file.error?.message ?? ""}`);
    return NextResponse.json({ error: "그림을 찾지 못했습니다." }, { status: 404 });
  }

  return imageResponse(file.data, file.data.type, path);
}

/** 어디서 왔든 **같은 헤더로** 내보낸다 — 캐시 규칙이 갈리면 안 된다. */
function imageResponse(
  body: BodyInit | null,
  contentType: string | null,
  path: string,
): NextResponse {
  return new NextResponse(body, {
    headers: {
      "Content-Type": contentType || "image/png",
      // 경로가 곧 내용이라(수정하면 새 uuid) 절대 안 바뀐다.
      "Cache-Control": "private, max-age=31536000, immutable",
      ETag: `"${path}"`,
    },
  });
}
