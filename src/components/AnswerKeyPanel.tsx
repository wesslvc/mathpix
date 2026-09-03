"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { isHeicFile, readAsDataUrl } from "@/lib/cropImage";
import { prepareGradingImage, gradingImageBudget, type PickedImage } from "@/lib/gradeImagePrep";
import type { AnswerKeyItem } from "@/lib/gradeExam";

/** 이 실모에 저장된 문제 — 번호로 답지와 이어 붙인다. */
export type AnswerKeyTarget = { id: string; number: number | null };

type Props = {
  categoryId: string;
  /** 실모 이름. 답지를 저장할 때 이름으로 쓴다. */
  categoryName: string;
  problems: AnswerKeyTarget[];
};

type Step = "idle" | "picking" | "reading" | "review" | "done";

/**
 * **답지 사진을 읽어 데이터로 남기고, 문제에 정답을 붙인다.**
 *
 * 지금까지 정답은 문제마다 손으로 적거나(오답추가 화면) 채점 기록에서
 * 딸려 왔을 뿐이라, 채점 없이 문제만 모아 둔 실모에는 정답을 넣을 길이
 * 하나씩 적는 것뿐이었다. 답지 한 장이면 스무 문항이 한 번에 붙는다.
 *
 * **읽은 답지는 `answer_keys` 에 남긴다.** 문제를 나중에 더 넣어도 번호로
 * 다시 붙일 수 있어야 하기 때문이다 — 다시 읽으면 또 돈이 든다.
 *
 * **곧바로 저장하지 않는다.** 채점과 같은 이유로 vision 이 잘못 읽는 일이
 * 있어, 표로 보여주고 사람이 고친 뒤에 저장한다.
 */
