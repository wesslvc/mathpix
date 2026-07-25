"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import ImageUploader from "@/components/ImageUploader";
import CropStage from "@/components/CropStage";
import ResultStage from "@/components/ResultStage";
import { createClient } from "@/lib/supabase/client";
import type { RecognizeResponse } from "@/lib/types";

type Stage = "idle" | "upload" | "crop" | "loading" | "result";

export default function AddProblemFlow({ categoryId }: { categoryId: string }) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("idle");
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [result, setResult] = useState<RecognizeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleImageSelected(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      setImageSrc(reader.result as string);
      setError(null);
      setStage("crop");
    };
    reader.readAsDataURL(file);
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
      setStage("result");
    } catch (err) {
      setError(err instanceof Error ? err.message : "알 수 없는 오류");
      setStage("crop");
    }
  }

  function handleReset() {
    setImageSrc(null);
    setResult(null);
    setError(null);
    setStage("idle");
  }

  function handleImageError(message: string) {
    setError(message);
    setImageSrc(null);
    setStage("idle");
  }

  async function handleSaveToCategory(pngDataUrl: string) {
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

    const { error: insertError } = await supabase.from("problems").insert({
      category_id: categoryId,
      user_id: user.id,
      image_path: path,
      latex: result?.latex ?? null,
      text_content: result?.text ?? null,
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

      {stage === "idle" && (
        <button
          type="button"
          onClick={() => setStage("upload")}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          + 오답 추가
        </button>
      )}

      {stage === "upload" && (
        <ImageUploader
          onImageSelected={handleImageSelected}
          onError={handleImageError}
        />
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
        />
      )}
    </div>
  );
}
