// 평가원 양식 글꼴을 Supabase 비공개 버킷(`kice-fonts`)에 올린다.
//
// 글꼴 파일은 배포권이 우리에게 없어서 저장소에 커밋하지 않는다. 대신 한 번
// 올려 두면 로그인한 사용자가 `/api/kice/font/[file]` 로 받아 간다.
//
// 사용법:
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   node scripts/upload-kice-fonts.mjs <글꼴 폴더>
//
// 폴더에 아래 이름 그대로 TTF 를 넣어 두면 된다. 이름이 다르면 올라가지 않는다.
//
// **잘라 둔(subset) 파일을 올릴 것.** 원본 TTF 는 한 벌에 수 MB 라 브라우저가
// 다섯 벌을 받는 데만 한참 걸린다. KS X 1001 한글 2350 자 + 라틴/기호만 남기면
// 다섯 벌 합쳐 2MB 아래로 떨어진다:
//   pyftsubset <원본.ttf> --output-file=<이름>.ttf --unicodes-file=<글자표> \
//     --layout-features='*' --no-hinting
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const FILES = [
  "singraphic.ttf",
  "dinaru.ttf",
  "gyeonmyeongjo.ttf",
  "taegothic.ttf",
  "sinjungmyeongjo.ttf",
];

const dir = process.argv[2];
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!dir || !url || !key) {
  console.error(
    "사용법: NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... " +
      "node scripts/upload-kice-fonts.mjs <글꼴 폴더>",
  );
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

// 버킷이 없으면 만든다(마이그레이션을 안 돌렸어도 여기서 살아난다).
const { error: bucketError } = await supabase.storage.createBucket("kice-fonts", {
  public: false,
});
if (bucketError && !/exists/i.test(bucketError.message)) {
  console.error("버킷을 만들지 못했습니다:", bucketError.message);
  process.exit(1);
}

let failed = false;
for (const file of FILES) {
  const at = path.join(dir, file);
  if (!fs.existsSync(at)) {
    console.error(`✗ ${file} — 폴더에 없습니다`);
    failed = true;
    continue;
  }
  const body = fs.readFileSync(at);
  const { error } = await supabase.storage
    .from("kice-fonts")
    .upload(file, body, { contentType: "font/ttf", upsert: true });
  if (error) {
    console.error(`✗ ${file} — ${error.message}`);
    failed = true;
  } else {
    console.log(`✓ ${file} (${(body.length / 1024) | 0}KB)`);
  }
}

process.exit(failed ? 1 : 0);