export default function AnswerKeyPanel({ categoryId, categoryName, problems }: Props) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("idle");
  const [pics, setPics] = useState<PickedImage[]>([]);
  const [items, setItems] = useState<AnswerKeyItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [applied, setApplied] = useState(0);

  /** 번호 → 문제 id. 번호가 없는 문제는 붙일 방법이 없어 뺀다. */
  const byNumber = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of problems) {
      if (p.number != null && !m.has(p.number)) m.set(p.number, p.id);
    }
    return m;
  }, [problems]);

  const matched = items.filter((it) => byNumber.has(it.no));

  async function pick(files: FileList | null) {
    setError(null);
    const list = Array.from(files ?? []);
    if (list.length === 0) return;
    const heic = list.find(isHeicFile);
    if (heic) {
      setError(
        "HEIC/HEIF 형식은 브라우저에서 열 수 없어요. 아이폰 설정 > 카메라 > 포맷을 '호환 우선'으로 바꾸거나 JPG로 바꿔서 올려주세요.",
      );
      return;
    }
    setBusy("사진 읽는 중...");
    try {
      // 고르는 그 자리에서 바이트까지 읽어 둔다(안드로이드에서 나중에 읽으면
      // 접근 권한이 풀려 실패한다 — gradeImagePrep.ts 주석 참고).
      const read = await Promise.all(
        list.map(async (f) => ({ name: f.name, dataUrl: await readAsDataUrl(f), file: f })),
      );
      setPics(read);
    } catch {
      setError("사진을 읽지 못했어요. 갤러리 대신 \"내 파일\"에서 고르거나 캡처해서 올려주세요.");
    } finally {
      setBusy(null);
    }
  }

  async function read() {
    if (pics.length === 0) return;
    setStep("reading");
    setError(null);
    setBusy("답지를 읽는 중... (최대 1분)");
    try {
      const budget = gradingImageBudget(pics.length);
      const images = await Promise.all(pics.map((p) => prepareGradingImage(p, budget)));
      const res = await fetch("/api/answer-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images }),
      });
      const json: {
        items?: AnswerKeyItem[];
        chargedTokens?: number | null;
        usage?: { estKrw?: number };
        error?: string;
      } = await res.json();
      if (!res.ok) throw new Error(json.error ?? "답지 인식에 실패했습니다.");
      setItems(json.items ?? []);
      if (typeof json.chargedTokens === "number") {
        setNote(
          json.usage?.estKrw
            ? `${json.chargedTokens}토큰 사용 (약 ${Math.round(json.usage.estKrw)}원)`
            : `${json.chargedTokens}토큰 사용`,
        );
      }
      setStep("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "답지 인식에 실패했습니다.");
      setStep("picking");
    } finally {
      setBusy(null);
    }
  }

  function update(i: number, patch: Partial<AnswerKeyItem>) {
    setItems((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], ...patch };
      return next;
    });
  }

  async function save() {
    setBusy("저장하는 중...");
    setError(null);
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("로그인이 필요합니다.");

      // ① 답지 자체를 남긴다(문제를 나중에 더 넣어도 다시 붙일 수 있게).
      const { error: insErr } = await supabase.from("answer_keys").insert({
        user_id: user.id,
        category_id: categoryId,
        name: categoryName,
        items,
      });
      if (insErr) throw insErr;

      // ② 번호가 맞는 문제에 정답·배점을 붙인다. **배점이 box_range jsonb
      //    안에 있어 서버에서 합쳐야 한다** — 화면에서 하려면 그림이 든
      //    box_range 를 통째로 내려받아야 한다(문제당 수백 KB~4MB).
      const updates = matched.map((it) => ({
        id: byNumber.get(it.no)!,
        answer: it.answer,
        ...(it.points != null ? { points: it.points } : {}),
      }));
      const { data: n, error: rpcErr } = await supabase.rpc("apply_answer_key", {
        p_updates: updates,
      });
      if (rpcErr) throw rpcErr;

      setApplied(typeof n === "number" ? n : updates.length);
      setStep("done");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장에 실패했습니다.");
    } finally {
      setBusy(null);
    }
  }

  function reset() {
    setStep("idle");
    setPics([]);
    setItems([]);
    setError(null);
    setNote(null);
    setApplied(0);
  }

  if (step === "idle") {
    return (
      <button
        type="button"
        onClick={() => setStep("picking")}
        className="self-start text-sm text-blue-600 underline underline-offset-2 hover:text-blue-800"
      >
        + 답지 사진으로 정답 한 번에 넣기
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-sm font-medium text-slate-700">답지로 정답 채우기</p>

      {step === "picking" && (
        <>
          <p className="text-xs text-slate-400">
            정답표(답지) 사진을 올리면 문항별 정답과 배점을 읽어, 번호가 같은
            문제에 한 번에 붙입니다. 읽은 답지는 저장해 두었다가 문제를 나중에
            더 넣어도 다시 쓸 수 있어요.
          </p>
          <label className="flex flex-col gap-1 text-sm text-slate-700">
            답지 사진 (여러 장 가능)
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => void pick(e.target.files)}
              className="text-sm"
            />
          </label>
          {pics.length > 0 && (
            <p className="text-xs text-slate-400">{pics.map((p) => p.name).join(", ")}</p>
          )}
        </>
      )}

      {step === "review" && (
        <>
          <p className="text-xs text-slate-500">
            읽은 결과를 확인하고 틀린 곳은 고친 뒤 저장하세요. 이 실모에 번호가
            같은 문제가 있는 것만 붙습니다 —{" "}
            <span className="font-medium text-slate-700">
              {items.length}개 중 {matched.length}개 연결됨
            </span>
            {items.length > matched.length && (
              <span className="text-amber-700">
                {" "}
                (나머지 {items.length - matched.length}개는 해당 번호의 문제가 아직 없어요)
              </span>
            )}
          </p>
          <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-50">
                <tr className="text-left text-slate-500">
                  <th className="w-14 px-2 py-1">번호</th>
                  <th className="px-2 py-1">정답</th>
                  <th className="w-20 px-2 py-1">배점</th>
                  <th className="w-20 px-2 py-1">연결</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => {
                  const linked = byNumber.has(it.no);
                  return (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="px-2 py-1">
                        <input
                          type="number"
                          value={it.no}
                          onChange={(e) => update(i, { no: Number(e.target.value) })}
                          className="w-12 rounded border border-slate-300 px-1 py-0.5"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          value={it.answer}
                          onChange={(e) => update(i, { answer: e.target.value })}
                          className="w-full rounded border border-slate-300 px-1.5 py-0.5"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          value={it.points ?? ""}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            update(i, {
                              points: e.target.value === "" || Number.isNaN(n) ? undefined : n,
                            });
                          }}
                          className="w-12 rounded border border-slate-300 px-1 py-0.5"
                        />
                      </td>
                      <td
                        className={`px-2 py-1 ${linked ? "text-emerald-600" : "text-slate-400"}`}
                      >
                        {linked ? "○" : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {note && <p className="text-[11px] text-slate-400">{note}</p>}
        </>
      )}

      {step === "done" && (
        <p className="text-sm text-emerald-700">
          정답 {applied}개를 문제에 붙였어요. 답지도 저장해 뒀습니다.
        </p>
      )}

      {busy && <p className="text-sm text-slate-500">{busy}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex items-center gap-2">
        {step === "picking" && (
          <button
            type="button"
            onClick={() => void read()}
            disabled={pics.length === 0 || busy !== null}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
          >
            답지 읽기
          </button>
        )}
        {step === "review" && (
          <button
            type="button"
            onClick={() => void save()}
            disabled={matched.length === 0 || busy !== null}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
          >
            {matched.length}개 문제에 정답 넣기
          </button>
        )}
        <button
          type="button"
          onClick={reset}
          disabled={busy !== null}
          className="text-xs text-slate-500 hover:text-slate-700 disabled:opacity-40"
        >
          {step === "done" ? "닫기" : "취소"}
        </button>
      </div>
    </div>
  );
}
