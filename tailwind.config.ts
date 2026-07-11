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
        ink: "#1a1d29",
      },
    },
  },
  plugins: [],
};

export default config;
