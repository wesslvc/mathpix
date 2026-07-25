"use client";

import { useState } from "react";
import ImageUploader from "@/components/ImageUploader";
import CropStage from "@/components/CropStage";
import ResultStage from "@/components/ResultStage";
import type { RecognizeResponse } from "@/lib/types";

type Stage = "upload" | "crop" | "loading" | "result";

export default function Home() {
  const [stage, setStage] = useState<Stage>("upload");
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

  function handleRestart() {
    setImageSrc(null);
    setResult(null);
    setError(null);
    setStage("upload");
  }

  function handleImageError(message: string) {
    setError(message);
    setImageSrc(null);
    setStage("upload");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-4 py-10">
      <header>
        <h1 className="text-2xl font-bold text-ink">문제 이미지 재구성기</h1>
        <p className="mt-1 text-sm text-slate-500">
          사진을 올리면 문제 영역을 자동으로 찾아주고, 최종 확인 후 Mathpix로
          인식해 가독성 좋은 이미지로 다시 만들어 드립니다.
        </p>
      </header>

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
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
          onCancel={handleRestart}
          onError={handleImageError}
        />
      )}

      {stage === "loading" && (
        <div className="flex flex-col items-center gap-3 py-20 text-slate-500">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-300 border-t-blue-600" />
          <p>Mathpix로 문제를 인식하는 중입니다...</p>
        </div>
      )}

      {stage === "result" && result && (
        <ResultStage
          result={result}
          onBack={() => setStage("crop")}
          onRestart={handleRestart}
        />
      )}
    </main>
  );
}
