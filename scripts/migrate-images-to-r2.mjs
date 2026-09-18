// Supabase Storage(`problem-images` 버킷)에 남아 있는 그림을 Cloudflare R2로
// 복사한다. 새 그림은 이미 R2로 가고 있고(`src/lib/blobClient.ts`), 읽는 쪽
// (`/api/card`)도 R2를 먼저 보고 없으면 Supabase로 내려가게 짜여 있다 — 그래서
// **DB는 한 글자도 건드릴 필요가 없다**. 경로 문자열이 그대로 키가 되므로,
// 같은 경로로 바이트만 옮기면 화면은 어느 쪽에서 왔든 똑같이 보인다.
//
// 사용법:
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=... \
//   node scripts/migrate-images-to-r2.mjs [--delete]
//
// 넷 다 Vercel의 `mathocr` 프로젝트 환경변수에 이미 들어 있는 값을 그대로
// 복사해 오면 된다(`src/lib/r2.ts`가 쓰는 것과 같은 이름).
//
// **`--delete`를 주지 않으면 Supabase 원본은 절대 지우지 않는다.** 복사만
// 하고 개수·용량을 맞춰 보여 준다 — 눈으로 확인한 뒤 다시 `--delete`를 붙여
// 한 번 더 돌리면, 그때는 **R2에 같은 크기로 이미 올라가 있는 것만** 지운다
// (크기가 안 맞거나 아직 없는 것은 절대 안 건드린다).
//
// **재실행해도 안전하다.** R2에 이미 같은 크기로 올라가 있으면 건너뛴다 —
// 중간에 끊겨도 처음부터 다시 돌리면 남은 것부터 이어진다.
//
// **다시 인코딩하지 않는다.** 받은 바이트를 그대로, Content-Type도 그대로
// 올린다 — 화질이 상할 이유가 없다.

import { createClient } from "@supabase/supabase-js";
import { AwsClient } from "aws4fetch";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;
const DO_DELETE = process.argv.includes("--delete");

if (
  !SUPABASE_URL ||
  !SUPABASE_KEY ||
  !R2_ACCOUNT_ID ||
  !R2_ACCESS_KEY_ID ||
  !R2_SECRET_ACCESS_KEY ||
  !R2_BUCKET
) {
  console.error(
    "사용법: NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... " +
      "R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=... " +
      "node scripts/migrate-images-to-r2.mjs [--delete]",
  );
  process.exit(1);
}

const BUCKET = "problem-images";
const CONCURRENCY = 6;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});
const aws = new AwsClient({
  accessKeyId: R2_ACCESS_KEY_ID,
  secretAccessKey: R2_SECRET_ACCESS_KEY,
  service: "s3",
  region: "auto",
});

function r2Url(path) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/${encoded}`;
}

/** 이미 올라가 있고 크기가 같으면 그 크기를, 없으면 null을 돌려준다. */
async function r2ExistingSize(path) {
  const res = await aws.fetch(r2Url(path), { method: "HEAD" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 HEAD 실패 (${res.status}) ${path}`);
  const len = res.headers.get("content-length");
  return len ? Number(len) : null;
}

async function r2Put(path, bytes, contentType) {
  const res = await aws.fetch(r2Url(path), {
    method: "PUT",
    body: bytes,
    headers: {
      "Content-Type": contentType || "application/octet-stream",
      "Content-Length": String(bytes.byteLength),
    },
  });
  if (!res.ok) {
    throw new Error(`R2 PUT 실패 (${res.status}) ${path}: ${await res.text()}`);
  }
}

