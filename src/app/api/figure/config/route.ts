import { NextResponse } from "next/server";
import { FIGURE_CREDIT_COST } from "@/lib/figureCost";

export const runtime = "nodejs";
// 기본값으로 두면 Next가 이 응답을 빌드 시점에 정적으로 구워버린다. 그러면
// 나중에 Vercel에서 OPENAI_API_KEY를 추가해도 재배포 전까지 configured=false가
// 그대로 남는다. 요청마다 환경변수를 다시 읽게 강제한다.
export const dynamic = "force-dynamic";

export type FigureConfig = {
  /** OPENAI_API_KEY가 설정돼 있는가. 없으면 화면에서 재구성 버튼을 숨긴다. */
  configured: boolean;
  /** 재구성 1회에 차감할 사진인식권 수. */
  cost: number;
};

/**
 * 사과탐 자료 재구성 기능의 설정값을 화면에 알려준다.
 *
 * 키 값 자체는 절대 내보내지 않고 "설정돼 있는가"만 알려준다. 키가 없는데
 * 버튼을 눌러 크레딧만 날리는 일이 없게 하려는 것이다.
 */
export async function GET() {
  return NextResponse.json({
    configured: Boolean(process.env.OPENAI_API_KEY),
    cost: FIGURE_CREDIT_COST,
  } satisfies FigureConfig);
}
