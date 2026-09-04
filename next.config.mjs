/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `subset-font`(글꼴 올리기 관리자 페이지가 서버에서 쓴다)가 harfbuzz의
  // WASM 빌드를 불러온다. webpack5는 기본으로 WASM을 못 읽어서 켜 준다 —
  // 서버 전용 라우트에서만 쓰이므로 브라우저 번들에는 영향이 없다.
  webpack: (config) => {
    config.experiments = { ...config.experiments, asyncWebAssembly: true };
    return config;
  },
};

export default nextConfig;
