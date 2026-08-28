// 이미지 폴더 + 정답 CSV를 매칭해서 한 사용자 계정의 한 실모(카테고리)에
// 오답으로 올린다("연계교재" 문제은행처럼, 사진마다 정답이 CSV에 따로
// 매핑돼 있는 경우).
//
// 사용법:
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   node scripts/import-mapped-problems.mjs <이미지 폴더> <정답 CSV> \
//     <사용자 이메일> <폴더 이름> <실모 이름>
//
// CSV 컬럼(헤더 필수): 교재,단원,구분,문항번호,정답
//
// 이미지 파일명은 다음 두 형태 중 하나여야 한다(폴더 안의 실제 파일명을
// 그대로 파싱한다 — CSV에서 다시 만들어 맞추지 않는다. 자리표시 숫자
// 자릿수를 잘못 짐작해 어긋나는 것을 막기 위해서다):
//   {교재}_{단원(N강)}_{구분(2점|3점)}_{문항번호}번.png
//   {교재}_실전모의고사{N}회_{문항번호}번.png   (구분 없음)
//
// 조심한 것들:
// - **본문(text_content)을 채우지 않는다.** 이미지 하나가 곧 카드인
//   "통째로 다시 그리기"와 같은 모양으로 저장한다(box_range.figures에
//   그림을 넣고 text_content/latex는 null). 텍스트에 캡션을 넣으면
//   나중에 "수정" 화면이 본문으로 카드를 다시 그려서 그림이 사라지는
//   문제가 이 저장소에 실제로 있었다(storedFigures.ts 주석 참고) — 본문이
//   비어 있으면(isImageOnly) 그 경로 자체가 안 열린다.
// - figures 마크업은 원본 코드(rasterToSvg)와 정확히 같은 형태로 만든다 —
//   다른 형태로 저장하면 "수정" 화면의 readStoredFigures가 못 읽고
//   버린다(모양이 다르면 조용히 버리게 짜여 있다).
// - 실행 전에 CSV 95행 전부가 폴더의 파일과 정확히 1:1로 맞는지 먼저
//   검증하고, 하나라도 안 맞으면 아무것도 올리지 않고 멈춘다(부분
//   업로드가 되면 나중에 무엇이 이미 올라갔는지 알기 어렵다).
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const [, , imageDir, csvPath, email, folderName, categoryName] = process.argv;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!imageDir || !csvPath || !email || !folderName || !categoryName || !url || !key) {
  console.error(
    "사용법: NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... " +
      "node scripts/import-mapped-problems.mjs <이미지 폴더> <정답 CSV> <사용자 이메일> <폴더 이름> <실모 이름>",
  );
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

// ---------- CSV 읽기 ----------
function parseCsv(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",").map((c) => c.trim());
    const row = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

function normGubun(g) {
  if (g === "수능 2점 테스트") return "2점";
  if (g === "수능 3점 테스트") return "3점";
  return g.trim();
}

const csvRows = parseCsv(fs.readFileSync(csvPath, "utf8"));
const answerByKey = new Map(); // key -> { answer, order }
csvRows.forEach((row, i) => {
  const key = `${row["교재"]}|${row["단원"]}|${normGubun(row["구분"])}|${row["문항번호"]}`;
  answerByKey.set(key, { answer: row["정답"], order: i });
});

// ---------- 파일명 파싱 ----------
function parseFilename(filename) {
  const name = filename.replace(/\.png$/i, "");
  const parts = name.split("_");
  const textbook = parts[0];
  if (parts.length === 4) {
    const [, unitRaw, gubun, noRaw] = parts;
    const unitNum = unitRaw.match(/^0*(\d+)강$/);
    const noNum = noRaw.match(/^0*(\d+)번$/);
    if (!unitNum || !noNum) return null;
    return { key: `${textbook}|${unitNum[1]}강|${gubun}|${noNum[1]}` };
  }
  if (parts.length === 3) {
    const [, unitRaw, noRaw] = parts;
    const m = unitRaw.match(/^실전모의고사(\d+)회$/);
    const noNum = noRaw.match(/^0*(\d+)번$/);
    if (!m || !noNum) return null;
    return { key: `${textbook}|실전 모의고사 ${m[1]}회||${noNum[1]}` };
  }
  return null;
}

const files = fs.readdirSync(imageDir).filter((f) => /\.png$/i.test(f));

// ---------- 매칭 검증 (하나라도 어긋나면 아무것도 올리지 않는다) ----------
const plan = []; // { file, answer, order }
const problems = [];
for (const file of files) {
  const parsed = parseFilename(file);
  if (!parsed) {
    problems.push(`파일명을 못 읽었습니다: ${file}`);
    continue;
  }
  const hit = answerByKey.get(parsed.key);
  if (!hit) {
    problems.push(`CSV에 없는 조합입니다: ${file} (key=${parsed.key})`);
    continue;
  }
  plan.push({ file, answer: hit.answer, order: hit.order });
}
const usedOrders = new Set(plan.map((p) => p.order));
for (const [key, { order }] of answerByKey) {
  if (!usedOrders.has(order)) problems.push(`이 CSV 행에 맞는 파일이 없습니다: ${key}`);
}

console.log(`CSV 행 ${csvRows.length}개, 이미지 파일 ${files.length}개, 매칭 ${plan.length}개`);
if (problems.length > 0) {
  console.error(`\n검증 실패 — ${problems.length}건. 아무것도 올리지 않았습니다.`);
  for (const p of problems.slice(0, 30)) console.error("  - " + p);
  process.exit(1);
}
plan.sort((a, b) => a.order - b.order);
console.log("검증 통과 — CSV 순서대로 정렬해 업로드를 시작합니다.\n");

// ---------- 사용자 찾기 ----------
async function findUserByEmail(targetEmail) {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === targetEmail.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 200) break;
  }
  return null;
}

