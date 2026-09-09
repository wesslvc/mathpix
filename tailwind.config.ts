import type { Config } from "tailwindcss";

/**
 * NEPICA 브랜드 팔레트.
 *
 * 값은 지어낸 것이 아니라 **형제 사이트에서 그대로 가져왔다** — 지오글
 * (`wesslvc/seji`, `css/main.css` 의 `:root`)이 물까치(Cyanopica cyanus)
 * 사진에서 뽑은 색이고, VDIC(`wesslvc/vdic`, `src/app/globals.css` 의
 * `@theme`)이 그것을 텐서 램프로 펴 둔 것이다. 두 저장소를 붙여 실제 파일을
 * 읽고 옮겼다(눈대중으로 비슷한 색을 고르지 않았다 — 이 저장소가 "정확한
 * 근거 없이 떠도는 값을 믿지 않는다"를 여러 번 데면서 배운 자리다).
 *
 * **클래스는 한 줄도 안 고치고 색 자체를 갈아 끼운다.** 화면 곳곳에
 * `bg-slate-50`·`text-blue-600` 이 **1,295곳**에 흩어져 있어(slate 725 ·
 * blue 226 · white 133 · amber 78 · red 67 · emerald 49 · violet 13)
 * 하나씩 고치면 반드시 몇 개를 빠뜨리고, 그러면 같은 회색이 두 가지로
 * 보인다. 램프만 갈아 끼우면 **한 곳도 안 빠뜨리고** 전부 브랜드 색이 된다.
 * VDIC 이 같은 판단을 적어 두었고 그 주석이 이 저장소를 선례로 들고 있다.
 *
 * 어느 계열을 어디에 대는지:
 *   slate   → 중립 회색. Tailwind 기본은 완전 무채색이라 파랑과 나란히 두면
 *             탁해 보인다. 지오글의 표면·글자색을 봉우리로 삼아 이은 램프다.
 *   blue    → 강조(물까치 날개색). 600 이 라이트 강조(`--ac`/`--btn`).
 *   emerald → 완료·정답(지오글 `--wr` 반대편의 초록 #81c995).
 *   red     → 오답(지오글 `--wr`: 라이트 #b3453c · 다크 #e08b83).
 *             쨍한 빨강보다 옅지만 틀린 것을 다그치는 화면이 아니다.
 *   amber   → 경고·즐겨찾기(지오글 `--gd`: 라이트 #9a7b3c · 다크 #d9b268).
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        /**
         * 본문·UI. Pretendard 를 첫머리에 둔다 — 지오글·VDIC 과 **같은 글꼴**
         * 이고, 같은 브랜드로 보이려면 색보다 글꼴이 먼저다. 실제 파일은
         * layout 에서 CDN 으로 받는다(구글 폰트가 아니라 next/font 로 못 받는다).
         */
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
        /** 로고·숫자 같은 표시용 글자(Space Grotesk). 지오글의 `--font-display`. */
        display: ["var(--font-space-grotesk)", "Pretendard", "sans-serif"],
        /** 문제 카드 본문. 인쇄물은 명조가 읽기 좋다 — 브랜드와 무관하게 유지. */
        serif: ["Nanum Myeongjo", "Noto Serif KR", "Batang", "serif"],
      },
      colors: {
        /** 본문 글자색. 지오글 라이트의 `--tx`. */
        ink: "#191c21",
        /** 강조. 지오글의 `--btn`(라이트·다크 공통). */
        gblue: "#2f74b8",

        slate: {
          50: "#f6f7f9",
          100: "#eef1f5",
          200: "#e0e5ec",
          300: "#cbd2db",
          400: "#98a1ad",
          500: "#646a74",
          600: "#4e545d",
          700: "#3a3f47",
          800: "#333944",
          900: "#1c2027",
          950: "#14171c",
        },
        blue: {
          50: "#f1f6fb",
          100: "#e4edf7",
          200: "#cfe0f1",
          300: "#a7c7e6",
          400: "#7fb2e6",
          500: "#4a8cca",
          600: "#2f74b8",
          700: "#265f99",
          800: "#1e4c7c",
          900: "#17395c",
          950: "#102840",
        },
        emerald: {
          50: "#eef7f1",
          100: "#d7ecdf",
          200: "#b3dcc2",
          300: "#97d0aa",
          400: "#81c995",
          500: "#5fae77",
          600: "#47905d",
          700: "#37714a",
          800: "#2a5539",
          900: "#1e3d29",
          950: "#14251b",
        },
        red: {
          50: "#fbf0ef",
          100: "#f6dedb",
          200: "#eebfb9",
          300: "#e6a49c",
          400: "#e08b83",
          500: "#cf6a60",
          600: "#b3453c",
          700: "#8f382f",
          800: "#6b2a24",
          900: "#4a1d19",
          950: "#2b1210",
        },
        amber: {
          50: "#faf5ea",
          100: "#f4e9d2",
          200: "#e9d3a5",
          300: "#e0c081",
          400: "#d9b268",
          500: "#c39a4e",
          600: "#9a7b3c",
          700: "#7b6230",
          800: "#5b4924",
          900: "#3f321a",
          950: "#241d0f",
        },
      },
      borderRadius: {
        /** 지오글이 열네 가지로 흩어져 있던 모서리를 다섯 단계로 모은 값. */
        xs: "6px",
        sm: "10px",
        md: "12px",
        lg: "16px",
      },
    },
  },
  plugins: [],
};

export default config;
