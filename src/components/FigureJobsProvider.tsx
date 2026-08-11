"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createClient } from "@/lib/supabase/client";
import {
  MODEL_INPUT_DIM,
  PROBLEM_INPUT_DIM,
  prepareFigureForModel,
  rasterToSvg,
  trimBlankBorder,
} from "@/lib/figureImage";
import type { FigureMode } from "@/lib/figureImageGen";
import {
  figureCacheKey,
  readFigureCache,
  writeFigureCache,
} from "@/lib/figureCache";
import { renderCardOffscreen } from "@/lib/renderCardOffscreen";
import type { CardSpec } from "@/lib/cardHtml";

export type FigureJob = {
  id: string;
  /** 어느 문제의 그림인가. 화면이 닫힌 뒤 저장본을 갱신할 때 쓴다. */
  problemKey: string;
  /** 목록에 보여줄 이름(문제 번호 등). */
  label: string;
  /** 모델에 보낼 원본 크롭. 재시도에도 쓴다. */
  crop: string;
  /**
   * 무엇을 그리는가. 기본은 그림 하나("figure").
   * "problem"이면 문제 한 개 전체를 다시 그린다 — 프롬프트도 입력 해상도도
   * 다르다(본문 글자까지 살아야 해서 더 크게 보낸다).
   */
  mode?: FigureMode;
  status: "pending" | "running" | "done" | "error";
  error?: string;
  /** 완성된 그림 마크업. 화면이 열려 있으면 미리보기에 바로 반영된다. */
  svg?: string;
};

/**
 * 문제 하나를 다시 그려 저장하는 데 필요한 것들. 화면(ResultStage)이 살아 있는
 * 동안 계속 최신으로 갱신해 두고, 화면이 닫힌 뒤에는 이 값만으로 카드를 다시
 * 그려 저장본을 갱신한다.
 */
export type ProblemSnapshot = {
  /** 저장된 problems 행 id. 아직 저장 전이면 null. */
  problemId: string | null;
  spec: CardSpec;
};

type Ctx = {
  jobs: FigureJob[];
  /** 진행 중이거나 대기 중인 작업 수. */
  activeCount: number;
  enqueue: (job: Omit<FigureJob, "status">) => void;
  retry: (id: string) => void;
  dismiss: (id: string) => void;
  /** 화면이 살아 있는 동안 문제의 최신 상태를 알려준다. */
  putSnapshot: (problemKey: string, snapshot: ProblemSnapshot) => void;
};

const FigureJobsContext = createContext<Ctx | null>(null);

export function useFigureJobs(): Ctx {
  const ctx = useContext(FigureJobsContext);
  if (!ctx) throw new Error("FigureJobsProvider 안에서만 쓸 수 있습니다.");
  return ctx;
}

/**
 * AI 그림 작업을 화면 바깥에서 관리한다.
 *
 * 이게 문제 화면(ResultStage)이 아니라 페이지 수준에 있는 이유: **작업이 도는
 * 동안 사용자가 다음 문제로 넘어갈 수 있어야 하기 때문이다.** 화면 안에 큐를
 * 두면 화면이 닫히는 순간 작업이 사라진다.
 *
 * 작업이 끝났을 때 그 문제 화면이 이미 닫혀 있으면, 눈에 안 보이는 곳에 카드를
 * 다시 그려서(renderCardOffscreen) 저장된 이미지를 갱신한다. 화면이 열려 있으면
 * 화면이 알아서 미리보기를 갈아끼우고 저장도 다시 한다.
 */
