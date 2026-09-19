import { NextResponse } from "next/server";
import { requireFontAdmin } from "../kice-font/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { r2Configured, r2Head, r2Put, r2Delete } from "@/lib/r2";

/**
 * Supabase Storage(`problem-images`)에 남은 그림을 R2로 옮기는 버튼의 뒷단.
 *
 * `scripts/migrate-images-to-r2.mjs`(PC에서 돌리는 로컬 스크립트)와 로직은
 * 같지만, 이 라우트는 **PC가 없어도 버튼 하나로** 쓸 수 있다 — 서버가 이미
 * 가진 서비스 키·R2 키를 그대로 쓰므로 사용자가 아무 값도 입력할 필요가
 * 없다. 무제한 계정만 열 수 있다(`requireFontAdmin`, `/api/r2/selftest`와
 * 같은 기준) — 남의 그림을 통째로 훑고 옮기는 작업이라 아무나 눌러선 안 된다.
 *
 * **DB는 안 건드린다.** `/api/card`가 R2를 먼저 보고 없으면 Supabase로
 * 내려가게 짜여 있어서, 경로만 같으면 어디에 있든 화면은 똑같다.
 *
 * **한 번 호출로 다 끝내지 않는다.** 파일이 수백 개라 Vercel 실행 시간
 * 안에 다 못 옮길 수 있고, 그 전에 진행 상황을 화면에 보여줘야 한다
 * (이 저장소는 "얼마나 걸리는지 아무 단서가 없으면 안 된다"를 여러 번
 * 적어 뒀다). 화면이 이 라우트를 **배치 크기만큼씩 반복 호출**한다 —
 * 처음엔 `items` 없이 불러 전체 목록을 만들고, 그다음부터는 직전 응답의
 * `remaining`을 그대로 돌려보내면 이어서 처리한다(서버는 매번 다시
 * 훑지 않는다 — 목록 조회 자체는 가볍지만 반복할 이유가 없다).
 *
 * **재실행해도 안전하다.** 복사 전에 R2에 같은 크기로 이미 있는지 HEAD로
 * 확인하고 있으면 건너뛴다 — 중간에 탭을 닫아도 다시 누르면 남은 것부터
 * 이어진다.
 *
 * **지우기는 별도 동작(`action: "delete"`)이고, 그마저도 R2에 같은 크기로
 * 확인된 것만 지운다.** 복사가 다 끝난 걸 화면에서 확인한 뒤에만 누르게
 * 되어 있다 — 확인 없이 원본을 지우면 되돌릴 수 없다.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const BUCKET = "problem-images";
const BATCH_SIZE = 20;
const CONCURRENCY = 6;

type Item = { path: string; size: number | null; mimetype: string | null };

/**
 * 버킷을 재귀적으로 훑어 파일 전체를 모은다. `list()`는 한 단계만
 * 보여주므로(폴더는 `id: null`) 폴더를 만나면 그 안을 다시 부른다.
 */
async function listAllFiles(
  admin: ReturnType<typeof createAdminClient>,
  prefix = "",
): Promise<Item[]> {
  const files: Item[] = [];
  let offset = 0;
  const limit = 1000;
  for (;;) {
    const { data, error } = await admin.storage
      .from(BUCKET)
      .list(prefix, { limit, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(`목록 조회 실패(${prefix}): ${error.message}`);
    if (!data || data.length === 0) break;
    for (const entry of data) {
      const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null) {
        files.push(...(await listAllFiles(admin, fullPath)));
      } else {
        files.push({
          path: fullPath,
          size: (entry.metadata?.size as number | undefined) ?? null,
          mimetype: (entry.metadata?.mimetype as string | undefined) ?? null,
        });
      }
    }
    if (data.length < limit) break;
    offset += limit;
  }
  return files;
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  let i = 0;
  const results: R[] = new Array(items.length);
  async function next() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  return results;
}

export async function POST(request: Request) {
  const gate = await requireFontAdmin();
  if (!gate.ok) return gate.response;

  if (!r2Configured()) {
    return NextResponse.json(
      { error: "R2가 설정되지 않았습니다(R2_ACCOUNT_ID 등 4개 환경변수)." },
      { status: 503 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    action?: "copy" | "delete";
    items?: Item[];
  };
  const action = body.action === "delete" ? "delete" : "copy";

  const admin = createAdminClient();

  let total: number | undefined;
  let queue: Item[];
  if (body.items) {
    queue = body.items;
  } else {
    queue = await listAllFiles(admin);
    total = queue.length;
  }

  const batch = queue.slice(0, BATCH_SIZE);
  const remaining = queue.slice(BATCH_SIZE);
  const failures: { path: string; error: string }[] = [];

  if (action === "copy") {
    let copied = 0;
    let skipped = 0;
    let copiedBytes = 0;
    await runWithConcurrency(batch, CONCURRENCY, async (file) => {
      try {
        const existing = await r2Head(file.path);
        if (existing !== null && (file.size == null || existing === file.size)) {
          skipped++;
          return;
        }
        const { data, error } = await admin.storage.from(BUCKET).download(file.path);
        if (error || !data) throw new Error(error?.message ?? "다운로드 실패");
        const bytes = new Uint8Array(await data.arrayBuffer());
        await r2Put(file.path, bytes, file.mimetype || data.type);
        copied++;
        copiedBytes += bytes.byteLength;
      } catch (err) {
        failures.push({ path: file.path, error: err instanceof Error ? err.message : String(err) });
      }
    });

    return NextResponse.json({
      action,
      total,
      batchSize: batch.length,
      copied,
      skipped,
      copiedBytes,
      failed: failures.length,
      failures,
      remaining,
      done: remaining.length === 0,
    });
  }

  // action === "delete" — R2에 같은 크기로 확인된 것만 Supabase에서 지운다.
  let deleted = 0;
  let deleteSkipped = 0;
  await runWithConcurrency(batch, CONCURRENCY, async (file) => {
    try {
      const size = await r2Head(file.path);
      if (size === null || (file.size != null && size !== file.size)) {
        deleteSkipped++;
        return;
      }
      const { error } = await admin.storage.from(BUCKET).remove([file.path]);
      if (error) throw new Error(error.message);
      deleted++;
    } catch (err) {
      failures.push({ path: file.path, error: err instanceof Error ? err.message : String(err) });
    }
  });

  return NextResponse.json({
    action,
    total,
    batchSize: batch.length,
    deleted,
    deleteSkipped,
    failed: failures.length,
    failures,
    remaining,
    done: remaining.length === 0,
  });
}

/**
 * 지금 얼마나 남았는지 미리 보여준다(누르기 전에 규모를 알 수 있게).
 * R2 HEAD 확인 없이 **개수·용량만** 센다 — 진짜 이관 여부는 복사를 눌러야
 * 안다(HEAD를 513번 하는 건 미리보기치고 무겁다).
 */
export async function GET() {
  const gate = await requireFontAdmin();
  if (!gate.ok) return gate.response;
  if (!r2Configured()) {
    return NextResponse.json({ configured: false });
  }
  const admin = createAdminClient();
  const files = await listAllFiles(admin);
  const totalBytes = files.reduce((sum, f) => sum + (f.size ?? 0), 0);
  return NextResponse.json({ configured: true, count: files.length, totalBytes });
}
