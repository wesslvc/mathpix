"use client";

/**
 * **"틀린 문항만 자르기"** 스위치 + 번호 칸(지면 통째로 · 국어 모드가 같이 쓴다).
 * 번호 칸은 연결된 채점의 틀린 번호로 미리 채워 두고, 고칠 수 있다(채점이 없으면 직접 적는다).
 * 번호 해석은 `parseNumberList` 한 곳 — 화면과 자르는 쪽이 같은 값을 봐야 한다.
 */

/** "28, 31 33-35" → {28,31,33,34,35}. 이상한 조각은 버린다. */
export function parseNumberList(text: string): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(/[\s,，、;/]+/)) {
    const m = /^(\d{1,3})(?:[~∼\-–](\d{1,3}))?$/.exec(part.trim());
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < a || b - a > 60) continue;
    for (let n = a; n <= b; n++) out.add(n);
  }
  return out;
}

export default function WrongOnlyToggle({
  enabled,
  onEnabled,
  text,
  onText,
  fromGrade,
}: {
  enabled: boolean;
  onEnabled: (v: boolean) => void;
  text: string;
  onText: (v: string) => void;
  /** 번호 칸이 채점 기록에서 채워졌는가(안내 문구용). */
  fromGrade: boolean;
}) {
  const count = parseNumberList(text).size;
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
      <label className="flex cursor-pointer items-center gap-2 font-medium text-slate-700">
        <input type="checkbox" checked={enabled} onChange={(e) => onEnabled(e.target.checked)} />
        틀린 문항만 자르기
        {enabled && count > 0 && <span className="text-xs font-normal text-slate-500">({count}문항)</span>}
      </label>
      {enabled && (
        <div className="mt-2 flex flex-col gap-1">
          <input
            value={text}
            onChange={(e) => onText(e.target.value)}
            inputMode="numeric"
            placeholder="틀린 번호 예: 28, 31, 33-35"
            className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
          />
          <p className="text-xs text-slate-500">
            {count === 0
              ? "번호를 적어 주세요 — 비어 있으면 전부 자릅니다."
              : fromGrade
                ? "연결된 채점의 틀린 번호예요. 고쳐도 됩니다. "
                : ""}
            {count > 0 && "국어 모드는 그 문항이 든 지문도 함께 잘라요."}
          </p>
        </div>
      )}
    </div>
  );
}
