/**
 * 평가원 문제지 글꼴.
 *
 * **저장소에 넣지 않는다.** 수능 문제지에 쓰인 글꼴은 배포권이 우리에게 없다.
 * 그래서 파일은 Supabase 비공개 버킷(`kice-fonts`)에 두고, 로그인한 사용자만
 * 서버를 거쳐 받아 간다(`/api/kice/font/[file]`).
 *
 * 넣는 법: `node scripts/upload-kice-fonts.mjs <글꼴 폴더>`
 * (폴더에 아래 파일 이름 그대로 TTF 를 넣어 두면 된다).
 */

/** 틀이 지정한 글꼴 이름 → 버킷에 올려 둔 파일 이름. */
export const KICE_FONT_FILES: Record<string, string> = {
  "신그래픽체": "singraphic.ttf",
  "(환)디나루": "dinaru.ttf",
  "(환)견명조": "gyeonmyeongjo.ttf",
  "(환)태고딕": "taegothic.ttf",
  "(한)신중명조": "sinjungmyeongjo.ttf",
};

/**
 * 이름 목록만 필요한 화면(글꼴 올리기 페이지)이 쓴다.
 *
 * **`fontSubset.ts` 에서 가져오면 안 된다** — 그 파일은 `subset-font`
 * (harfbuzz WASM)를 불러오는데, 클라이언트 컴포넌트가 그걸 가져오면 웹팩이
 * WASM 을 브라우저 번들에 넣으려다 실패한다("WebAssembly module... not
 * flagged"). 자르는 일은 서버 라우트에서만 하고 화면은 이름만 안다.
 */
export const KICE_FONT_NAMES = Object.keys(KICE_FONT_FILES);

let cached: Promise<Record<string, Uint8Array>> | null = null;

export function loadKiceFonts(): Promise<Record<string, Uint8Array>> {
  cached ??= (async () => {
    const entries = await Promise.all(
      Object.entries(KICE_FONT_FILES).map(async ([name, file]) => {
        const res = await fetch(`/api/kice/font/${file}`, { cache: "force-cache" });
        if (!res.ok) {
          const reason =
            res.status === 404
              ? "글꼴 파일이 아직 올라가 있지 않습니다."
              : res.status === 401
                ? "로그인이 필요합니다."
                : `HTTP ${res.status}`;
          throw new Error(`평가원 양식 글꼴을 불러오지 못했습니다 — ${reason}`);
        }
        return [name, new Uint8Array(await res.arrayBuffer())] as const;
      }),
    );
    return Object.fromEntries(entries);
  })();
  // 한 번 실패하면 다음에 다시 받아 볼 수 있게 캐시를 비운다.
  cached.catch(() => {
    cached = null;
  });
  return cached;
}
