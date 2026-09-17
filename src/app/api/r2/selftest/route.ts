import { NextResponse } from "next/server";
import { requireFontAdmin } from "../../admin/kice-font/auth";
import { r2Configured, r2Delete, r2Get, r2Put } from "@/lib/r2";

/**
 * R2 가 **실제로** 되는지 한 번 찔러본다.
 *
 * 서명(SigV4)은 틀려도 403 하나로 끝나서 어디가 틀렸는지 안 보인다. 그래서
 * 진짜 데이터를 옮기기 **전에** 올리고·읽고·지우기를 한 바퀴 돌려 본다 —
 * `/api/figure/models` 프로브가 이미 같은 이유로 있는 자리다.
 *
 * 무제한 계정만 열 수 있다(`requireFontAdmin` 과 같은 기준). 남의 버킷에
 * 쓰기를 시켜 볼 수 있는 길을 아무에게나 열어 둘 이유가 없다.
 *
 * 다 쓰고 지워도 되는 라우트지만, 환경변수를 바꿀 때마다 다시 필요하므로
 * 남겨 둔다(호출해도 16바이트짜리 파일 하나가 생겼다 사라질 뿐이다).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireFontAdmin();
  if (!gate.ok) return gate.response;

  if (!r2Configured()) {
    return NextResponse.json({
      configured: false,
      hint: "R2_ACCOUNT_ID · R2_ACCESS_KEY_ID · R2_SECRET_ACCESS_KEY · R2_BUCKET 넷이 다 있어야 합니다. 넣은 뒤에는 재배포해야 반영됩니다.",
    });
  }

  const path = `_selftest/${crypto.randomUUID()}.txt`;
  const body = `r2 ok ${new Date().toISOString()}`;
  const steps: Record<string, string> = {};

  try {
    await r2Put(path, new TextEncoder().encode(body), "text/plain");
    steps.put = "ok";

    const got = await r2Get(path);
    if (!got) throw new Error("방금 올린 것을 못 읽었습니다(404).");
    const text = await got.text();
    steps.get = text === body ? "ok" : `내용이 다릅니다: ${text.slice(0, 40)}`;

    await r2Delete([path]);
    steps.delete = "ok";

    const gone = await r2Get(path);
    steps.verifyDelete = gone === null ? "ok" : "지웠는데 아직 읽힙니다";
  } catch (err) {
    return NextResponse.json(
      {
        configured: true,
        ok: false,
        steps,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }

  const ok = Object.values(steps).every((v) => v === "ok");
  return NextResponse.json({ configured: true, ok, steps });
}
