type Props = {
  paid: boolean;
  remaining: number;
  limit: number;
  /** 결제창이 설정돼 실제 구매로 넘어갈 수 있는지. */
  checkoutReady: boolean;
};

/**
 * 무료 체험/결제 상태 배너. 결제하지 않았으면 남은 체험 수와 이용권 구매 버튼을,
 * 결제했으면 이용 중 안내를 보여준다. 구매 버튼은 서버 라우트(/api/checkout)로
 * 이동해 그로블 결제창을 연다.
 */
export default function BillingStatus({
  paid,
  remaining,
  limit,
  checkoutReady,
}: Props) {
  if (paid) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
        이용권 사용 중이에요. 모든 기능을 제한 없이 쓸 수 있습니다.
      </div>
    );
  }

  const trialOver = remaining <= 0;

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between">
      <p>
        {trialOver ? (
          <>
            무료 체험이 끝났어요. <span className="font-semibold">이용권</span>을
            구매하면 계속 저장하고 PDF로 내보낼 수 있어요.
          </>
        ) : (
          <>
            무료 체험 중 — 오답 {limit}개까지 저장할 수 있어요.{" "}
            <span className="font-semibold">남은 {remaining}개</span>
          </>
        )}
      </p>
      {checkoutReady ? (
        <a
          href="/api/checkout"
          className="shrink-0 rounded-lg bg-amber-600 px-4 py-2 text-center text-xs font-medium text-white hover:bg-amber-700"
        >
          이용권 구매하기
        </a>
      ) : (
        <span className="shrink-0 text-xs text-amber-700">결제 준비 중</span>
      )}
    </div>
  );
}
