import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        // 본문·UI. globals.css 의 --font-sans 와 같은 값이어야 한다.
        sans: [
          "Pretendard",
          "Pretendard Variable",
          "Noto Sans KR",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "system-ui",
          "sans-serif",
        ],
        // 로고·이름표 같은 표시용 글자(지오글의 워드마크와 같은 글꼴).
        display: ["Space Grotesk", "Pretendard", "sans-serif"],
        serif: [
          "Nanum Myeongjo",
          "Noto Serif KR",
          "Batang",
          "serif",
        ],
      },
      colors: {
        // 브랜드 색(globals.css 의 --g-text · --g-blue 와 같은 값).
        // 지오글(seji)의 라이트 모드 팔레트에서 그대로 가져왔다.
        ink: "#191c21",
        gblue: "#2f74b8",
        // 로고 마크(물까치)에서 가져온 색. 강조가 필요한 자리에 쓴다.
        magpie: {
          cap: "#141518",
          wing: "#7ba9db",
          wingd: "#5b96d4",
          body: "#f2eddc",
          bark: "#d8c0a8",
        },

        // ── 기본 색 두 벌을 브랜드 색으로 덮어쓴다 ────────────────────────
        // 화면 곳곳에 `bg-blue-600`·`text-slate-500` 이 200군데 넘게 흩어져
        // 있다. 그것들을 하나씩 고치면 반드시 몇 개를 빠뜨리고, 그러면 같은
        // 파랑이 두 가지로 보인다. 색 자체를 여기서 한 번 갈아 끼우면 앱
        // 전체가 따라온다.
        //
        // blue-600 = #2f74b8 (지오글 라이트 모드의 강조색), blue-400 =
        // #7ba9db (물까치 날개색)에 맞춰 나머지 단계를 그 사이에 채웠다.
        blue: {
          50: "#f1f6fb",
          100: "#e4edf7",
          200: "#cfe0f1",
          300: "#a7c7e6",
          400: "#7ba9db",
          500: "#4a8cca",
          600: "#2f74b8",
          700: "#265f99",
          800: "#1e4c7c",
          900: "#17395c",
        },
        // 회색은 지오글의 라이트 모드 표면·글자색(#f6f7f9 · #eef1f5 ·
        // #e0e5ec · #646a74 · #191c21)을 봉우리로 삼아 이은 중립 회색이다.
        // Tailwind 기본 slate 는 푸른기가 돌아 위 파랑과 겹쳐 보였다.
        slate: {
          50: "#f6f7f9",
          100: "#eef1f5",
          200: "#e0e5ec",
          300: "#cbd2db",
          400: "#98a1ad",
          500: "#646a74",
          600: "#4e545d",
          700: "#3a3f47",
          800: "#272b31",
          900: "#191c21",
        },
      },
    },
  },
  plugins: [],
};

export default config;
