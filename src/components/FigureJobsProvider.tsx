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
  prepareFigureForModel,
  prepareProblemForModel,
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

/**
 * 같은 크롭을 글자 인식기(Mathpix)에 한 번 보내 본문을 읽어 둔다.
 *
 * 실패하면 조용히 포기한다 — 참고 없이도 그림은 만들어진다. 인식 토큰이
 * 하나 들지만, 문제 전체를 다시 그리는 값(FIGURE_TOKEN_COST)에 비하면 작고
 * 글자가 틀리는 쪽이 훨씬 비싸다.
 */
async function readTextForReference(image: string): Promise<string | undefined> {
  try {
    const res = await fetch("/api/mathpix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image }),
    });
    if (!res.ok) return undefined;
    const json: { text?: string; latex?: string; mock?: boolean } = await res.json();
    // mock 응답(키 미설정)은 가짜 글자라 참고로 쓰면 오히려 해롭다.
    if (json.mock) return undefined;
    const text = (json.text || json.latex || "").trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

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
  /**
   * 저장된 문제 행 id. 문제 전체를 그리는 경우 서버가 이 행에 결과를 직접
   * 저장한다 — 브라우저를 닫아도 결과가 남게 하려는 것이다.
   */
  problemId?: string | null;
  status: "pending" | "running" | "done" | "error";
  /**
   * 글자 인식(Mathpix)이 어떻게 됐는가. **문제 전체를 그릴 때만** 쓴다.
   *   reading — 지금 읽는 중
   *   ok      — 읽어서 프롬프트에 참고로 넣었다
   *   none    — 못 읽었다(키가 없거나 실패). 참고 없이 그린다
   * 화면에 그대로 보여 준다 — 글자 정확도가 걸린 단계라 됐는지 안 됐는지
   * 눈에 보여야 한다.
   */
  ocr?: "reading" | "ok" | "none";
  /** 읽어 낸 글자의 앞부분. 무엇을 참고했는지 눈으로 확인할 수 있게. */
  ocrPreview?: string;
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
  /**
   * 하나가 끝났으니 다음 것을 보라고 일꾼을 깨우는 신호.
   *
   * **`jobs` 만 바라보면 큐가 멈춘다.** 작업이 끝날 때 순서가 이렇다 —
   * `setJobs(완료)` → React 가 다시 그림 → 일꾼 이펙트가 도는데 이때
   * `runningRef` 는 아직 비워지기 전이라 그냥 돌아간다 → 그 뒤에 `runningRef`
   * 가 비워지지만 **더 이상 상태가 바뀌지 않아 이펙트가 다시 돌지 않는다.**
   * 대기 중인 작업이 있어도 아무도 집어가지 않고 그대로 쌓인다(실제로 몇 개
   * 넣으면 멈췄다). 그래서 ref 를 비운 **다음에** 이 값을 올려 확실히 깨운다.
   */
  const [wake, setWake] = useState(0);

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
          f.id === job.id ? { ...f, markup: svg, ai: true } : f,
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
        // 입력 토큰을 줄이려고 크기를 낮춰 보낸다. 그림 하나는 긴 변 768px이면
        // 되지만, 문제 전체는 본문 글자까지 살아야 해서 **폭**을 기준으로 맞춘다
        // (긴 변으로 줄이면 세로로 긴 문제의 폭이 무너져 글자가 뭉개진다).
        const mode: FigureMode = next.mode ?? "figure";
        const forModel =
          mode === "problem"
            ? await prepareProblemForModel(next.crop)
            : await prepareFigureForModel(next.crop, MODEL_INPUT_DIM);

        // 같은 그림을 이미 그린 적이 있으면 그대로 쓴다(세트 문항 대비).
        // 모드를 키에 섞는다 — 같은 이미지라도 그림용과 문제 전체용은 결과가
        // 다르므로 서로의 결과를 물려받으면 안 된다.
        const key = await figureCacheKey(`${mode}:${forModel}`);
        let svg = readFigureCache(key);

        if (!svg) {
          // **문제 전체는 글자 인식을 함께 쓴다.**
          // 이미지 생성 모델은 글자를 자주 틀리는데(그림은 모양만 맞으면 되지만
          // 문제는 한 글자로 답이 뒤집힌다), Mathpix 는 반대로 글자를 읽는 일에
          // 맞춰져 있다. 읽은 본문을 프롬프트에 함께 주면 모델이 지어내지 않고
          // 베껴 쓴다. 둘의 잘하는 것을 겹쳐 쓰는 셈이다.
          //
          // **실패해도 그냥 진행한다.** 참고가 없으면 예전과 똑같이 동작할
          // 뿐이라, 이것 때문에 그림 생성을 막을 이유가 없다.
          let reference: string | undefined;
          if (mode === "problem") {
            setJobs((prev) =>
              prev.map((j) => (j.id === id ? { ...j, ocr: "reading" as const } : j)),
            );
            reference = await readTextForReference(forModel);
            setJobs((prev) =>
              prev.map((j) =>
                j.id === id
                  ? {
                      ...j,
                      ocr: reference ? ("ok" as const) : ("none" as const),
                      ocrPreview: reference?.replace(/\s+/g, " ").slice(0, 60),
                    }
                  : j,
              ),
            );
          }
          const res = await fetch("/api/figure", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              image: forModel,
              mode,
              // 서버가 결과를 직접 저장할 수 있게 알려준다(탭을 닫아도 남는다).
              // 작업을 넣을 때는 아직 저장 전일 수 있어서, 화면이 계속 갱신해
              // 주는 스냅샷에서 **호출 직전에** 최신 행 id를 읽는다.
              problemId:
                next.problemId ??
                snapshotsRef.current.get(next.problemKey)?.problemId ??
                null,
              figureId: next.id,
              reference,
            }),
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
        // **기다리지 않는다.** 이건 이미지를 올리고 DB를 고치는 일이라 몇 초씩
        // 걸리는데, 그동안 다음 작업이 시작도 못 하면 줄이 하염없이 밀린다.
        void resaveIfClosed({ ...next, svg }, svg).catch((err) => {
          console.error("[figureJobs] 저장본 갱신 실패:", err);
        });
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
        // 비운 **다음에** 깨운다. 순서가 바뀌면 다음 작업을 아무도 집어가지 않는다.
        setWake((n) => n + 1);
      }
    })();
  }, [jobs, wake, resaveIfClosed]);

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
