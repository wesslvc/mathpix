/**
 * 배포용 빌드 — 마크 그림을 GitHub 에서 받아 dist/ 에 담는다.
 *
 * 왜 이렇게 하나: 이 사이트는 Vercel 에 **파일을 직접 올려** 배포한다(전용
 * 저장소를 만들 권한이 없었다). 그런데 그 방식은 파일 내용을 글자(base64)로
 * 실어 보내야 해서, 수십 KB 짜리 그림을 그대로 옮겨 적다가 **바이트가 조용히
 * 어긋나는 사고**가 이 저장소에서 이미 난 적이 있다(CLAUDE.md 의 글꼴 업로드
 * 대목). 그래서 글자로 옮겨 적는 것은 HTML·CSS 뿐이고, 그림은 빌드할 때
 * 원본 파일 그대로 받아 온다 — 옮겨 적을 게 없으니 어긋날 것도 없다.
 *
 * 받아 온 파일은 배포 결과물에 그대로 담기므로, 배포가 끝난 뒤에는 GitHub 가
 * 필요 없다. **다시 빌드할 때만** 아래 주소가 살아 있어야 한다.
 */
import { mkdir, writeFile } from "node:fs/promises";

// **가지 이름이 아니라 커밋 해시로 못박는다.** 가지는 합쳐지고 나면 지워지지만
// 커밋은 GitHub 에 SHA 로 남는다(이 저장소가 main 을 잃었다가 SHA 로 되살린
// 적이 있다 — CLAUDE.md 참고). 그림을 바꾸려면 새로 올린 커밋의 해시로 이
// 줄을 갱신하거나 ASSET_BASE 환경변수로 덮어쓴다.
const BASE =
  process.env.ASSET_BASE ??
  "https://raw.githubusercontent.com/wesslvc/mathpix/04926906f5b4130504429af75788a28ab7f4528d/brand-site/img";

const FILES = [
  "magpie.webp",
  "magpie-globe.webp",
  "magpie-paper.webp",
  "magpie-64.png",
  "og.jpg",
];

await mkdir("dist/img", { recursive: true });

for (const name of FILES) {
  const res = await fetch(`${BASE}/${name}`);
  if (!res.ok) {
    // 조용히 넘어가면 그림 없는 사이트가 배포된다 — 여기서 멈춘다.
    throw new Error(`${name}: HTTP ${res.status} (${BASE})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(`dist/img/${name}`, buf);
  console.log(`[build] ${name} ${buf.length}B`);
}

// HTML·CSS 는 배포 요청에 함께 실려 오므로 그대로 옮긴다.
for (const name of ["index.html", "style.css"]) {
  const { readFile } = await import("node:fs/promises");
  await writeFile(`dist/${name}`, await readFile(name));
}
console.log("[build] done");
