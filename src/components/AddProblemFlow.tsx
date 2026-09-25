"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import ImageUploader from "@/components/ImageUploader";

/**
 * **크롭·결과 화면은 사진을 고른 뒤에야 필요하다** — 그런데 통째로 처음부터
 * 받고 있었다. `ResultStage` 는 수식을 그리느라 KaTeX 를 끌고 오는데, 그게
 * 실모 화면을 여는 것만으로 내려받는 짐이 됐다(그 화면에 들어온 사람 대부분은
 * 목록만 보고 나간다).
 *
 * 지연 로딩해도 눈에 띄는 지연이 없다: 사용자가 사진을 고르는 **그 동작**이
 * 곧 다음 화면으로 넘어가는 신호라 그 사이에 받아진다. `ExportComposer` 가
 * 평가원 패널에 이미 같은 방식을 쓰고 있다.
 *
 * `ssr: false` 인 이유 — 둘 다 캔버스·포인터 이벤트로만 사는 화면이라 서버에서
 * 미리 그려 봐야 얻을 게 없다.
 */
const CropStage = dynamic(() => import("@/components/CropStage"), {
  ssr: false,
  loading: () => <StagePlaceholder label="크롭 화면을 준비하는 중…" />,
});
const ResultStage = dynamic(() => import("@/components/ResultStage"), {
  ssr: false,
  loading: () => <StagePlaceholder label="결과 화면을 준비하는 중…" />,
});

function StagePlaceholder({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-3 py-6" aria-busy="true">
      <div className="h-1 w-full overflow-hidden rounded bg-slate-100">
        <div className="h-full w-1/4 rounded bg-slate-300 animate-loading-sweep" />
      </div>
      <p className="text-sm text-slate-500">{label}</p>
    </div>
  );
}
import { createClient } from "@/lib/supabase/client";
import type { RecognizeResponse } from "@/lib/types";
import type { AnswerType } from "@/lib/answer";
import type { StoredBoxRange } from "@/lib/storedFigures";
import type { TokenStatus } from "@/app/api/tokens/route";
import { thumbPathFor } from "@/lib/cardThumb";
import { putBlob, removeBlobs } from "@/lib/blobClient";
import { persistFigureBlobs } from "@/lib/figureBlob";
import { enhanceContrast } from "@/lib/autoContrast";
import { attachNumberAndAnswer, readNumberWithMathpix, wholeProblemCard } from "@/lib/quickProblem";
import type { AnswerByNumber } from "@/lib/answerMap";
import { useFigureJobs } from "./FigureJobsProvider";
import BatchSplitPanel from "./BatchSplitPanel";
import KoreanModePanel from "./KoreanModePanel";
import BulkMappedImportPanel from "./BulkMappedImportPanel";

type Stage = "idle" | "upload" | "crop" | "loading" | "result";

/** 자르자마자 뒤에서 저장하는 문제 하나(진행 줄에 보여 준다). */
type QuickItem = {
  key: string;
  crop: string;
  status: "saving" | "saved" | "done" | "error";
  number?: number | null;
  answer?: string | null;
  error?: string;
};

