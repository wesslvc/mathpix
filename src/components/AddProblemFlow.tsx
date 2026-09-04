"use client";

import { useEffect, useRef, useState } from "react";
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
import { parseProblemNumber } from "@/lib/problemNumber";
import type { DiagramLayout } from "@/lib/diagramLayout";
import BatchSplitPanel from "./BatchSplitPanel";
import KoreanModePanel from "./KoreanModePanel";
import BulkMappedImportPanel from "./BulkMappedImportPanel";

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
  presetNumber = null,
  presetAnswer,
  gradeId = null,
  onDone,
}: {
  categoryId: string;
  /** false면 토큰이 없음 → 오답 추가 대신 이용권 안내를 보여준다. */
  canAdd?: boolean;
  /**
   * **자동채점에서 넘어온 경우에만 쓴다.** 정해진 값이 있으면 이 문제는
   * "몇 번인지 적어라"가 아니라 "이미 몇 번인지 정해져 있다" — 그래서
   * 처음 화면(+오답추가·지면 통째로 넣기)을 건너뛰고 곧바로 사진 올리기로
   * 들어가며, 저장할 때 `box_range.number`가 이 값으로 정해진다.
   * (`GradeProblemUploader`가 번호를 먼저 고르게 한 다음 이 컴포넌트를
   * 그 번호로 새로 마운트한다 — "문제 업로드할 때 가장 먼저" 번호부터
   * 정하라는 요청이 이 순서다.)
   */
  presetNumber?: number | null;
  /**
   * **자동채점에서 넘어온 경우에만 쓴다.** 채점할 때 이미 읽어 둔 이
   * 문항의 정답을 정답 칸에 미리 채워 준다 — 사용자가 정답표를 보고
   * 다시 옮겨 적을 필요가 없다. 고치는 것은 자유롭다.
   */
  presetAnswer?: string;
  /**
   * **자동채점에서 넘어온 경우에만 쓴다.** 이 문제가 어느 채점 기록
   * (`exam_scores.id`)에서 왔는지 `box_range.gradeId`에 심어 둔다 — 문제
   * 번호만으로는 같은 실모에 여러 번 채점한 경우 어느 시험에서 온 문제인지
   * 구분할 수 없다. 실모↔채점 기록을 양쪽에서 확인할 수 있게 하는
   * 명시적인 연결이다.
   */
  gradeId?: string | null;
  /** 이 번호의 작업이 끝났다(저장 완료 또는 취소) — 번호 선택 화면으로 돌아간다. */
  onDone?: () => void;
}) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>(presetNumber != null ? "upload" : "idle");
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
  /**
   * "원본 그대로 넣기"에서 뒤늦게 읽어 온 문제 번호와, 이미 저장된 행의 id.
   *
   * **state 가 아니라 ref 인 이유**: 저장은 `ResultStage` 가 부르는데 그때
   * 최신 값이어야 한다. state 로 두면 저장 함수가 예전 렌더의 값을 붙들고
   * 있어 번호가 빠진 채로 저장된다.
   */
  const autoNumberRef = useRef<number | null>(null);
  const savedIdRef = useRef<string | null>(null);

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
      // 번호가 정해져 있으면 이 문제 하나만 받는다 — 여러 장을 한꺼번에
      // 넣어도 전부 같은 번호가 될 수는 없으니 나머지는 버린다.
      setQueue(presetNumber != null ? [] : rest);
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
    mode: "ocr" | "problem" | "asis",
  ) {
    if (mode === "problem") {
      await recognizeAsWholeImage(croppedDataUrl);
      return;
    }
    if (mode === "asis") {
      await insertAsIs(croppedDataUrl);
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

  /**
   * **원본 그대로 넣기.** 인식도 생성도 하지 않고 오려낸 그림 한 장을 그대로
   * 문제로 삼는다.
   *
   * 지면 통째로 넣기에만 있던 길인데 문제 한 장을 넣을 때도 필요하다는
   * 요청이 있었다 — 이미 깨끗한 인쇄물이면 다시 그릴 이유가 없고, 글자로
   * 옮기면 오히려 표·그림이 무너진다. 저장 모양은 "통째로 다시 그리기"와
   * 똑같아서(`initialFigures`) 수정·PDF 가 전부 기존 길을 그대로 탄다.
   *
   * **번호만 뒤에서 읽는다**(1토큰). 본문이 없으면 번호를 뽑을 데가 없어
   * 목록·PDF 가 저장된 차례대로 1번부터 매겨 실제 시험지와 어긋난다.
   * 기다리지는 않는다 — 늦게 도착하면 이미 저장된 행에 따로 붙인다.
   */
  async function insertAsIs(croppedDataUrl: string) {
    setError(null);
    try {
      const id = crypto.randomUUID();
      setInitialFigures([
        { id, svg: await rasterToSvg(croppedDataUrl), layout: WHOLE_PROBLEM_LAYOUT },
      ]);
      // 본문은 비워 둔다. 본문이 있으면 "수정" 화면이 본문으로 카드를 다시
      // 그려 그림이 사라진다(storedFigures.ts 주석 참고).
      setResult({ mock: false, latex: "", text: "", confidence: null, diagrams: [] });
      setRecognizedSourceImage(croppedDataUrl);
      setStage("result");
      if (presetNumber == null) void readNumberInBackground(croppedDataUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "알 수 없는 오류");
      setStage("crop");
    }
  }

  /**
   * 번호만 읽어 둔다. 아직 저장 전이면 저장할 때 함께 심고, 이미 저장됐으면
   * 그 행에 따로 붙인다(`set_problem_numbers` — box_range 를 통째로 내려받지
   * 않고 서버에서 합친다).
   */
  async function readNumberInBackground(crop: string) {
    try {
      const res = await fetch("/api/mathpix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: await enhanceContrast(crop) }),
      });
      if (!res.ok) return;
      const json = (await res.json()) as { text?: string; latex?: string };
      const n = parseProblemNumber(json.text || json.latex || "");
      if (n == null) return;
      autoNumberRef.current = n;
      const saved = savedIdRef.current;
      if (!saved) return;
      await createClient().rpc("set_problem_numbers", {
        p_updates: [{ id: saved, number: n }],
      });
      router.refresh();
    } catch {
      // 번호를 못 읽어도 저장은 되어야 한다. "수정"에서 적거나 나중에
      // "전체 번호 인식"으로 붙일 수 있다.
    }
  }

  function handleReset() {
    // 번호가 정해진 채로 들어온 경우 "idle"(+오답추가·지면 통째로 넣기)로
    // 돌아가면 안 된다 — 그 화면은 번호 제약이 없는 일반 흐름이다. 대신
    // 번호 선택 화면으로 돌려보낸다.
    if (presetNumber != null) {
      onDone?.();
      return;
    }
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
    // 번호가 정해진 채로 들어온 경우 사진만 다시 고르면 되므로 업로드
    // 화면에 그대로 둔다(번호 선택으로 튕기지 않는다).
    setStage(presetNumber != null ? "upload" : "idle");
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
      // 번호가 미리 정해져 있으면(자동채점 연동) 여기서 심는다 — 사용자가
      // 따로 "문제 번호" 칸에 적을 필요가 없다. gradeId도 함께 심어 어느
      // 채점 기록에서 온 문제인지 명시적으로 남긴다.
      // "원본 그대로 넣기"에서 읽어 둔 번호가 있으면 그것도 심는다(본문이
      // 없어 번호를 뽑을 데가 없는 문제다). 손으로 정한 번호가 늘 우선한다.
      box_range:
        presetNumber != null
          ? { ...boxRange, number: presetNumber, gradeId: gradeId ?? undefined }
          : autoNumberRef.current != null
            ? { ...boxRange, number: autoNumberRef.current }
            : boxRange,
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
      savedIdRef.current = problemId;
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
    savedIdRef.current = inserted.id as string;
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

      {/* 국어는 지문 한 편에 문항 여러 개가 딸려서 낱개로 넣으면 인쇄할 때
          지문과 문제가 갈라진다. 세트로 묶어 넣는 길을 따로 둔다. */}
      {stage === "idle" && canAdd && (
        <KoreanModePanel
          onSave={handleSaveToCategory}
          unlimited={tokenStatus?.unlimited ?? false}
          figureCost={tokenStatus?.figureCost ?? null}
        />
      )}

      {/* 이미 깔끔하게 잘려 있는 사진 여러 장 + 정답 CSV(학원가 "연계교재
          선별" 자료가 흔히 이 모양)를 한 번에 매칭해서 올린다. 크롭·인식이
          필요 없으니 토큰도 안 든다. */}
      {stage === "idle" && canAdd && <BulkMappedImportPanel categoryId={categoryId} />}

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
          {presetNumber != null && (
            <p className="text-sm font-medium text-blue-700">
              {presetNumber}번 문제 사진을 올려주세요
            </p>
          )}
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
            {presetNumber != null ? "취소" : "그만 추가하기"}
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
          // 번호가 정해진 채로 들어온 경우 "다음 문제 추가"는 이 컴포넌트
          // 안에서 이어가면 안 된다 — 다음 문제는 다른 번호일 수 있는데
          // presetNumber는 이 인스턴스가 살아 있는 동안 안 바뀐다. 번호
          // 선택 화면으로 돌려보내 새 번호로 다시 마운트되게 한다.
          onAddAnother={presetNumber != null ? onDone : startAnother}
          sourceImage={recognizedSourceImage}
          initialFigures={initialFigures}
          pendingWholeJob={pendingWholeJob}
          onWholeJobQueued={() => setPendingWholeJob(null)}
          initialAnswer={presetAnswer}
        />
        </div>
      )}
    </div>
  );
}