async function r2Delete(path) {
  const res = await aws.fetch(r2Url(path), { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new Error(`R2 DELETE 실패 (${res.status}) ${path}: ${await res.text()}`);
  }
}

/**
 * 버킷을 재귀적으로 훑어 파일 전체를 모은다. Supabase `list()`는 한 단계만
 * 보여주므로(폴더는 `id: null`) 폴더를 만나면 그 안을 다시 부른다. 실제
 * 구조는 `<user_id>/<uuid>/<file>` 세 단계뿐이지만, 몇 단계든 상관없이
 * 동작하도록 깊이를 가정하지 않는다.
 */
async function listAllFiles(prefix = "") {
  const files = [];
  let offset = 0;
  const limit = 1000;
  for (;;) {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list(prefix, { limit, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(`목록 조회 실패(${prefix}): ${error.message}`);
    if (!data || data.length === 0) break;
    for (const entry of data) {
      const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null) {
        // 폴더
        files.push(...(await listAllFiles(fullPath)));
      } else {
        files.push({
          path: fullPath,
          size: entry.metadata?.size ?? null,
          mimetype: entry.metadata?.mimetype ?? null,
        });
      }
    }
    if (data.length < limit) break;
    offset += limit;
  }
  return files;
}

async function runWithConcurrency(items, limit, worker) {
  let i = 0;
  const results = new Array(items.length);
  async function next() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  return results;
}

async function main() {
  console.log("Supabase에서 목록을 읽는 중...");
  const files = await listAllFiles();
  console.log(`총 ${files.length}개 파일 발견.`);

  let copied = 0;
  let skipped = 0;
  let failed = 0;
  let copiedBytes = 0;
  const failures = [];

  await runWithConcurrency(files, CONCURRENCY, async (file, idx) => {
    try {
      const existing = await r2ExistingSize(file.path);
      if (existing !== null && (file.size == null || existing === file.size)) {
        skipped++;
        return;
      }

      const { data, error } = await supabase.storage.from(BUCKET).download(file.path);
      if (error || !data) {
        throw new Error(error?.message ?? "다운로드 실패");
      }
      const bytes = new Uint8Array(await data.arrayBuffer());
      await r2Put(file.path, bytes, file.mimetype || data.type);
      copied++;
      copiedBytes += bytes.byteLength;
      if ((idx + 1) % 50 === 0) {
        console.log(`... ${idx + 1}/${files.length}`);
      }
    } catch (err) {
      failed++;
      failures.push({ path: file.path, error: err instanceof Error ? err.message : String(err) });
    }
  });

  console.log("");
  console.log(`복사 ${copied}개(${(copiedBytes / 1024 / 1024).toFixed(1)}MB) · 이미 있음 ${skipped}개 · 실패 ${failed}개`);
  if (failures.length > 0) {
    console.log("실패 목록:");
    for (const f of failures) console.log(`  ${f.path}: ${f.error}`);
  }

  if (failed > 0) {
    console.log("");
    console.log("실패한 것이 있어 지우기 단계는 건너뛴다. 다시 돌려서 실패가 0이 될 때까지 확인할 것.");
    process.exit(1);
  }

  if (!DO_DELETE) {
    console.log("");
    console.log("--delete 없이 끝났다. Supabase 원본은 그대로 있다.");
    console.log("결과를 확인한 뒤(화면에서 그림이 잘 뜨는지) 같은 명령에 --delete를 붙여 다시 돌리면");
    console.log("R2에 같은 크기로 확인된 것만 Supabase에서 지운다.");
    return;
  }

  console.log("");
  console.log("--delete 지정됨 — R2에 같은 크기로 있는 것만 Supabase에서 지운다...");
  let deleted = 0;
  let deleteSkipped = 0;
  const deleteFailures = [];
  await runWithConcurrency(files, CONCURRENCY, async (file) => {
    try {
      const size = await r2ExistingSize(file.path);
      if (size === null || (file.size != null && size !== file.size)) {
        deleteSkipped++;
        return;
      }
      const { error } = await supabase.storage.from(BUCKET).remove([file.path]);
      if (error) throw new Error(error.message);
      deleted++;
    } catch (err) {
      deleteFailures.push({
        path: file.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  console.log(`Supabase에서 지움 ${deleted}개 · 건너뜀(R2 미확인) ${deleteSkipped}개 · 삭제 실패 ${deleteFailures.length}개`);
  if (deleteFailures.length > 0) {
    for (const f of deleteFailures) console.log(`  ${f.path}: ${f.error}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
