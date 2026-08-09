import TokenGauge from "./TokenGauge";

type Props = {
  credits: number;
  /** 결제창이 설정돼 실제 구매로 넘어갈 수 있는지. */
  checkoutReady: boolean;
  /** 한도 없이 쓸 수 있는 계정인지. 이때는 잔량 대신 "무제한"만 보여준다. */
  unlimited?: boolean;
};

/**
 * 남은 토큰 배너. 0이면 이용권 구매 버튼을 강조해 보여준다.
 * 구매 버튼은 서버 라우트(/api/checkout)로 이동해 그로블 결제창을 연다.
 */
export default function BillingStatus({
  credits,
  checkoutReady,
  unlimited = false,
}: Props) {
  const empty = !unlimited && credits <= 0;

  if (unlimited) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
        토큰 <span className="font-semibold">무제한</span> 계정입니다.
      </div>
    );
  }

  return (
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
            <span className="font-semibold">이용권</span>을 구매하면 1000토큰이
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
          href="/api/checkout"
          className={`shrink-0 rounded-lg px-4 py-2 text-center text-xs font-medium text-white ${
            empty
              ? "bg-amber-600 hover:bg-amber-700"
              : "bg-slate-600 hover:bg-slate-700"
          }`}
        >
          이용권 구매하기 (+1000토큰)
        </a>
      ) : (
        empty && <span className="shrink-0 text-xs text-amber-700">결제 준비 중</span>
      )}
    </div>
  );
}
