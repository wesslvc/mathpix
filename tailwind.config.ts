import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        serif: [
          "Nanum Myeongjo",
          "Noto Serif KR",
          "Batang",
          "serif",
        ],
      },
      colors: {
        // 구글 본문 색과 맞춘다(globals.css의 --g-text와 같은 값).
        ink: "#202124",
        gblue: "#1a73e8",
      },
    },
  },
  plugins: [],
};

export default config;