export default function AddProblemFlow({
  categoryId,
  canAdd = true,
  onDone,
  answerByNumber = {},
}: {
  categoryId: string;
  /** false면 토큰이 없음 → 오답 추가 대신 이용권 안내를 보여준다. */
  canAdd?: boolean;
  /** 다 넣고 빠져나갈 때(있으면 바깥이 화면을 정리한다). */
  onDone?: () => void;
  /** 번호 → 정답(연결된 채점·읽어 둔 답지). 번호를 읽으면 곧바로 붙인다. */
  answerByNumber?: AnswerByNumber;
}) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("idle");
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [result, setResult] = useState<RecognizeResponse | null>(null);
  // 인식(result)을 만든 바로 그 이미지. 도형 영역을 오려낼 때 필요하다.
  const [recognizedSourceImage, setRecognizedSourceImage] = useState<
    string | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  /** 크롭 화면에 "통째로 다시 그리기" 비용을 표시하려고 읽어둔다. */
  const [tokenStatus, setTokenStatus] = useState<TokenStatus | null>(null);
  /**
   * 행마다 **지금 붙어 있는** 스토리지 경로. 다시 저장할 때 옛 파일을
   * 지우려고 든다. **행 id 로 갈라 든다** — 한 칸짜리로 두면 뒤에서 저장되는
   * 다른 문제의 경로가 끼어들어, 다시 저장할 때 **엉뚱한 문제의 그림을 지운다.**
   *
   * 없으면 스토리지가 샌다 — 저장은 한 문제에 여러 번 일어난다(결과 화면의
   * 자동 저장, AI 그림이 끝나서 다시 저장, 사용자가 손대서 다시 저장). 그때마다
   * **새 uuid 경로로 올리고** `image_path` 만 갈아 끼우므로, 옛 파일은 아무도
   * 안 가리키는 채 버킷에 그대로 남는다. 실제로 그렇게 쌓였다 — 2026-09-16에
   * 재 보니 버킷의 카드 PNG 442장 중 **150장(156MB, 44%)이 고아**였다.
   * 다른 저장 자리(`ProblemGallery.saveEdit` · `FigureJobsProvider` ·
   * `/api/figure`)는 전부 옛 경로를 지우고 있었고 **여기만 빠져 있었다.**
   */
  const savedPathRef = useRef(new Map<string, string>());
  const { enqueue } = useFigureJobs();
  /** 자르자마자 넘어간 문제들. 저장·번호·정답이 뒤에서 채워진다. */
  const [quick, setQuick] = useState<QuickItem[]>([]);
  /** 저장끼리는 한 줄로 잇는다 — 동시에 돌면 `sort_order` 가 겹친다. */
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const quickCountRef = useRef(0);
  const unsaved = quick.filter((q) => q.status === "saving").length;

  // 아직 저장이 안 끝난 문제가 있으면 탭 닫기를 되묻는다(사진이 통째로 사라진다).
  useEffect(() => {
    if (unsaved === 0) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/tokens")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setTokenStatus(data as TokenStatus);
      })
      .catch(() => {
        // 못 읽어도 버튼은 눌러볼 수 있다(서버가 최종 판단한다).
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // 여러 장을 한 번에 올리면 첫 장부터 크롭→인식→저장하고, 나머지는 여기 대기.
  const [queue, setQueue] = useState<string[]>([]);
  function readAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error("이미지를 읽지 못했습니다."));
      reader.readAsDataURL(file);
    });
  }

  async function handleImagesSelected(files: File[]) {
    try {
      const dataUrls = await Promise.all(files.map(readAsDataUrl));
      if (dataUrls.length === 0) return;
      const [first, ...rest] = dataUrls;
      setImageSrc(first);
      setQueue(rest);
      setError(null);
      setStage("crop");
    } catch (err) {
      handleImageError(
        err instanceof Error ? err.message : "이미지를 읽지 못했습니다.",
      );
    }
  }

  // 저장 후 대기열에 남은 다음 이미지로 넘어간다. 대기열이 비었으면 곧바로
  // 업로드 화면을 띄운다 — "다음"을 누른 사람은 계속 넣겠다는 뜻이므로
  // 처음 화면으로 되돌려 "+ 오답 추가"를 다시 누르게 할 이유가 없다.
  function advanceQueue() {
    setResult(null);
    setRecognizedSourceImage(null);
    setError(null);
    if (queue.length > 0) {
      const [next, ...rest] = queue;
      setQueue(rest);
      setImageSrc(next);
      setStage("crop");
    } else {
      startAnother();
    }
  }

  /** 저장한 결과를 치우고 새 사진을 고르는 화면으로 바로 넘어간다. */
  function startAnother() {
    setImageSrc(null);
    setResult(null);
    setRecognizedSourceImage(null);
    setError(null);
    setStage("upload");
  }

  async function handleCropConfirm(
    croppedDataUrl: string,
    mode: "ocr" | "problem" | "asis",
  ) {
    if (mode === "problem" || mode === "asis") {
      quickAdd(croppedDataUrl, mode);
      return;
    }
    setStage("loading");
    setError(null);
    try {
      const res = await fetch("/api/mathpix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 인식에 보낼 때만 대비를 올린다. 화면에 남는 원본은 그대로 둔다
        // (도형을 오려낼 때 원래 픽셀이 필요하다).
        body: JSON.stringify({ image: await enhanceContrast(croppedDataUrl) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "인식에 실패했습니다.");
      setResult(json as RecognizeResponse);
      setRecognizedSourceImage(croppedDataUrl);
      setStage("result");
    } catch (err) {
      setError(err instanceof Error ? err.message : "알 수 없는 오류");
      setStage("crop");
    }
  }

  /**
   * **자르면 끝이다**(2026-09-25, 사용자 요청 — "크기만 잘라두면 딜레이 없이
   * 자동으로 다음 사진으로 넘어가고, 그 사이 AI 는 자기 할 일 하고, 끝나면
   * 자동으로 번호 인식하고 자동으로 정답 붙고").
   *
   * 곧바로 다음 사진으로 넘기고, 뒤에서: 카드를 화면 없이 그려 저장 → (AI 로
   * 다시 그리기면) 행 id 를 달아 큐에 넣는다(탭을 닫아도 서버가 그 행에 결과를
   * 쓴다) → 원본 크롭에서 읽은 번호를 붙이고 그 번호의 정답도 붙인다.
   * 번호는 AI 결과를 기다리지 않는다 — 같은 번호이고 몇 초면 읽힌다.
   */
  function quickAdd(crop: string, mode: "problem" | "asis") {
    const key = crypto.randomUUID();
    const nth = ++quickCountRef.current;
    const patch = (next: Partial<QuickItem>) =>
      setQuick((prev) => prev.map((q) => (q.key === key ? { ...q, ...next } : q)));
    setQuick((prev) => [{ key, crop, status: "saving" as const }, ...prev].slice(0, 30));
    setError(null);
    advanceQueue();

    const number = readNumberWithMathpix(crop);
    const saved = saveChainRef.current.then(async () => {
      const card = await wholeProblemCard(key, crop);
      const problemId = await handleSaveToCategory({
        pngDataUrl: card.pngDataUrl,
        text: "",
        answer: "",
        answerType: "choice",
        boxRange: card.boxRange,
      });
      if (mode === "problem") {
        enqueue({
          id: key,
          problemKey: `quick:${problemId}`,
          label: `${nth}번째 사진`,
          crop,
          mode: "problem",
          problemId,
        });
      }
      patch({ status: "saved" });
      return problemId;
    });
    saveChainRef.current = saved.then(
      () => undefined,
      () => undefined,
    );
    void saved
      .then(async (problemId) => {
        const n = await number;
        if (n == null) {
          patch({ status: "done", number: null });
          return;
        }
        const entry = await attachNumberAndAnswer(problemId, n, answerByNumber).catch(() => null);
        patch({ status: "done", number: n, answer: entry?.answer ?? null });
        router.refresh();
      })
      .catch((err) =>
        patch({ status: "error", error: err instanceof Error ? err.message : "저장에 실패했습니다." }),
      );
  }

  function handleReset() {
    setImageSrc(null);
    setResult(null);
    setRecognizedSourceImage(null);
    setError(null);
    setQueue([]);
    setStage("idle");
  }

  function handleImageError(message: string) {
    setError(message);
    setImageSrc(null);
    setQueue([]);
    // 번호가 정해진 채로 들어온 경우 사진만 다시 고르면 되므로 업로드
    // 화면에 그대로 둔다(번호 선택으로 튕기지 않는다).
    setStage("idle");
  }

  async function handleSaveToCategory({
    pngDataUrl,
    text,
    answer,
    answerType,
    boxRange,
    problemId,
  }: {
    pngDataUrl: string;
    text: string;
    answer: string;
    answerType: AnswerType;
    boxRange: StoredBoxRange;
    /** 이미 저장한 문제면 그 id. 새 행을 만들지 않고 그 행을 갱신한다. */
    problemId?: string | null;
  }): Promise<string> {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error("로그인이 필요합니다.");

    const blob = await (await fetch(pngDataUrl)).blob();
    const path = `${user.id}/${categoryId}/${crypto.randomUUID()}.png`;

    const up = await putBlob(supabase, path, blob, "image/png");
    if (!up.ok) throw new Error(up.error);

    // 그림마다 인라인 base64(markup·origin)를 스토리지로 옮긴다. DB 에 그림을
    // base64 로 그대로 담아 두는 것이 카드 원본과는 별개의 저장 위치 문제라
    // (figureBlob.ts 참고) 카드를 R2 로 옮긴 것과 무관하게 이 자리도 옮긴다.
    const figures = boxRange.figures
      ? await persistFigureBlobs(supabase, `${user.id}/${categoryId}`, boxRange.figures)
      : boxRange.figures;
    const persistedBoxRange = { ...boxRange, figures };

    // 새 오답은 목록 맨 뒤에 오도록 기존 최대 sort_order + 1을 준다.
    const { data: maxRow } = await supabase
      .from("problems")
      .select("sort_order")
      .eq("category_id", categoryId)
      .order("sort_order", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    const nextOrder = (maxRow?.sort_order ?? 0) + 1;

    const fields = {
      // 사용자가 결과 화면에서 손본 최종 본문을 저장한다(원본 인식값이 아니라).
      latex: text || null,
      text_content: text || null,
      answer: answer || null,
      answer_type: answerType,
      // 박스 범위·글자 크기·그림이 한 값에 들어 있다(storedFigures.ts 참고).
      box_range: persistedBoxRange,
    };

    // 이미 저장한 문제를 또 저장하는 건 "고쳐서 다시 저장"이다. 새 행을 만들면
    // 같은 문제가 두 개 생기므로 같은 행을 갱신한다.
    if (problemId) {
      // 갈아 끼우기 **전에** 옛 경로를 알아 둔다. ref 에 없으면(다시 열린
      // 화면 등) 그 값만 따로 읽어 온다 — 짧은 문자열 하나라 거의 공짜다.
      let oldPath = savedPathRef.current.get(problemId) ?? null;
      if (!oldPath) {
        const { data: prev } = await supabase
          .from("problems")
          .select("image_path")
          .eq("id", problemId)
          .maybeSingle();
        oldPath = (prev?.image_path as string | null) ?? null;
      }

      const { error: updateError } = await supabase
        .from("problems")
        .update({ ...fields, image_path: path })
        .eq("id", problemId);
      if (updateError) {
        await removeBlobs([path]);
        throw updateError;
      }
      // 갈아 끼운 **뒤에** 지운다 — 먼저 지웠다가 갱신이 실패하면 행이 없는
      // 파일을 가리켜 목록에 깨진 그림이 뜬다. 실패해도 저장은 성공이다
      // (고아 하나가 남을 뿐이고, 여기서 막으면 저장이 안 된 것처럼 보인다).
      if (oldPath && oldPath !== path) {
        await removeBlobs([oldPath, thumbPathFor(oldPath)]);
      }
      router.refresh();
      savedPathRef.current.set(problemId, path);
      return problemId;
    }

    const { data: inserted, error: insertError } = await supabase
      .from("problems")
      .insert({
        category_id: categoryId,
        user_id: user.id,
        image_path: path,
        ...fields,
        sort_order: nextOrder,
      })
      .select("id")
      .single();
    if (insertError || !inserted) {
      // 실패 시 업로드한 이미지도 함께 정리한다.
      await removeBlobs([path]);
      throw insertError ?? new Error("저장에 실패했습니다.");
    }

    router.refresh();
    savedPathRef.current.set(inserted.id as string, path);
    return inserted.id as string;
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {stage === "idle" && canAdd && (
        <button
          type="button"
          onClick={() => setStage("upload")}
          className="g-btn g-btn-primary self-start"
        >
          + 오답 추가
        </button>
      )}

      {/* 지면 통째로 넣기. 손으로 네모를 그려 자르는 것은 누구나 쓴다 —
          모델을 부르지 않아 공짜다. 영역을 **자동으로** 찾는 것만 무제한
          계정에서 보이고, 막는 자리는 서버다(화면은 우회할 수 있다). */}
      {stage === "idle" && canAdd && (
        <BatchSplitPanel
          onSave={handleSaveToCategory}
          answerByNumber={answerByNumber}
          unlimited={tokenStatus?.unlimited ?? false}
          byok={tokenStatus?.byok ?? false}
          figureCost={tokenStatus?.figureCost ?? null}
        />
      )}

      {/* 국어는 지문 한 편에 문항 여러 개가 딸려서 낱개로 넣으면 인쇄할 때
          지문과 문제가 갈라진다. 세트로 묶어 넣는 길을 따로 둔다. */}
      {stage === "idle" && canAdd && (
        <KoreanModePanel
          onSave={handleSaveToCategory}
          unlimited={tokenStatus?.unlimited ?? false}
          byok={tokenStatus?.byok ?? false}
          figureCost={tokenStatus?.figureCost ?? null}
        />
      )}

      {/* 이미 깔끔하게 잘려 있는 사진 여러 장 + 정답 CSV(학원가 "연계교재
          선별" 자료가 흔히 이 모양)를 한 번에 매칭해서 올린다. 크롭·인식이
          필요 없으니 토큰도 안 든다. */}
      {stage === "idle" && canAdd && <BulkMappedImportPanel categoryId={categoryId} />}

      {stage === "idle" && !canAdd && (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p>토큰을 모두 사용해 오답을 더 추가할 수 없어요. 이용권을 구매하면 5000토큰이 충전돼요.</p>
          <a
            href="/api/checkout?plan=tokens"
            className="w-fit rounded-lg bg-amber-600 px-4 py-2 text-xs font-medium text-white hover:bg-amber-700"
          >
            이용권 구매하기
          </a>
        </div>
      )}

      {stage === "upload" && (
        <div key="upload" className="animate-stage-in flex flex-col gap-2">
          <ImageUploader
            onImagesSelected={handleImagesSelected}
            onError={handleImageError}
          />
          {/* 저장 직후 자동으로 이 화면이 열리기도 하므로, 그만 넣고 싶을 때
              빠져나갈 길을 둔다. */}
          <button
            type="button"
            onClick={handleReset}
            className="self-start text-xs text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
          >
            그만 추가하기
          </button>
        </div>
      )}

      {stage === "crop" && (
        <p className="text-sm text-slate-500">
          &quot;원본 그대로 넣기&quot;나 &quot;AI로 다시 그리기&quot;를 누르면 바로 다음 사진으로
          넘어가요. 저장·번호 인식·정답 붙이기는 뒤에서 알아서 해요.
          {queue.length > 0 && ` · ${queue.length}장 남음`}
        </p>
      )}

      {quick.length > 0 && stage !== "result" && stage !== "loading" && (
        <QuickList
          items={quick}
          onClear={() =>
            setQuick((prev) => prev.filter((q) => q.status === "saving" || q.status === "saved"))
          }
        />
      )}

      {stage === "crop" && imageSrc && (
        <div key={imageSrc} className="animate-stage-in">
        <CropStage
          imageSrc={imageSrc}
          onConfirm={handleCropConfirm}
          onCancel={handleReset}
          onError={handleImageError}
          problemTokenCost={tokenStatus?.figureCost ?? null}
          unlimited={tokenStatus?.unlimited ?? false}
          byok={tokenStatus?.byok ?? false}
        />
        </div>
      )}

      {stage === "loading" && (
        <div
          key="loading"
          className="animate-stage-in flex flex-col items-center gap-4 py-16"
        >
          <div className="relative h-12 w-12">
            <div className="absolute inset-0 rounded-full border-4 border-slate-200" />
            <div className="absolute inset-0 animate-spin rounded-full border-4 border-transparent border-t-blue-600" />
          </div>
          <div className="flex flex-col items-center gap-1">
            <p className="text-sm font-medium text-slate-700">
              문제를 읽고 있어요
            </p>
            <p className="text-xs text-slate-400">
              글자와 수식을 인식하는 중입니다. 보통 몇 초면 끝나요.
            </p>
          </div>
          {/* 진행률을 알 수 없으니 좌우로 흐르는 막대로 "돌아가는 중"만 보여준다. */}
          <div className="h-1 w-40 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full w-1/3 animate-loading-sweep rounded-full bg-blue-600" />
          </div>
        </div>
      )}

      {stage === "result" && result && (
        <div key="result" className="animate-stage-in">
        <ResultStage
          result={result}
          onBack={() => setStage("crop")}
          onRestart={handleReset}
          onSaveToCategory={handleSaveToCategory}
          remainingCount={queue.length}
          onNext={advanceQueue}
          onAddAnother={startAnother}
          sourceImage={recognizedSourceImage}
        />
        </div>
      )}
    </div>
  );
}

/** 방금 넣은 문제들 — 저장 중 / 번호 · 정답 / 실패. AI 진행은 오른쪽 아래 패널에 뜬다. */
function QuickList({ items, onClear }: { items: QuickItem[]; onClear: () => void }) {
  const busy = items.some((q) => q.status === "saving" || q.status === "saved");
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-slate-600">
          방금 넣은 문제 {items.length}개{busy ? " · 뒤에서 처리 중" : ""}
        </p>
        {!busy && (
          <button type="button" onClick={onClear} className="text-xs text-slate-400 hover:text-slate-600">
            지우기
          </button>
        )}
      </div>
      <ul className="flex flex-wrap gap-2">
        {items.map((q) => (
          <li key={q.key} className="flex w-44 items-center gap-2 rounded border border-slate-100 p-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={q.crop} alt="" className="h-10 w-10 shrink-0 rounded object-cover object-top" />
            <span
              className={`min-w-0 text-xs ${
                q.status === "error"
                  ? "text-red-600"
                  : q.status === "done"
                    ? "text-slate-700"
                    : "animate-pulse text-slate-400"
              }`}
            >
              {q.status === "saving" && "저장 중…"}
              {q.status === "saved" && "번호 읽는 중…"}
              {q.status === "error" && (q.error ?? "실패")}
              {q.status === "done" &&
                (q.number == null
                  ? "번호 못 읽음 — 목록에서 적어 주세요"
                  : `${q.number}번${q.answer ? ` · 정답 ${q.answer}` : " · 정답 없음"}`)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
