"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import ImageUploader from "@/components/ImageUploader";
import CropStage from "@/components/CropStage";
import ResultStage from "@/components/ResultStage";
import { createClient } from "@/lib/supabase/client";
import type { RecognizeResponse } from "@/lib/types";
import type { AnswerType } from "@/lib/answer";
import type { StoredBoxRange } from "@/lib/storedFigures";
import type { TokenStatus } from "@/app/api/tokens/route";
import { rasterToSvg } from "@/lib/figureImage";
import { uploadThumb } from "@/lib/cardThumb";
import { enhanceContrast } from "@/lib/autoContrast";
import type { DiagramLayout } from "@/lib/diagramLayout";
import BatchSplitPanel from "./BatchSplitPanel";

/**
 * "통째로 AI로 다시 그리기"로 만든 문제 이미지의 배치.
 * 카드를 꽉 채우고 위 여백을 두지 않는다 — 이 그림 한 장이 곧 문제다.
 */
const WHOLE_PROBLEM_LAYOUT: DiagramLayout = {
  scale: 100,
  offsetX: 0,
  offsetY: 0,
};

type Stage = "idle" | "upload" | "crop" | "loading" | "result";

export default function AddProblemFlow({
  categoryId,
  canAdd = true,
}: {
  categoryId: string;
  /** false면 토큰이 없음 → 오답 추가 대신 이용권 안내를 보여준다. */
  canAdd?: boolean;
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
  /**
   * 통째로 다시 그려 만든 문제 이미지. ResultStage에 처음부터 붙여 준다.
   * 이 경우 본문 텍스트는 비어 있고 이 그림 한 장이 곧 문제다.
   */
  const [initialFigures, setInitialFigures] = useState<
    { id: string; svg: string; layout?: DiagramLayout }[] | undefined
  >(undefined);
  /**
   * 결과 화면이 뜨면 큐에 넣을 "문제 전체 다시 그리기" 작업.
   * ResultStage가 그 문제의 키를 만들어 주므로 화면이 뜬 다음에 넣는다.
   */
  const [pendingWholeJob, setPendingWholeJob] = useState<{
    id: string;
    crop: string;
  } | null>(null);
  /** 크롭 화면에 "통째로 다시 그리기" 비용을 표시하려고 읽어둔다. */
  const [tokenStatus, setTokenStatus] = useState<TokenStatus | null>(null);

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
    setInitialFigures(undefined);
    setPendingWholeJob(null);
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
    setInitialFigures(undefined);
    setPendingWholeJob(null);
    setError(null);
    setStage("upload");
  }

  async function handleCropConfirm(
    croppedDataUrl: string,
    mode: "ocr" | "problem",
  ) {
    if (mode === "problem") {
      await recognizeAsWholeImage(croppedDataUrl);
      return;
    }
    setStage("loading");
    setError(null);
    setInitialFigures(undefined);
    setPendingWholeJob(null);
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
   * 문제를 **통째로** 다시 그리는 길로 들어간다.
   *
   * 탐구처럼 표·지도·그림이 뒤섞인 문제는 글자로 옮겨 재구성하는 것보다 이쪽이
   * 원본에 가깝다는 판단(사용자가 실제로 비교해보고 정함). Mathpix는 부르지
   * 않으므로 인식 토큰도 쓰지 않는다.
   *
   * **기다리지 않는다.** 생성은 1분쯤 걸리는데 그동안 화면을 붙잡아 두면 아무
   * 것도 못 한다. 그래서 오려낸 원본을 곧바로 카드에 붙여 결과 화면으로 넘기고,
   * 실제 생성은 화면 바깥 큐(FigureJobsProvider)에 맡긴다 — 사용자는 그 사이에
   * 정답을 적어 두거나 다음 사진으로 넘어갈 수 있다. 완성되면 화면이 열려 있으면
   * 미리보기가 갈아끼워지고, 이미 닫혔으면 저장본이 알아서 갱신된다.
   */
  async function recognizeAsWholeImage(croppedDataUrl: string) {
    setError(null);
    try {
      // 원본을 그대로 붙여 둔다. 빈 자리를 만들지 않으려는 것이고, 완성 전에
      // 저장하더라도 최소한 원본이 든 멀쩡한 이미지가 저장된다.
      const id = crypto.randomUUID();
      const placeholder = await rasterToSvg(croppedDataUrl);
      setInitialFigures([
        { id, svg: placeholder, layout: WHOLE_PROBLEM_LAYOUT },
      ]);
      // 본문 텍스트는 없다 — 이 그림 한 장이 곧 문제다.
      setResult({
        mock: false,
        latex: "",
        text: "",
        confidence: null,
        diagrams: [],
      });
      setRecognizedSourceImage(croppedDataUrl);
      setStage("result");
      // 화면을 넘긴 **뒤에** 큐에 넣는다. ResultStage가 이 id로 자리를 잡고
      // 있어야 완성된 그림이 그 자리에 들어간다.
      setPendingWholeJob({ id, crop: croppedDataUrl });
    } catch (err) {
      setError(err instanceof Error ? err.message : "알 수 없는 오류");
      setStage("crop");
    }
  }

  function handleReset() {
    setImageSrc(null);
    setResult(null);
    setRecognizedSourceImage(null);
    setInitialFigures(undefined);
    setPendingWholeJob(null);
    setError(null);
    setQueue([]);
    setStage("idle");
  }

  function handleImageError(message: string) {
    setError(message);
    setImageSrc(null);
    setQueue([]);
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

    const { error: uploadError } = await supabase.storage
      .from("problem-images")
      .upload(path, blob, { contentType: "image/png" });
    if (uploadError) throw uploadError;

    // 목록에 쓸 작은 미리보기를 같이 올린다(cardThumb.ts 참고). 실패해도
    // 그냥 진행한다 — 없으면 목록이 원본을 쓸 뿐이다.
    await uploadThumb(supabase, path, pngDataUrl);

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
      latex: text || result?.latex || null,
      text_content: text || result?.text || null,
      answer: answer || null,
      answer_type: answerType,
      // 박스 범위·글자 크기·그림이 한 값에 들어 있다(storedFigures.ts 참고).
      box_range: boxRange,
    };

    // 이미 저장한 문제를 또 저장하는 건 "고쳐서 다시 저장"이다. 새 행을 만들면
    // 같은 문제가 두 개 생기므로 같은 행을 갱신한다.
    if (problemId) {
      const { error: updateError } = await supabase
        .from("problems")
        .update({ ...fields, image_path: path })
        .eq("id", problemId);
      if (updateError) {
        await supabase.storage.from("problem-images").remove([path]);
        throw updateError;
      }
      router.refresh();
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
      await supabase.storage.from("problem-images").remove([path]);
      throw insertError ?? new Error("저장에 실패했습니다.");
    }

    router.refresh();
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
          unlimited={tokenStatus?.unlimited ?? false}
          figureCost={tokenStatus?.figureCost ?? null}
        />
      )}

      {stage === "idle" && !canAdd && (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p>토큰을 모두 사용해 오답을 더 추가할 수 없어요. 이용권을 구매하면 1000토큰이 충전돼요.</p>
          <a
            href="/api/checkout"
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

      {queue.length > 0 && (stage === "crop" || stage === "loading") && (
        <p className="text-sm text-slate-500">
          이 문제를 저장하면 다음 이미지로 넘어갑니다 · {queue.length}장 남음
        </p>
      )}

      {stage === "crop" && imageSrc && (
        <div key={imageSrc} className="animate-stage-in">
        <CropStage
          imageSrc={imageSrc}
          onConfirm={handleCropConfirm}
          onCancel={handleReset}
          onError={handleImageError}
          problemTokenCost={tokenStatus?.figureCost ?? null}
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
          initialFigures={initialFigures}
          pendingWholeJob={pendingWholeJob}
          onWholeJobQueued={() => setPendingWholeJob(null)}
        />
        </div>
      )}
    </div>
  );
}
