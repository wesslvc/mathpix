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
//
// **올리기 전에 글자 수를 확인한다.** 잘라 둔 글꼴에 없는 글자는 PDF 에
// **네모(⊠)로 찍히는데 오류는 나지 않는다** — 국어 틀을 만들었더니 머리말이
// `국⊠ 영역` 이 되었다(신그래픽체에 '국' 은 과목명 "한국지리" 때문에 들어
// 있었지만 '어' 는 어디에도 쓰이지 않아 빠져 있었다). 틀에 새 글자가 생길
// 때마다 되풀이되는 사고라, 필요한 글자를 여기서 미리 세어 본다.
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import fontkit from "@pdf-lib/fontkit";

/** 글꼴 이름 → 파일 이름. `src/lib/kice/fonts.ts` 의 표와 같아야 한다. */
const FONT_FILES = {
  "신그래픽체": "singraphic.ttf",
  "(환)디나루": "dinaru.ttf",
  "(환)견명조": "gyeonmyeongjo.ttf",
  "(환)태고딕": "taegothic.ttf",
  "(한)신중명조": "sinjungmyeongjo.ttf",
};
const FILES = Object.values(FONT_FILES);

/**
 * 틀에 박힌 글자 말고 **우리가 갈아 끼우는** 글자들. 틀에는 없으니 frames.json
 * 만 훑어서는 알 수 없는데, 없으면 그 자리가 네모가 된다.
 */
const EXTRA = {
  // 영역명·과목명은 신그래픽체로 그려진다(머리말과 표지 큰 제목).
  // **국어·영어 머리말은 여기 없다** — 글꼴에 '어' 가 없어서 그림으로 바꿨다
  // (`use-area-header-images.mjs`). '국' 은 과목명 "한국지리" 때문에 여전히 필요하다.
  "신그래픽체":
    "수학사회탐구과학탐구영역" +
    "생활과윤리사상한국지리세계동아시아사경제정치법문화" +
    "물리학Ⅰ화명생명과지구Ⅱ",
  // 정답표 머리글과 자리 표시. 답과 실모 제목은 사용자가 적는 것이라 여기에
  // 다 적을 수 없다 — 이 글꼴만은 **한글 전체**를 넣어 두는 편이 안전하다.
  "(한)신중명조": "번호정답①②③④⑤",
};

/** 잘라 둔 글꼴이 실제로 그 글자를 가졌는지 센다. */
function coverageReport(dir) {
  const framesPath = "public/kice/frames.json";
  const need = {};
  const add = (font, text) => {
    (need[font] ??= new Set());
    for (const c of text) if (c.trim()) need[font].add(c);
  };
  if (fs.existsSync(framesPath)) {
    const frames = JSON.parse(fs.readFileSync(framesPath, "utf8"));
    for (const set of Object.values(frames)) {
      for (const frame of Object.values(set)) {
        for (const it of frame.items) if (it.k === "text") add(it.font, it.t);
      }
    }
  }
  for (const [font, text] of Object.entries(EXTRA)) add(font, text);

  let bad = false;
  for (const [font, file] of Object.entries(FONT_FILES)) {
    const at = path.join(dir, file);
    if (!need[font]?.size || !fs.existsSync(at)) continue;
    let has;
    try {
      const f = fontkit.create(fs.readFileSync(at));
      has = (c) => f.hasGlyphForCodePoint(c.codePointAt(0));
    } catch {
      console.warn(`  ? ${file} — 글자 수를 세지 못했습니다(그냥 올립니다)`);
      continue;
    }
    const gone = [...need[font]].filter((c) => !has(c));
    if (gone.length) {
      bad = true;
      console.error(`  ✗ ${file} — 없는 글자 ${gone.length}자: ${gone.join(" ")}`);
    } else {
      console.log(`  ✓ ${file} — 필요한 ${need[font].size}자 모두 있음`);
    }
  }
  if (bad) {
    console.error(
      "\n없는 글자는 PDF 에 **네모(⊠)로 찍히고 오류는 나지 않습니다.**\n" +
        "pyftsubset 의 글자표를 넓혀 다시 자른 뒤 올리세요" +
        "(KS X 1001 한글 2350자를 통째로 넣는 편이 안전합니다).\n" +
        "그래도 올리려면 --force 를 붙이세요.\n",
    );
  }
  return !bad;
}

const args = process.argv.slice(2);
const force = args.includes("--force");
const dir = args.find((a) => !a.startsWith("--"));
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!dir || !url || !key) {
  console.error(
    "사용법: NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... " +
      "node scripts/upload-kice-fonts.mjs <글꼴 폴더>",
  );
  process.exit(1);
}

console.log("글자 수 확인:");
if (!coverageReport(dir) && !force) process.exit(1);

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
