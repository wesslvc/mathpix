"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { enhanceContrast } from "@/lib/autoContrast";
import { parseProblemNumber } from "@/lib/problemNumber";

/** 번호를 붙일 대상. 이미 번호가 있는 문제는 넘기지 않는다. */
export type NumberScanTarget = {
  id: string;
  /** 저장된 카드 PNG 의 서명 URL. Mathpix 에 이걸 보낸다. */
  imageUrl: string;
  /** 인식된 본문. 여기서 번호가 나오면 Mathpix 를 부르지 않는다(공짜). */
  text: string;
};

/** 서명 URL 의 그림을 data URL 로 바꾼다(Mathpix 에 보내려면 필요하다). */
async function urlToDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error("이미지를 내려받지 못했습니다.");
  const blob = await res.blob();
  return await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("이미지를 읽지 못했습니다."));
    r.readAsDataURL(blob);
  });
}

/**
 * **이미 저장된 문제들에 문제 번호를 한 번에 붙인다.**
 *
 * 지면을 통째로 넣은 문제는 본문이 비어 있어(`isImageOnly`) 번호를 뽑을 데가
 * 없다 — 그러면 목록·PDF 에서 저장된 차례대로 1번부터 새로 매겨진다. 예전에
 * 넣어 둔 것들은 "수정"에서 하나씩 적는 수밖에 없었다.
 *
 * **먼저 공짜로 해결되는 것을 걸러낸다.** 본문이 있는 문제는 거기서 번호를
 * 뽑을 수 있으므로(`parseProblemNumber`) Mathpix 를 부르지 않는다. 실제로
 * 번호 파싱 규칙을 고친 뒤로는 인식해서 넣은 옛 문제 상당수가 여기서 끝난다.
 * 남는 것 — 그림뿐인 문제 — 만 인식에 보낸다(장당 1토큰).
 *
 * 저장은 `set_problem_numbers` RPC 로 서버에서 합친다. `box_range` 에는 그림이
 * base64 로 들어 있어(문제당 수백 KB~4MB) 화면으로 내려받아 합치면 안 된다.
 */
export default function ProblemNumberScanner({
  targets,
}: {
  targets: NumberScanTarget[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  /** 본문에서 바로 나오는 번호(공짜)와, 인식이 필요한 것으로 나눈다. */
  const { free, needScan } = useMemo(() => {
    const free: { id: string; number: number }[] = [];
    const needScan: NumberScanTarget[] = [];
    for (const t of targets) {
      const n = parseProblemNumber(t.text);
      if (n != null) free.push({ id: t.id, number: n });
      else needScan.push(t);
    }
    return { free, needScan };
  }, [targets]);

  async function run() {
    setError(null);
    setDone(null);
    const updates = [...free];
    let failed = 0;

    try {
      for (let i = 0; i < needScan.length; i++) {
        const t = needScan[i];
        setBusy(`번호를 읽는 중... (${i + 1}/${needScan.length})`);
        try {
          const dataUrl = await urlToDataUrl(t.imageUrl);
          const res = await fetch("/api/mathpix", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: await enhanceContrast(dataUrl) }),
          });
          const json = (await res.json()) as { text?: string; latex?: string; error?: string };
          // 토큰 부족 같은 것은 그 자리에서 멈춘다 — 남은 것을 계속 부르면
          // 실패만 쌓이고 시간이 오래 걸린다.
          if (res.status === 402 || res.status === 401) {
            throw new Error(json.error ?? "토큰이 부족합니다.");
          }
          const n = res.ok ? parseProblemNumber(json.text || json.latex || "") : null;
          if (n != null) updates.push({ id: t.id, number: n });
          else failed += 1;
        } catch (err) {
          if (err instanceof Error && /토큰|로그인/.test(err.message)) throw err;
          failed += 1;
        }
      }

      if (updates.length === 0) {
        setError("번호를 하나도 읽지 못했어요. 문제 사진에 번호가 안 보이면 \"수정\"에서 직접 적어주세요.");
        return;
      }

      setBusy("저장하는 중...");
      const supabase = createClient();
      const { data: n, error: rpcErr } = await supabase.rpc("set_problem_numbers", {
        p_updates: updates,
      });
      if (rpcErr) throw rpcErr;

      const applied = typeof n === "number" ? n : updates.length;
      setDone(
        failed > 0
          ? `${applied}개에 번호를 붙였어요. ${failed}개는 번호를 못 읽어서 "수정"에서 직접 적어야 해요.`
          : `${applied}개에 번호를 붙였어요.`,
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "번호 인식에 실패했습니다.");
    } finally {
      setBusy(null);
    }
  }

  if (targets.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-700">번호 없는 문제 {targets.length}개</p>
        <p className="text-xs text-slate-400">
          번호가 없으면 목록·PDF 에서 저장된 차례대로 1번부터 매겨집니다.
          {needScan.length > 0
            ? ` 본문에서 ${free.length}개는 바로 찾고, 나머지 ${needScan.length}개만 인식합니다(최대 ${needScan.length}토큰).`
            : ` 본문에서 전부 찾을 수 있어 토큰이 들지 않습니다.`}
        </p>
        {done && <p className="mt-1 text-sm text-emerald-700">{done}</p>}
        {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
      </div>
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy !== null}
        className="shrink-0 rounded-lg bg-slate-700 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
      >
        {busy ?? "전체 번호 인식"}
      </button>
    </div>
  );
}
