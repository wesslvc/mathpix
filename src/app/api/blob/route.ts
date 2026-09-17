import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { r2Configured, r2Delete, r2Get, r2Put } from "@/lib/r2";

/**
 * 그림 파일을 올리고 지우는 한 곳. **R2 로 간다.**
 *
 * **왜 우리 라우트를 거치나** — 브라우저가 R2 로 곧장 PUT 하려면 서명된 주소
 * (presigned)와 **버킷 CORS 설정**이 필요하다. 우리 카드 PNG 는 커야 1.5MB 라
 * Vercel 요청 본문 제한(4.5MB) 안에 넉넉히 들어오므로, 거쳐 가는 편이 설정할
 * 것도 틀릴 자리도 하나 적다. 지나가는 바이트는 Vercel 대역폭(무료 100GB)을
 * 쓰는데 우리 규모에서는 없는 값이나 마찬가지다.
 *
 * **R2 가 꺼져 있으면 501 이다.** 부르는 쪽(`blobClient.ts`)이 그걸 보고 예전처럼
 * Supabase Storage 로 올린다 — 환경변수를 빼면 즉시 예전 동작으로 돌아간다.
 *
 * 인증은 `/api/card` 와 **같은 규칙**이다: 로그인 세션 + 경로 첫 조각이 그
 * 사용자 id(`0001` 의 스토리지 RLS 정책과 같다). 이 라우트는 서비스 키가
 * 아니라 R2 키로 쓰므로 RLS 가 대신 걸어 주지 않는다 — **여기서 막아야 한다.**
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Vercel 요청 본문 상한(4.5MB)보다 넉넉히 낮게 — 넘으면 부르는 쪽이 Supabase 로 간다. */
const MAX_BYTES = 4 * 1024 * 1024;

async function requireOwner(
  path: string,
): Promise<{ ok: true } | { ok: false; res: NextResponse }> {
  let supabase;
  try {
    supabase = await createClient();
  } catch {
    return {
      ok: false,
      res: NextResponse.json({ error: "저장소가 설정되어 있지 않습니다." }, { status: 503 }),
    };
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    console.error("[blob] 세션이 없습니다(401).");
    return { ok: false, res: NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 }) };
  }
  if (!path || path.split("/")[0] !== user.id) {
    console.error(`[blob] 경로 임자가 다릅니다(403). 첫 조각=${path.split("/")[0] ?? "(없음)"}`);
    return { ok: false, res: NextResponse.json({ error: "권한이 없습니다." }, { status: 403 }) };
  }
  return { ok: true };
}

/**
 * **이 라우트가 실제로 되는지 브라우저에서 확인한다.**
 *
 * 올리기가 실패하면 부르는 쪽이 조용히 Supabase 로 내려간다(그게 맞다 —
 * 저장을 통째로 잃으면 안 된다). 그런데 그러면 **왜 실패했는지 아무 데도 안
 * 남는다**: 401(세션)·403(경로)·501(R2 꺼짐)·502(R2 오류)가 전부 똑같이
 * 보인다. 실제로 R2 로 바꾼 뒤에도 파일이 전부 Supabase 로 가고 있었는데
 * 하루 동안 아무도 몰랐다.
 *
 * 그래서 로그인한 브라우저로 `/api/blob` 을 그냥 열면 **자기 경로에** 16바이트
 * 짜리를 올리고·읽고·지워 보고 결과를 그대로 돌려준다. 남의 것은 못 건드린다
 * (경로가 `<내 id>/_probe/…` 로 고정이다). `/api/r2/selftest` 와 다른 점은
 * **여기가 진짜로 쓰이는 인증·경로 규칙을 그대로 지난다**는 것이다.
 */
export async function GET() {
  let supabase;
  try {
    supabase = await createClient();
  } catch {
    return NextResponse.json({ error: "저장소가 설정되어 있지 않습니다." }, { status: 503 });
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  if (!r2Configured()) {
    return NextResponse.json({
      configured: false,
      uid: user.id,
      hint: "R2_ACCOUNT_ID · R2_ACCESS_KEY_ID · R2_SECRET_ACCESS_KEY · R2_BUCKET 넷이 다 있어야 하고, 넣은 뒤 재배포해야 반영됩니다.",
    });
  }

  const path = `${user.id}/_probe/${crypto.randomUUID()}.txt`;
  const body = `blob ok ${new Date().toISOString()}`;
  const steps: Record<string, string> = {};
  try {
    await r2Put(path, new TextEncoder().encode(body), "text/plain");
    steps.put = "ok";
    const got = await r2Get(path);
    steps.get = !got ? "방금 올린 것을 못 읽음(404)" : (await got.text()) === body ? "ok" : "내용이 다름";
    await r2Delete([path]);
    steps.delete = "ok";
  } catch (err) {
    return NextResponse.json(
      { configured: true, ok: false, uid: user.id, steps, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
  return NextResponse.json({
    configured: true,
    ok: Object.values(steps).every((v) => v === "ok"),
    uid: user.id,
    steps,
  });
}

/** 올리기. `?path=<스토리지 경로>` 에 본문 그대로 쓴다. */
export async function PUT(req: NextRequest) {
  if (!r2Configured()) {
    console.error("[blob] R2 환경변수가 없습니다 — Supabase 로 내려갑니다.");
    return NextResponse.json({ error: "R2가 설정되어 있지 않습니다." }, { status: 501 });
  }
  const path = req.nextUrl.searchParams.get("path") ?? "";
  const gate = await requireOwner(path);
  if (!gate.ok) return gate.res;

  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength === 0) {
    return NextResponse.json({ error: "빈 파일입니다." }, { status: 400 });
  }
  if (bytes.byteLength > MAX_BYTES) {
    return NextResponse.json({ error: "너무 큽니다." }, { status: 413 });
  }

  try {
    await r2Put(path, bytes, req.headers.get("content-type") || "application/octet-stream");
  } catch (err) {
    console.error("[blob] R2 쓰기 실패:", err);
    return NextResponse.json({ error: "저장에 실패했습니다." }, { status: 502 });
  }
  return NextResponse.json({ ok: true, store: "r2" });
}

/**
 * 지우기. **R2 와 Supabase 양쪽에서 지운다.**
 *
 * 옛 그림은 아직 Supabase 에 있고 새 그림은 R2 에 있다 — 어느 쪽에 있는지
 * 부르는 쪽이 알 필요가 없게 둘 다 지운다(없는 것을 지우는 것은 양쪽 다
 * 성공이다). 한쪽이 실패해도 다른 쪽은 지운다 — 남는 것은 고아 하나뿐이고,
 * 여기서 막으면 삭제 자체가 안 된 것처럼 보인다.
 */
export async function DELETE(req: NextRequest) {
  let paths: string[] = [];
  try {
    const body = await req.json();
    paths = Array.isArray(body?.paths) ? body.paths.filter((p: unknown) => typeof p === "string") : [];
  } catch {
    return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 400 });
  }
  if (paths.length === 0) return NextResponse.json({ ok: true, removed: 0 });

  for (const path of paths) {
    const gate = await requireOwner(path);
    if (!gate.ok) return gate.res;
  }

  const supabase = await createClient();
  const results = await Promise.allSettled([
    r2Configured() ? r2Delete(paths) : Promise.resolve(),
    supabase.storage.from("problem-images").remove(paths),
  ]);
  for (const r of results) {
    if (r.status === "rejected") console.error("[blob] 삭제 실패:", r.reason);
  }
  return NextResponse.json({ ok: true, removed: paths.length });
}