export default function FigureJobsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [jobs, setJobs] = useState<FigureJob[]>([]);
  /** problemKey -> 그 문제의 최신 상태. 화면이 닫혀도 남는다. */
  const snapshotsRef = useRef<Map<string, ProblemSnapshot>>(new Map());
  /** 한 번에 하나씩만 돌린다(순차 처리). */
  const runningRef = useRef<string | null>(null);

  const putSnapshot = useCallback(
    (problemKey: string, snapshot: ProblemSnapshot) => {
      snapshotsRef.current.set(problemKey, snapshot);
    },
    [],
  );

  /**
   * 같은 id는 한 번만 받는다.
   *
   * **중복 과금을 막는 자리다.** 작업 하나가 곧 유료 API 호출 한 번이라,
   * 실수로 두 번 들어가면 사용자 토큰이 두 배로 빠진다. 실제로 개발 모드의
   * StrictMode가 이펙트를 두 번 실행해 같은 작업이 두 개 쌓인 적이 있다.
   * 버튼을 두 번 누르거나 화면이 다시 그려지는 경우에도 같은 일이 생길 수
   * 있으므로, 넣는 쪽을 믿지 않고 여기서 막는다.
   */
  const enqueue = useCallback((job: Omit<FigureJob, "status">) => {
    setJobs((prev) =>
      prev.some((j) => j.id === job.id)
        ? prev
        : [...prev, { ...job, status: "pending" }],
    );
  }, []);

  const retry = useCallback((id: string) => {
    setJobs((prev) =>
      prev.map((j) =>
        j.id === id ? { ...j, status: "pending", error: undefined } : j,
      ),
    );
  }, []);

  const dismiss = useCallback((id: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== id));
  }, []);

  /**
   * 화면이 닫힌 문제의 저장본을 완성된 그림으로 갱신한다.
   * 화면이 열려 있으면 그쪽이 알아서 다시 저장하므로 여기서는 건드리지 않는다.
   */
  const resaveIfClosed = useCallback(
    async (job: FigureJob, svg: string) => {
      const snap = snapshotsRef.current.get(job.problemKey);
      if (!snap?.problemId) return; // 아직 저장 전이면 갱신할 대상이 없다
      if (snap.spec.figures.every((f) => f.id !== job.id)) return;

      const spec: CardSpec = {
        ...snap.spec,
        figures: snap.spec.figures.map((f) =>
          f.id === job.id ? { ...f, markup: svg } : f,
        ),
      };

      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      const { data: row } = await supabase
        .from("problems")
        .select("image_path, category_id")
        .eq("id", snap.problemId)
        .maybeSingle();
      if (!row) return;

      const dataUrl = await renderCardOffscreen(spec);
      const blob = await (await fetch(dataUrl)).blob();
      const dir = String(row.image_path).split("/").slice(0, -1).join("/");
      const newPath = `${dir}/${crypto.randomUUID()}.png`;

      const { error: upErr } = await supabase.storage
        .from("problem-images")
        .upload(newPath, blob, { contentType: "image/png" });
      if (upErr) throw upErr;

      const { error: dbErr } = await supabase
        .from("problems")
        .update({ image_path: newPath })
        .eq("id", snap.problemId);
      if (dbErr) {
        await supabase.storage.from("problem-images").remove([newPath]);
        throw dbErr;
      }
      await supabase.storage
        .from("problem-images")
        .remove([String(row.image_path)]);

      // 다음 갱신 때도 최신 마크업을 쓰도록 스냅샷을 갱신해 둔다.
      snapshotsRef.current.set(job.problemKey, { ...snap, spec });
    },
    [],
  );

  /** 작업을 하나씩 순서대로 처리하는 일꾼. */
  useEffect(() => {
    if (runningRef.current !== null) return;
    const next = jobs.find((j) => j.status === "pending");
    if (!next) return;

    const id = next.id;
    runningRef.current = id;
    setJobs((prev) =>
      prev.map((j) => (j.id === id ? { ...j, status: "running" } : j)),
    );

    (async () => {
      try {
        // 입력 토큰을 줄이려고 긴 변을 낮춰 보낸다. 문제 전체는 본문 글자까지
        // 살아야 해서 그림 하나(768px)보다 크게 보낸다.
        const mode: FigureMode = next.mode ?? "figure";
        const forModel = await prepareFigureForModel(
          next.crop,
          mode === "problem" ? PROBLEM_INPUT_DIM : MODEL_INPUT_DIM,
        );

        // 같은 그림을 이미 그린 적이 있으면 그대로 쓴다(세트 문항 대비).
        // 모드를 키에 섞는다 — 같은 이미지라도 그림용과 문제 전체용은 결과가
        // 다르므로 서로의 결과를 물려받으면 안 된다.
        const key = await figureCacheKey(`${mode}:${forModel}`);
        let svg = readFigureCache(key);

        if (!svg) {
          const res = await fetch("/api/figure", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: forModel, mode }),
          });
          let json: { image?: string; error?: string };
          try {
            json = await res.json();
          } catch {
            throw new Error(
              "서버에서 정상적인 응답을 받지 못했어요. 이미지 생성이 60초를 넘겨 요청이 끊겼을 수 있습니다. 영역을 더 좁게 잘라 다시 시도해주세요.",
            );
          }
          if (!res.ok) throw new Error(json.error ?? "그림을 그리지 못했습니다.");
          if (
            typeof json.image !== "string" ||
            !json.image.startsWith("data:image/")
          ) {
            throw new Error("서버가 이미지를 돌려주지 않았어요.");
          }
          // 생성 모델은 자기 비율에 맞춰 그려서 둘레에 흰 여백을 붙여 준다.
          svg = await rasterToSvg(await trimBlankBorder(json.image));
          writeFigureCache(key, svg);
        }

        setJobs((prev) =>
          prev.map((j) =>
            j.id === id ? { ...j, status: "done", svg: svg as string } : j,
          ),
        );

        // 화면이 닫혔으면 저장본을 여기서 갱신한다(열려 있으면 화면이 한다).
        try {
          await resaveIfClosed({ ...next, svg }, svg);
        } catch (err) {
          console.error("[figureJobs] 저장본 갱신 실패:", err);
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "그림을 그리지 못했습니다.";
        setJobs((prev) =>
          prev.map((j) =>
            j.id === id ? { ...j, status: "error", error: message } : j,
          ),
        );
      } finally {
        runningRef.current = null;
      }
    })();
  }, [jobs, resaveIfClosed]);

  const activeCount = jobs.filter(
    (j) => j.status === "pending" || j.status === "running",
  ).length;

  return (
    <FigureJobsContext.Provider
      value={{ jobs, activeCount, enqueue, retry, dismiss, putSnapshot }}
    >
      {children}
    </FigureJobsContext.Provider>
  );
}
