"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import ImageUploader from "@/components/ImageUploader";
import CropStage from "@/components/CropStage";
import ResultStage from "@/components/ResultStage";
import { createClient } from "@/lib/supabase/client";
import type { RecognizeResponse } from "@/lib/types";
import type { AnswerType } from "@/lib/answer";
import type { BoxOverride } from "@/lib/renderMathText";

type Stage = "idle" | "upload" | "crop" | "loading" | "result";

export default function AddProblemFlow({
  categoryId,
  canAdd = true,
}: {
  categoryId: string;
  /** false면 사진인식권이 없음 → 오답 추가 대신 이용권 안내를 보여준다. */
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

  async function handleCropConfirm(croppedDataUrl: string) {
    setStage("loading");
    setError(null);
    try {
      const res = await fetch("/api/mathpix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: croppedDataUrl }),
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
    setStage("idle");
  }

  async function handleSaveToCategory({
    pngDataUrl,
    answer,
    answerType,
    boxOverride,
  }: {
    pngDataUrl: string;
    answer: string;
    answerType: AnswerType;
    boxOverride: BoxOverride | undefined;
  }) {
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

    // 새 오답은 목록 맨 뒤에 오도록 기존 최대 sort_order + 1을 준다.
    const { data: maxRow } = await supabase
      .from("problems")
      .select("sort_order")
      .eq("category_id", categoryId)
      .order("sort_order", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    const nextOrder = (maxRow?.sort_order ?? 0) + 1;

    const { error: insertError } = await supabase.from("problems").insert({
      category_id: categoryId,
      user_id: user.id,
      image_path: path,
      latex: result?.latex ?? null,
      text_content: result?.text ?? null,
      answer: answer || null,
      answer_type: answerType,
      // undefined면 "자동 감지에 맡김"이라 DB에도 null로 둔다.
      box_range: boxOverride ?? null,
      sort_order: nextOrder,
    });
    if (insertError) {
      // 실패 시 업로드한 이미지도 함께 정리한다.
      await supabase.storage.from("problem-images").remove([path]);
      throw insertError;
    }

    router.refresh();
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
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          + 오답 추가
        </button>
      )}

      {stage === "idle" && !canAdd && (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p>사진인식권이 모두 소진돼 오답을 더 추가할 수 없어요. 이용권을 구매하면 1000개가 충전돼요.</p>
          <a
            href="/api/checkout"
            className="w-fit rounded-lg bg-amber-600 px-4 py-2 text-xs font-medium text-white hover:bg-amber-700"
          >
            이용권 구매하기
          </a>
        </div>
      )}

      {stage === "upload" && (
        <div className="flex flex-col gap-2">
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
        <CropStage
          imageSrc={imageSrc}
          onConfirm={handleCropConfirm}
          onCancel={handleReset}
          onError={handleImageError}
        />
      )}

      {stage === "loading" && (
        <div className="flex flex-col items-center gap-3 py-16 text-slate-500">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-300 border-t-blue-600" />
          <p>Mathpix로 문제를 인식하는 중입니다...</p>
        </div>
      )}

      {stage === "result" && result && (
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
      )}
    </div>
  );
}
