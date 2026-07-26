import { NextResponse } from "next/server";
import crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

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

async function setEntitlement(
  admin: SupabaseClient,
  userId: string,
  fields: { active: boolean; is_recurring?: boolean; expires_at?: string | null },
): Promise<void> {
  await admin.from("entitlements").upsert({
    user_id: userId,
    updated_at: new Date().toISOString(),
    ...fields,
  });
}

/** 결제 완료 → 이용권 활성화. */
async function grantAccess(
  admin: SupabaseClient,
  args: {
    type: string;
    sellerReference: string | null;
    merchantUid: string | null;
  },
): Promise<void> {
  const userId = await resolveUserId(admin, args.sellerReference);
  if (!userId) return; // 매핑 없음(잘못된/폐기된 ref) → 조용히 무시

  const isRecurring = args.type.startsWith("subscription");
  // 정기결제면 다음 갱신까지 여유 있게 접근 허용, 일반결제면 무기한.
  const expiresAt = isRecurring
    ? new Date(Date.now() + 35 * 24 * 60 * 60 * 1000).toISOString()
    : null;

  await setEntitlement(admin, userId, {
    active: true,
    is_recurring: isRecurring,
    expires_at: expiresAt,
  });

  // 일반결제 취소·환불은 sellerReference가 안 오므로 merchantUid로 연결하려 매핑 저장.
  if (args.merchantUid && args.sellerReference) {
    await admin.from("groble_merchants").upsert({
      merchant_uid: args.merchantUid,
      seller_reference: args.sellerReference,
      user_id: userId,
    });
  }
}

/** 정기결제 해지 완료 → 이용권 비활성화(참조값 기준). */
async function revokeBySellerReference(
  admin: SupabaseClient,
  sellerReference: string | null,
): Promise<void> {
  const userId = await resolveUserId(admin, sellerReference);
  if (!userId) return;
  await setEntitlement(admin, userId, { active: false });
}

/** 일반결제 환불 → 이용권 비활성화(merchantUid 매핑 기준). */
async function revokeByMerchantUid(
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
  await setEntitlement(admin, userId, { active: false });
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

  const type = event.type ?? "";
  const obj = event.data?.object ?? {};
  const sellerReference = asString(obj.sellerReference);
  const merchantUid = asString(obj.merchantUid);

  try {
    if (
      type === "payment.completed" ||
      type === "subscription_payment.completed"
    ) {
      await grantAccess(admin, { type, sellerReference, merchantUid });
    } else if (type === "subscription.terminated") {
      await revokeBySellerReference(admin, sellerReference);
    } else if (type === "payment.refunded") {
      await revokeByMerchantUid(admin, merchantUid);
    }
    // 그 외(cancel_requested, subscription_payment.failed/refunded 등)는
    // 접근을 바로 끊지 않고 유지한다(해지 완료 시 subscription.terminated로 처리).
  } catch {
    // 처리 실패 → 500으로 응답해 그로블이 재시도하게 한다.
    return NextResponse.json({ error: "processing failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
