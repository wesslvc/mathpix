import { NextResponse } from "next/server";
import crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { PAID_RECOGNITION_CREDITS } from "@/lib/billing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TOLERANCE_SEC = 5 * 60; // timestamp ±5분

type GrobleEvent = {
  id?: string;
  type?: string;
  occurredAt?: string;
  data?: { object?: Record<string, unknown> };
};

function hmacHex(secret: string, message: string): string {
  return crypto.createHmac("sha256", secret).update(message, "utf8").digest("hex");
}

/** hex 문자열 두 개를 타이밍 공격에 안전하게 비교한다. */
function safeEqualHex(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** 참조값(sellerReference)으로 우리 서비스 사용자 id를 찾는다. */
async function resolveUserId(
  admin: SupabaseClient,
  sellerReference: string | null,
): Promise<string | null> {
  if (!sellerReference) return null;
  const { data } = await admin
    .from("payment_refs")
    .select("user_id")
    .eq("ref", sellerReference)
    .maybeSingle();
  return (data?.user_id as string | undefined) ?? null;
}

/** 결제 완료 → 토큰 1000개 충전(정기결제 회차도 매번 동일하게 충전). */
async function grantCredits(
  admin: SupabaseClient,
  args: {
    sellerReference: string | null;
    merchantUid: string | null;
  },
): Promise<void> {
  const userId = await resolveUserId(admin, args.sellerReference);
  if (!userId) return; // 매핑 없음(잘못된/폐기된 ref) → 조용히 무시

  const { error } = await admin.rpc("grant_recognition_credits", {
    p_user_id: userId,
    p_amount: PAID_RECOGNITION_CREDITS,
  });
  if (error) throw error;

  // 일반결제 취소·환불은 sellerReference가 안 오므로 merchantUid로 연결하려 매핑 저장.
  if (args.merchantUid && args.sellerReference) {
    await admin.from("groble_merchants").upsert({
      merchant_uid: args.merchantUid,
      seller_reference: args.sellerReference,
      user_id: userId,
    });
  }
}

/** 일반결제 환불 → 해당 구매로 충전된 크레딧을 0으로 되돌린다(merchantUid 매핑 기준). */
async function revokeCreditsByMerchantUid(
  admin: SupabaseClient,
  merchantUid: string | null,
): Promise<void> {
  if (!merchantUid) return;
  const { data } = await admin
    .from("groble_merchants")
    .select("user_id")
    .eq("merchant_uid", merchantUid)
    .maybeSingle();
  const userId = (data?.user_id as string | undefined) ?? null;
  if (!userId) return;
  await admin
    .from("entitlements")
    .update({ credits: 0, updated_at: new Date().toISOString() })
    .eq("user_id", userId);
}

export async function POST(request: Request) {
  const secret = process.env.GROBLE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "secret not set" }, { status: 500 });
  }

  // 1) 서명 검증은 JSON 파싱 전 원본 body로 해야 한다.
  const rawBody = await request.text();
  const signature = request.headers.get("x-groble-signature") ?? "";
  const signaturePrev = request.headers.get("x-groble-signature-previous") ?? "";
  const timestamp = request.headers.get("x-groble-timestamp") ?? "";
  const idempotencyKey = request.headers.get("x-groble-idempotency-key") ?? "";

  const tsSec = Number(timestamp);
  if (
    !Number.isFinite(tsSec) ||
    Math.abs(Date.now() / 1000 - tsSec) > TOLERANCE_SEC
  ) {
    return NextResponse.json({ error: "timestamp out of range" }, { status: 400 });
  }

  const expected = hmacHex(secret, `${timestamp}.${rawBody}`);
  const verified =
    safeEqualHex(expected, signature) || safeEqualHex(expected, signaturePrev);
  if (!verified) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let event: GrobleEvent;
  try {
    event = JSON.parse(rawBody) as GrobleEvent;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const admin = createAdminClient();

  // 2) 멱등 처리 — 이미 처리한 이벤트면 200으로 조용히 넘어간다.
  if (idempotencyKey) {
    const { error: dupErr } = await admin.from("groble_webhook_events").insert({
      idempotency_key: idempotencyKey,
      event_id: event.id ?? null,
      type: event.type ?? null,
    });
    if (dupErr) {
      // primary key 충돌 = 이미 처리함.
      return NextResponse.json({ ok: true, duplicate: true });
    }
  }

  // 그로블 "테스트 발송"은 evt_test_ 접두사가 붙은 이벤트를 실제 거래 데이터를
  // 흉내내어 보낸다(같은 merchantUid를 재사용하기도 함). 서명 검증까지는 정상
  // 통과해야 하므로 응답은 200으로 주되, 실제 크레딧 지급/차감은 절대 적용하지
  // 않는다 — 실서비스 계정 크레딧이 테스트 발송으로 바뀌는 사고를 막기 위함.
  const isTestEvent = (event.id ?? "").startsWith("evt_test_");
  if (isTestEvent) {
    return NextResponse.json({ ok: true, test: true });
  }

  const type = event.type ?? "";
  const obj = event.data?.object ?? {};
  const sellerReference = asString(obj.sellerReference);
  const merchantUid = asString(obj.merchantUid);

  try {
    if (
      type === "payment.completed" ||
      type === "subscription_payment.completed"
    ) {
      // 정기결제는 최초 결제와 매 갱신 회차마다 이 이벤트가 오므로, 회차마다
      // 1000개씩 충전된다.
      await grantCredits(admin, { sellerReference, merchantUid });
    } else if (type === "payment.refunded") {
      await revokeCreditsByMerchantUid(admin, merchantUid);
    }
    // 그 외(cancel_requested, subscription_payment.refunded/failed,
    // subscription.terminated 등)는 이미 충전된 크레딧을 건드리지 않는다 —
    // 크레딧은 회차 결제 시점에만 충전되고, 남은 크레딧은 계속 쓸 수 있다.
  } catch {
    // 처리 실패 → 500으로 응답해 그로블이 재시도하게 한다.
    return NextResponse.json({ error: "processing failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
