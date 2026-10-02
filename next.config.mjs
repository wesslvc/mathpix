/**
 * 바닥글 NEPICA 옆에 찍는 버전(`ver.261002.2053`). **빌드할 때(=배포할 때마다) 한국 시간으로 저절로 매긴다** —
 * 손으로 올리면 반드시 잊는다. `APP_VERSION` 환경변수를 주면 그 값을 그대로 쓴다.
 */
function buildVersion() {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `ver.${p(kst.getUTCFullYear() % 100)}${p(kst.getUTCMonth() + 1)}${p(kst.getUTCDate())}.${p(kst.getUTCHours())}${p(kst.getUTCMinutes())}`;
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: { NEXT_PUBLIC_APP_VERSION: buildVersion() },
  experimental: {
    /**
     * **뒤로 갈 때마다 다시 불러오던 것을 멈춘다.**
     *
     * App Router 는 클라이언트 라우터 캐시를 들고 있는데, 동적 화면(이 앱은
     * 전부 동적이다 — 쿠키로 로그인을 보므로)의 기본 유효기간이 **30초**다.
     * 그래서 실모에 들어갔다 30초 뒤에 뒤로 나오면 목록을 통째로 다시 받고,
     * 그동안 뼈대만 보인다("뒤로 갈 때는 여전히 로딩이 있다").
     *
     * 이미 봤던 화면으로 **돌아가는** 길이라 조금 묵은 값을 보여도 괜찮다.
     * 게다가 이 앱에서 목록을 바꾸는 동작(문제 추가·순서 변경·폴더 조작)은
     * 전부 `router.refresh()` 를 부르는데, 그건 **라우터 캐시를 통째로
     * 비운다** — 그래서 "바꿨는데 옛날 것이 보인다"가 생기지 않는다.
     */
    staleTimes: { dynamic: 120, static: 300 },
  },
  // `subset-font`(글꼴 올리기 관리자 페이지가 서버에서 쓴다)가 harfbuzz의
  // WASM 빌드를 불러온다. webpack5는 기본으로 WASM을 못 읽어서 켜 준다 —
  // 서버 전용 라우트에서만 쓰이므로 브라우저 번들에는 영향이 없다.
  webpack: (config) => {
    config.experiments = { ...config.experiments, asyncWebAssembly: true };
    return config;
  },
};

export default nextConfig;
