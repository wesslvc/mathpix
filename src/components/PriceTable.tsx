import {
  FIGURE_TOKEN_DEPOSIT,
  GRADING_TOKEN_DEPOSIT,
  MAX_REDRAW_TOKENS,
  OCR_TOKEN_COST,
  PASSAGE_MARKS_DEPOSIT,
  PASSAGE_READ_TOKENS,
  PATCH_REDRAW_TOKENS,
  SOL_TYPESET_TOKENS,
} from "@/lib/tokens";
import { cn } from "@/lib/utils";

/**
 * **요금표.** 눌러서 펼치는 작은 표 — 평소에는 한 줄 링크라 화면을 안 차지한다(`<details>` 라 스크립트도 필요 없다).
 * 숫자는 `tokens.ts` 에서 읽는다(여기에 하드코딩하면 값을 바꿀 때 어긋난다).
 */
export default function PriceTable({ className }: { className?: string }) {
  const free = GRADING_TOKEN_DEPOSIT === 0;
  const rows: { name: string; note?: string; cost: string; strong?: boolean }[] = [
    { name: "원본 그대로 넣기", cost: "무료" },
    { name: "Mathpix 인식", note: "수학 기본 · 수식을 글자로", cost: `${OCR_TOKEN_COST}토큰` },
    { name: "sol 인식", note: "국어 기본 · 글자를 정확히", cost: `${SOL_TYPESET_TOKENS}토큰` },
    { name: "AI로 다시 그리기", note: "표·지도·그림이 섞인 문제", cost: `${FIGURE_TOKEN_DEPOSIT}토큰`, strong: true },
    {
      name: "수정 · 다시 그리기",
      note: "결과가 아쉬울 때 한 번 더",
      cost: `${PATCH_REDRAW_TOKENS === MAX_REDRAW_TOKENS ? PATCH_REDRAW_TOKENS : `${PATCH_REDRAW_TOKENS}~${MAX_REDRAW_TOKENS}`}토큰`,
    },
    {
      name: "국어 지문 글자 인식",
      note: "서식 검수는 쓴 만큼(최대 " + PASSAGE_MARKS_DEPOSIT + ")",
      cost: `${PASSAGE_READ_TOKENS}토큰`,
    },
    {
      name: "자동 자르기 · 번호 · 채점 · 제목 · 정답표",
      cost: free ? "무료" : `${GRADING_TOKEN_DEPOSIT}토큰`,
    },
  ];
  return (
    <details className={cn("group text-sm", className)}>
      <summary className="cursor-pointer select-none text-xs font-medium text-slate-500 hover:text-slate-800">
        요금표 보기
      </summary>
      <div className="mt-2 w-full max-w-md rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <ul className="divide-y divide-slate-100">
          {rows.map((r) => (
            <li key={r.name} className="flex items-baseline justify-between gap-3 py-1.5">
              <span className="min-w-0">
                <span className="text-slate-800">{r.name}</span>
                {r.note && <span className="ml-1.5 text-[11px] text-slate-400">{r.note}</span>}
              </span>
              <span
                className={cn(
                  "shrink-0 text-xs font-semibold tabular-nums",
                  r.cost === "무료" ? "text-emerald-600" : r.strong ? "text-blue-700" : "text-slate-800",
                )}
              >
                {r.cost}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-slate-400">AI가 실패하면 토큰은 돌려드려요.</p>
      </div>
    </details>
  );
}