const user = await findUserByEmail(email);
if (!user) {
  console.error(`계정을 찾지 못했습니다: ${email}`);
  process.exit(1);
}
console.log(`사용자 확인: ${user.email} (${user.id})`);

// ---------- 폴더 찾거나 만들기 ----------
async function ensureFolder(userId, name) {
  const { data: existing, error: selErr } = await supabase
    .from("folders")
    .select("id")
    .eq("user_id", userId)
    .eq("name", name)
    .maybeSingle();
  if (selErr) throw selErr;
  if (existing) return existing.id;
  const { data: inserted, error: insErr } = await supabase
    .from("folders")
    .insert({ user_id: userId, name })
    .select("id")
    .single();
  if (insErr) throw insErr;
  return inserted.id;
}

const folderId = await ensureFolder(user.id, folderName);
console.log(`폴더 준비 완료: "${folderName}" (${folderId})`);

// ---------- 실모(카테고리) 찾거나 만들기 ----------
async function ensureCategory(userId, source, folderId) {
  const { data: existing, error: selErr } = await supabase
    .from("categories")
    .select("id")
    .eq("user_id", userId)
    .eq("source", source)
    .maybeSingle();
  if (selErr) throw selErr;
  if (existing) return existing.id;
  const { data: inserted, error: insErr } = await supabase
    .from("categories")
    .insert({ user_id: userId, source, is_exam: false, folder_id: folderId })
    .select("id")
    .single();
  if (insErr) throw insErr;
  return inserted.id;
}

const categoryId = await ensureCategory(user.id, categoryName, folderId);
console.log(`실모 준비 완료: "${categoryName}" (${categoryId})\n`);

// ---------- 문항 순서대로 업로드 ----------
function rasterToSvgDataUrl(buffer, width, height) {
  const dataUrl = `data:image/png;base64,${buffer.toString("base64")}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${width} ${height}">` +
    `<image href="${dataUrl}" xlink:href="${dataUrl}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet"/>` +
    `</svg>`
  );
}

// PNG 헤더에서 가로/세로만 읽는다(외부 이미지 라이브러리 없이).
function pngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const { data: maxRow } = await supabase
  .from("problems")
  .select("sort_order")
  .eq("category_id", categoryId)
  .order("sort_order", { ascending: false, nullsFirst: false })
  .limit(1)
  .maybeSingle();
let nextOrder = (maxRow?.sort_order ?? 0) + 1;

let ok = 0;
let failed = 0;
for (const item of plan) {
  const filePath = path.join(imageDir, item.file);
  const buffer = fs.readFileSync(filePath);
  const { width, height } = pngSize(buffer);
  const storagePath = `${user.id}/${categoryId}/${randomUUID()}.png`;

  const { error: upErr } = await supabase.storage
    .from("problem-images")
    .upload(storagePath, buffer, { contentType: "image/png" });
  if (upErr) {
    console.error(`✗ ${item.file} — 업로드 실패: ${upErr.message}`);
    failed++;
    continue;
  }

  const figureId = randomUUID();
  const { error: insErr } = await supabase.from("problems").insert({
    category_id: categoryId,
    user_id: user.id,
    image_path: storagePath,
    latex: null,
    text_content: null,
    answer: item.answer,
    answer_type: "choice",
    sort_order: nextOrder++,
    box_range: {
      ranges: [],
      fontPt: 15,
      figures: [
        {
          id: figureId,
          markup: rasterToSvgDataUrl(buffer, width, height),
          layout: { scale: 100, offsetX: 0, offsetY: 0 },
          position: 0,
        },
      ],
      number: null,
    },
  });
  if (insErr) {
    console.error(`✗ ${item.file} — 저장 실패: ${insErr.message}`);
    await supabase.storage.from("problem-images").remove([storagePath]);
    failed++;
    continue;
  }

  ok++;
  console.log(`✓ ${item.file} → 정답 ${item.answer}`);
}

console.log(`\n완료 — 성공 ${ok}개, 실패 ${failed}개.`);
if (failed > 0) process.exit(1);
