import TokenGauge from "./TokenGauge";

type Props = {
  credits: number;
  /** 결제창이 설정돼 실제 구매로 넘어갈 수 있는지. */
  checkoutReady: boolean;
  /** BYOD 패스 결제창이 설정돼 있는지(GROBLE_PAYMENT_URL_BYOD). */
  byodCheckoutReady?: boolean;
  /** 한도 없이 쓸 수 있는 계정인지. 이때는 잔량 대신 "무제한"만 보여준다. */
  unlimited?: boolean;
  /** BYOD 패스 계정인지. 본인 키로 직접 내므로 토큰 잔량 자체가 의미 없다. */
  byod?: boolean;
};

/**
 * 남은 토큰 배너. 0이면 이용권 구매 버튼을 강조해 보여준다.
 * 구매 버튼은 서버 라우트(/api/checkout)로 이동해 그로블 결제창을 연다.
 */
export default function BillingStatus({
  credits,
  checkoutReady,
  byodCheckoutReady = false,
  unlimited = false,
  byod = false,
}: Props) {
  const empty = !unlimited && !byod && credits <= 0;

  if (unlimited) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
        토큰 <span className="font-semibold">무제한</span> 계정입니다.
      </div>
    );
  }

  if (byod) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
        <span className="font-semibold">BYOD 패스</span> 계정입니다 — Mathpix
        문제 인식은 무제한 무료, 다른 기능은 아래 등록한 본인 OpenAI 키로
        직접 부릅니다(우리 토큰 소모 없음).
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        className={`flex flex-col gap-2 rounded-xl border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between ${
          empty
            ? "border-amber-200 bg-amber-50 text-amber-900"
            : "border-slate-200 bg-white text-slate-700"
        }`}
      >
        <p>
          {empty ? (
            <>
              토큰을 모두 사용했어요.{" "}
              <span className="font-semibold">이용권</span>을 구매하면 5000토큰이
              충전돼요.
            </>
          ) : (
            <>
              <TokenGauge tokens={credits} className="min-w-[180px]" />
            </>
          )}
        </p>
        {checkoutReady ? (
          <a
            href="/api/checkout?plan=tokens"
            className={`shrink-0 rounded-lg px-4 py-2 text-center text-xs font-medium text-white ${
              empty
                ? "bg-amber-600 hover:bg-amber-700"
                : "bg-slate-600 hover:bg-slate-700"
            }`}
          >
            이용권 구매하기 (+5000토큰)
          </a>
        ) : (
          empty && <span className="shrink-0 text-xs text-amber-700">결제 준비 중</span>
        )}
      </div>

      {/* **+5000토큰 배너 바로 밑에 BYOD를 나란히 안내한다**(사용자 요청).
          토큰이 남아 있어도 본인 OpenAI 키가 있으면 BYOD가 더 유리할 수
          있어 이용권 소진 여부와 무관하게 늘 보여준다. */}
      <div className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 sm:flex-row sm:items-center sm:justify-between">
        <p>
          본인 OpenAI 키가 있다면 <span className="font-semibold">BYOD 패스</span>
          (5,250원)로 Mathpix 문제 인식을 무제한 무료로 쓰고, 나머지 기능도
          토큰 소모 없이 본인 키로 직접 이용할 수 있어요.
        </p>
        {byodCheckoutReady ? (
          <a
            href="/api/checkout?plan=byod"
            className="shrink-0 rounded-lg border border-slate-300 bg-white px-4 py-2 text-center text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            BYOD 패스 구매하기
          </a>
        ) : (
          <span className="shrink-0 text-xs text-slate-400">결제 준비 중</span>
        )}
      </div>
    </div>
  );
}
