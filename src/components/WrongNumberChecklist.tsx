/**
 * 자동채점에서 넘어온 "틀린 문제" 체크리스트.
 *
 * **새 기능을 만들지 않는다.** 이 실모에 이미 있는 오답추가(사진→크롭→인식→저장)
 * 화면을 그대로 쓰게 하고, 이 배너는 "몇 번을 아직 안 올렸는지"만 보여준다.
 * 이미 올린 번호는 이 실모에 저장된 문제의 **문제 번호**(`box_range.number`
 * 또는 본문에서 뽑은 번호)와 겹치는지로 판단한다 — 사용자가 오답을 추가할 때
 * "문제 번호" 칸에 그 번호를 적기만 하면 자동으로 체크된 것으로 넘어간다.
 */
export default function WrongNumberChecklist({
  wrongNumbers,
  existingNumbers,
}: {
  wrongNumbers: number[];
  existingNumbers: number[];
}) {
  if (wrongNumbers.length === 0) return null;

  const done = new Set(existingNumbers);
  const remaining = wrongNumbers.filter((n) => !done.has(n));

  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
      <p className="font-medium">
        채점 결과 틀린 문제: {wrongNumbers.join(", ")}
      </p>
      {remaining.length > 0 ? (
        <p className="mt-1 text-blue-800">
          아직 안 올린 번호:{" "}
          <span className="font-semibold">{remaining.join(", ")}</span> — 아래
          "오답추가"에서 사진을 올릴 때 "문제 번호" 칸에 번호를 적어주세요.
        </p>
      ) : (
        <p className="mt-1 text-emerald-700">
          틀린 문제를 전부 오답으로 올렸어요.
        </p>
      )}
    </div>
  );
}
