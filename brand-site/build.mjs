/**
 * 배포용 빌드 — 사이트 파일을 GitHub 에서 받아 dist/ 에 담는다.
 *
 * 왜 이렇게 하나: 이 사이트는 Vercel 에 **파일을 직접 올려** 배포한다(전용
 * 저장소를 만들 권한이 없었다 — GitHub App 이 403 을 준다). 그런데 그 방식은
 * 파일 내용을 배포 요청에 **글자로 실어** 보내야 해서, 사람이 옮겨 적는
 * 과정에서 **바이트가 조용히 어긋나는 사고**가 이 저장소에서 이미 났다
 * (CLAUDE.md 의 글꼴 업로드 대목 — 9476바이트가 9470바이트로 들어갔다).
 *
 * 그래서 옮겨 적는 것을 **한 글자도 두지 않는다.** 배포 요청에 실리는 것은
 * 이 파일과 package.json 뿐이고, 실제 사이트(HTML·CSS·그림)는 빌드할 때
 * 원본을 그대로 받아 온다. 받아 온 것은 결과물에 담기므로 배포가 끝난
 * 뒤에는 GitHub 가 필요 없다 — **다시 빌드할 때만** 아래 주소가 살아 있어야
 * 한다.
 *
 * **가지 이름이 아니라 커밋 해시로 못박는다.** 가지는 합쳐지고 나면
 * 지워지지만 커밋은 GitHub 에 SHA 로 남는다(이 저장소가 main 을 잃었다가
 * SHA 로 되살린 적이 있다 — CLAUDE.md 참고). 사이트를 고쳤으면 새 커밋의
 * 해시로 이 줄을 갱신하거나 SITE_BASE 환경변수로 덮어쓴다.
 */
import { mkdir, writeFile } from "node:fs/promises";

const BASE =
  process.env.SITE_BASE ??
  "https://raw.githubusercontent.com/wesslvc/mathpix/9aa618677c507c6701af2f0b23f305df4ae7d91b/brand-site";

const FILES = [
  "index.html",
  "style.css",
  "img/magpie.webp",
  "img/magpie-globe.webp",
  "img/magpie-paper.webp",
  "img/magpie-book.webp",
  "img/magpie-64.png",
  "img/og.jpg",
];

await mkdir("dist/img", { recursive: true });

for (const name of FILES) {
  const res = await fetch(`${BASE}/${name}`);
  if (!res.ok) {
    // 조용히 넘어가면 반쪽짜리 사이트가 배포된다 — 여기서 멈춘다.
    throw new Error(`${name}: HTTP ${res.status} (${BASE})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(`dist/${name}`, buf);
  console.log(`[build] ${name} ${buf.length}B`);
}

console.log("[build] done");
