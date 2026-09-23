"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  MODEL_INPUT_DIM,
  ensureDataUrl,
  prepareFigureForModel,
  prepareProblemForModel,
  imageSizeOf,
  rasterToSvg,
  trimBlankBorder,
} from "@/lib/figureImage";
import { persistFigureValue } from "@/lib/figureBlob";
import { DEFAULT_FIGURE_MODEL, type FigureMode } from "@/lib/figureImageGen";
import { thumbPathFor } from "@/lib/cardThumb";
import { cardUrl } from "@/lib/cardUrl";
import {
  figureCacheKey,
  readFigureCache,
  writeFigureCache,
} from "@/lib/figureCache";
import { renderCardOffscreen } from "@/lib/renderCardOffscreen";
import { keepOrigin } from "@/lib/figureOrigin";
import { putBlob, removeBlobs } from "@/lib/blobClient";
import { ptToPx, readFontPt } from "@/lib/fontSize";
import { readStoredFigures, restoreCardFigures } from "@/lib/storedFigures";
import type { CardSpec } from "@/lib/cardHtml";
import type { BoxOverride } from "@/lib/renderMathText";

export type FigureJob = {
  id: string;
  /** 어느 문제의 그림인가. 화면이 닫힌 뒤 저장본을 갱신할 때 쓴다. */
  problemKey: string;
  /** 목록에 보여줄 이름(문제 번호 등). */
  label: string;
  /**
   * 모델에 보낼 원본 크롭. 서버에 넣기 전까지만 쓴다(새로고침 뒤 서버에서
   * 되살린 작업에는 없다 — 그때는 서버가 입력을 들고 있다).
   */
  crop: string;
  /**
   * 무엇을 그리는가. 기본은 그림 하나("figure").
   * "problem"이면 문제 한 개 전체를 다시 그린다 — 프롬프트도 입력 해상도도
   * 다르다(본문 글자까지 살아야 해서 더 크게 보낸다).
   */
  mode?: FigureMode;
  /**
   * 저장된 문제 행 id. 서버가 이 행에 결과를 직접 저장한다 — 브라우저를
   * 닫아도 결과가 남게 하려는 것이다.
   */
  problemId?: string | null;
  /**
   * "이렇게 다시 그려 주세요" — 사용자가 적어 준 요청. 프롬프트 끝에 붙는다.
   *
   * 없으면 프롬프트도 캐시 키도 예전과 **한 글자도 다르지 않다.**
   */
  instruction?: string;
  /**
   * 국어인가. 서버가 프롬프트 톤을 고를 때(WHOLE_PROBLEM_PROMPT) 받는 값이다.
   * Mathpix 참고 글은 더 이상 여기서 안 쓴다(2026-09-18).
   */
  korean?: boolean;
  status: "pending" | "running" | "done" | "error";
  /** 이 작업에 실제로 든 **추정** 비용(달러). 캐시에 걸렸으면 없다. */
  costUsd?: number;
  /** 같은 값을 원으로 옮긴 것. 서버가 환율까지 계산해 내려준다. */
  costKrw?: number;
  /** 이 작업에 실제로 물린 토큰. 금액과 달리 누구에게나 보인다. */
  chargedTokens?: number;
  error?: string;
  /** 완성된 그림 마크업. 화면이 열려 있으면 미리보기에 바로 반영된다. */
  svg?: string;
};

/**
 * 화면 밖에서만 쓰는 속사정. `FigureJob` 에 섞어 두면 화면들이 쓰지도 않는
 * 칸을 보게 된다.
 */
type Internal = FigureJob & {
  /** 서버 작업 id. 없으면 아직 서버에 넣는 중이다. */
  serverId?: string;
  /** 서버가 알고 있는 문제 행. null 이면 넣을 때 아직 저장 전이었다. */
  serverProblemId?: string | null;
  resultPath?: string | null;
  appliedAt?: string | null;
  createdAt?: string;
  /** 결과를 받아 오면 로컬 캐시에 넣을 키. */
  cacheKey?: string;
  /**
   * 이 화면에서 넣은 작업인가. 새로고침 뒤 되살린 작업 중 **이미 반영이 끝난
   * 것**은 결과를 다시 받아 오지 않는다 — 받아 오면 열려 있는 수정 화면이 그걸
   * 새 결과로 알고 그림을 갈아 끼운다.
   */
  live?: boolean;
  /** 결과 받기에 실패했다 — 3초마다 되풀이하지 않는다. */
  gaveUp?: boolean;
  krwRate?: number;
};

type ServerJob = {
  id: string;
  figure_id: string;
  problem_key: string;
  problem_id: string | null;
  label: string;
  mode: FigureMode;
  korean: boolean;
  instruction: string | null;
  status: FigureJob["status"];
  charged: boolean;
  charged_tokens: number;
  usage: { estUsd?: number; estKrw?: number; krwRate?: number } | null;
  result_path: string | null;
  applied_at: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
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
  /** 실제로 나간 **유료** 생성 호출 수. 캐시에 걸린 것은 세지 않는다. */
  calls: number;
  /** 유료 호출의 **추정** 비용 합계(달러). 무제한·BYOK 계정에만 온다. */
  spentUsd: number;
  /** 같은 합계를 원으로. 환율은 서버가 정한다(USD_TO_KRW). */
  spentKrw: number;
  /** 서버가 쓴 환율. 화면이 "1달러=N원 기준"이라고 적는 데 쓴다. */
  krwRate: number | null;
  /** 물린 토큰 합계. 금액이 안 오는 일반 사용자는 이걸 본다. */
  spentTokens: number;
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

/** 새로고침 뒤 되살릴 때, 끝난 지 이만큼 넘은 것은 목록에 다시 안 띄운다. */
const SHOW_FINISHED_MS = 6 * 3600 * 1000;
/** 도는 작업이 있을 때 서버를 들여다보는 간격. */
const POLL_MS = 3000;

async function jsonOf<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error("서버에서 정상적인 응답을 받지 못했어요.");
  }
}

/**
 * 서버에서 끝난 작업 중 아직 할 일이 남은 것 — 카드에 반영이 안 됐거나, 이
 * 화면에서 넣었는데 결과 그림을 아직 못 받았다.
 */
function needsResult(j: Internal): boolean {
  if (j.status !== "done" || !j.serverId || !j.resultPath || j.gaveUp) return false;
  return !j.appliedAt || (j.live === true && !j.svg);
}

/** 저장된 box_range 에서 조건 박스 지정을 되살린다(목록 화면과 같은 규칙). */
function boxOverrideOf(box: Record<string, unknown>): BoxOverride | undefined {
  if (Array.isArray(box.ranges)) return { ranges: box.ranges } as BoxOverride;
  if (box.none === true) return { none: true };
  if (typeof box.start === "number" && typeof box.end === "number") {
    return { start: box.start, end: box.end } as BoxOverride;
  }
  return undefined;
}

/**
 * AI 그림 작업을 관리한다. **실제 생성은 서버 큐에서 돈다**
 * (`/api/figure-jobs`, 일꾼은 `/api/figure-jobs/run`).
 *
 * 예전에는 큐가 이 컴포넌트 안에 있어서, 탭을 닫거나 새로고침하면 대기 중이던
 * 작업이 통째로 사라졌다(사용자 신고 — "나가면 다 초기화돼서 너무 귀찮아").
 * 이제 여기는 ① 그림을 줄여 서버에 넣고 ② 서버를 들여다보며 ③ 끝난 결과를
 * 화면·저장본에 반영하는 일만 한다. 브라우저를 닫아도 서버는 줄을 끝까지 돌리고,
 * 앱을 다시 열면 이 컴포넌트가 서버에서 목록을 되살린다.
 *
 * 합쳐진 카드 PNG 를 다시 그리는 일(그림 하나 모드)만은 브라우저에서 해야
 * 한다(html-to-image). 그래서 서버는 재료(box_range)까지만 저장해 두고, 앱이
 * 열려 있을 때 여기서 카드를 다시 그린다 — 닫혀 있었으면 다음에 열 때 한다.
 */
export default function FigureJobsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [jobs, setJobsState] = useState<Internal[]>([]);
  /** 비동기 흐름에서 최신 목록을 읽으려고 함께 든다. */
  const jobsRef = useRef<Internal[]>([]);
  /**
   * **갱신은 ref 에서 곧바로 계산한다.** setState 의 갱신 함수는 React 가 나중에
   * (렌더 때) 돌릴 수 있어서, 그 안에서 ref 를 채우면 바로 다음 줄에서 읽는 값이
   * 낡는다 — 서버 목록을 맞춘 직후 "끝난 것 받아 오기"가 옛 목록을 보게 된다.
   * 모든 갱신이 이 길 하나로 지나가므로 ref 와 state 가 어긋나지 않는다.
   */
  const setJobs = useCallback((fn: (prev: Internal[]) => Internal[]) => {
    const next = fn(jobsRef.current);
    jobsRef.current = next;
    setJobsState(next);
  }, []);
  const patchJob = useCallback(
    (id: string, patch: Partial<Internal>) =>
      setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j))),
    [setJobs],
  );

  /** problemKey -> 그 문제의 최신 상태. 화면이 닫혀도 남는다. */
  const snapshotsRef = useRef<Map<string, ProblemSnapshot>>(new Map());
  /**
   * 서버에 보내는 일은 한 줄로 세운다. "치우고 곧바로 같은 그림을 다시 넣기"
   * (수정 화면의 다시 그리기)가 서버에서 순서가 뒤집히면 새 요청이 옛 작업에
   * 막혀 버린다.
   */
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  /** 결과를 받아 오는 중이거나 반영 중인 서버 작업(두 번 하지 않게). */
  const handlingRef = useRef<Set<string>>(new Set());
  /** 문제 행을 서버에 알려 준 작업. */
  const toldProblemRef = useRef<Set<string>>(new Set());
  /** 로그인 안 한 화면에서는 서버를 계속 두드리지 않는다. */
  const signedOutRef = useRef(false);
  const [tick, setTick] = useState(0);

  const putSnapshot = useCallback(
    (problemKey: string, snapshot: ProblemSnapshot) => {
      snapshotsRef.current.set(problemKey, snapshot);
    },
    [],
  );

  const runOnChain = useCallback((task: () => Promise<void>) => {
    chainRef.current = chainRef.current.then(task).catch((err) => {
      console.error("[figureJobs]", err);
    });
  }, []);

  /** 서버 행의 값을 로컬 작업에 옮긴다. */
  const fromServer = useCallback(
    (row: ServerJob): Partial<Internal> => ({
      serverId: row.id,
      status: row.status,
      error: row.error ?? undefined,
      serverProblemId: row.problem_id,
      resultPath: row.result_path,
      appliedAt: row.applied_at,
      createdAt: row.created_at,
      chargedTokens:
        row.status === "done" && row.charged ? row.charged_tokens : undefined,
      costUsd: row.status === "done" ? row.usage?.estUsd : undefined,
      costKrw: row.status === "done" ? row.usage?.estKrw : undefined,
      krwRate: row.usage?.krwRate,
    }),
    [],
  );

  /**
   * 완성된 그림을 문제 저장본에 반영한다 — 카드를 눈에 안 보이는 곳에 다시
   * 그려 image_path 를 갈아 끼우고, box_range.figures 의 재료도 함께 고친다.
   *
   * 화면이 살아 있으면 그 화면이 준 최신 상태(스냅샷)로, 없으면(새로고침·다른
   * 기기) **DB 에 저장된 행에서** 카드를 다시 조립한다.
   * 반영할 대상을 못 찾으면 false.
   */
  const applyToProblem = useCallback(
    async (job: Internal, svg: string): Promise<boolean> => {
      const snap = snapshotsRef.current.get(job.problemKey);
      const problemId = snap?.problemId ?? job.serverProblemId ?? job.problemId ?? null;
      if (!problemId) return false;

      const supabase = createClient();
      const { data: row } = await supabase
        .from("problems")
        .select("image_path, box_range, text_content")
        .eq("id", problemId)
        .maybeSingle();
      if (!row) return false;
      const box = (row.box_range ?? {}) as Record<string, unknown>;

      let base: CardSpec;
      if (snap?.problemId === problemId) {
        base = snap.spec;
      } else {
        // 화면이 없다 — 저장된 행으로 카드를 다시 조립한다. 수식 렌더러는
        // 무거워서(KaTeX) 이 경우에만 불러온다(이 컴포넌트는 모든 화면에 붙는다).
        const { renderMathTextWithInfo } = await import("@/lib/renderMathText");
        const text = String(row.text_content ?? "");
        const boxOverride = boxOverrideOf(box);
        const blocks = renderMathTextWithInfo(text, boxOverride).blocks;
        base = {
          text,
          boxOverride,
          fontSizePx: ptToPx(readFontPt(box)),
          figures: restoreCardFigures(readStoredFigures(box), blocks),
        };
      }
      if (base.figures.every((f) => f.id !== job.id)) return false;

      const spec: CardSpec = {
        ...base,
        figures: base.figures.map((f) =>
          // 원본을 남긴다. 이미 있으면 덮지 않는다 — 두 번째 AI 결과가 첫
          // 번째 AI 결과를 원본으로 만들어 버리면 안 된다.
          f.id === job.id ? { ...keepOrigin(f, f.markup), markup: svg, ai: true } : f,
        ),
      };

      const dataUrl = await renderCardOffscreen(spec);
      const blob = await (await fetch(dataUrl)).blob();
      const dir = String(row.image_path).split("/").slice(0, -1).join("/");
      const newPath = `${dir}/${crypto.randomUUID()}.png`;
      const up = await putBlob(supabase, newPath, blob, "image/png");
      if (!up.ok) throw new Error(up.error);

      // **합쳐진 PNG(image_path)만 갱신하면 안 된다.** 수정 화면은
      // box_range.figures 의 markup 으로 카드를 다시 조립한다 — 여기를 안 고치면
      // 수정 화면만 원본으로 남고, 그 상태로 저장하는 순간 AI 결과가 영영
      // 사라진다(실제로 그랬다). 서버의 persistWholeProblem 과 같은 병합이다.
      const existingFigures = Array.isArray(box.figures)
        ? (box.figures as Record<string, unknown>[])
        : [];
      const nextFigures = await Promise.all(
        existingFigures.map(async (f) =>
          f.id === job.id
            ? {
                ...keepOrigin(f, f.markup),
                markup: await persistFigureValue(supabase, dir, svg),
                ai: true,
              }
            : f,
        ),
      );

      const { error: dbErr } = await supabase
        .from("problems")
        .update({
          image_path: newPath,
          ...(existingFigures.some((f) => f.id === job.id)
            ? { box_range: { ...box, figures: nextFigures } }
            : {}),
        })
        .eq("id", problemId);
      if (dbErr) {
        await removeBlobs([newPath, thumbPathFor(newPath)]);
        throw dbErr;
      }
      await removeBlobs([String(row.image_path), thumbPathFor(String(row.image_path))]);

      // 다음 갱신 때도 최신 마크업을 쓰도록 스냅샷을 갱신해 둔다.
      if (snap?.problemId === problemId) {
        snapshotsRef.current.set(job.problemKey, { ...snap, spec });
      }
      return true;
    },
    [],
  );

  /**
   * 서버에서 끝난 작업의 결과를 받아 와 화면에 넘기고, 아직 카드에 반영이
   * 안 됐으면 반영한다.
   */
  const handleDone = useCallback(
    async (job: Internal) => {
      const serverId = job.serverId;
      if (!serverId || !job.resultPath) return;
      if (handlingRef.current.has(serverId)) return;
      handlingRef.current.add(serverId);
      try {
        let svg = job.svg;
        if (!svg) {
          const raw = await ensureDataUrl(cardUrl(job.resultPath));
          // 생성 모델은 자기 비율에 맞춰 그려서 둘레에 흰 여백을 붙여 준다.
          svg = await rasterToSvg(await trimBlankBorder(raw));
          if (job.cacheKey) writeFigureCache(job.cacheKey, svg);
          patchJob(job.id, { svg });
        }
        if (job.appliedAt) return;

        // 기기 둘이 열려 있어도 한쪽만 반영하도록 먼저 찜한다.
        const claim = await fetch("/api/figure-jobs", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: serverId, action: "claimApply" }),
        });
        const claimed = await jsonOf<{ claimed?: boolean }>(claim);
        if (!claimed.claimed) return;
        patchJob(job.id, { appliedAt: new Date().toISOString() });

        try {
          const applied = await applyToProblem(job, svg);
          // 결과 파일은 반영하면서 문제 쪽으로 복사됐다. **작업용 자리(_jobs)에
          // 있는 것만** 지운다 — 문제 전체 모드에서는 결과가 곧 image_path 일 수 있다.
          if (applied && job.resultPath.includes("/_jobs/")) {
            await removeBlobs([job.resultPath]);
          }
        } catch (err) {
          console.error("[figureJobs] 저장본 갱신 실패:", err);
          await fetch("/api/figure-jobs", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: serverId, action: "releaseApply" }),
          }).catch(() => {});
          patchJob(job.id, { appliedAt: null });
        }
      } catch (err) {
        console.error("[figureJobs] 결과 받기 실패:", err);
        patchJob(job.id, { gaveUp: true });
      } finally {
        handlingRef.current.delete(serverId);
      }
    },
    [applyToProblem, patchJob],
  );

  /** 서버 목록을 받아 로컬과 맞춘다. */
  const sync = useCallback(async () => {
    if (signedOutRef.current) return;
    let rows: ServerJob[];
    try {
      const res = await fetch("/api/figure-jobs", { cache: "no-store" });
      if (res.status === 401) {
        signedOutRef.current = true;
        return;
      }
      if (!res.ok) return;
      rows = (await jsonOf<{ jobs?: ServerJob[] }>(res)).jobs ?? [];
    } catch {
      return; // 오프라인 등. 다음 차례에 다시 본다.
    }

    const now = Date.now();
    setJobs((prev) => {
      let next = [...prev];
      for (const row of rows) {
        const i = next.findIndex((j) => j.serverId === row.id);
        if (i !== -1) {
          next[i] = { ...next[i], ...fromServer(row) };
          continue;
        }
        const same = next.findIndex((j) => j.id === row.figure_id);
        if (same !== -1) {
          const cur = next[same];
          // 아직 넣는 중인 로컬 작업이면 그쪽 응답을 기다린다.
          if (!cur.serverId) continue;
          // 같은 그림의 더 새 작업이면 갈아 끼운다(다시 그리기).
          if ((cur.createdAt ?? "") < row.created_at) {
            next[same] = {
              ...cur,
              ...fromServer(row),
              svg: undefined,
              label: row.label || cur.label,
              instruction: row.instruction ?? undefined,
            };
          }
          continue;
        }
        // 이 화면이 모르는 작업 — 새로고침 전에 넣었거나 다른 기기에서 넣었다.
        // 오래전에 끝난 것까지 다시 띄우면 목록만 길어진다.
        const finished = row.finished_at ? Date.parse(row.finished_at) : now;
        const recent =
          row.status === "pending" ||
          row.status === "running" ||
          (row.status === "done" && !row.applied_at) ||
          now - finished < SHOW_FINISHED_MS;
        if (!recent) continue;
        next.push({
          id: row.figure_id,
          problemKey: row.problem_key,
          label: row.label,
          crop: "",
          mode: row.mode,
          problemId: row.problem_id,
          instruction: row.instruction ?? undefined,
          korean: row.korean,
          ...fromServer(row),
        } as Internal);
      }
      // 서버에서 사라진 작업(다른 기기에서 치움, 오래돼 지워짐)은 로컬에서도 뺀다.
      const alive = new Set(rows.map((r) => r.id));
      next = next.filter((j) => !j.serverId || alive.has(j.serverId) || j.svg);
      return next;
    });

    // 저장 전이던 문제 행이 생겼으면 서버에 알려 준다(문제 전체 모드는 그걸
    // 알아야 결과를 그 행에 바로 저장한다).
    for (const j of jobsRef.current) {
      if (!j.serverId || j.serverProblemId || toldProblemRef.current.has(j.serverId)) continue;
      if (j.status === "error") continue;
      const pid = snapshotsRef.current.get(j.problemKey)?.problemId;
      if (!pid) continue;
      toldProblemRef.current.add(j.serverId);
      void fetch("/api/figure-jobs", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: j.serverId, action: "setProblem", problemId: pid }),
      }).catch(() => toldProblemRef.current.delete(j.serverId as string));
    }

    // 끝난 것들의 결과를 받아 온다.
    for (const j of jobsRef.current) {
      if (needsResult(j)) void handleDone(j);
    }
  }, [fromServer, handleDone, setJobs]);

  /** 로컬 작업 하나를 줄여서 서버 큐에 넣는다. */
  const submit = useCallback(
    async (id: string) => {
      const job = jobsRef.current.find((j) => j.id === id && !j.serverId);
      if (!job || job.status !== "pending") return;
      try {
        // **바이트로 바꿔 둔다.** 이미 스토리지로 옮겨진 그림이면 주소 문자열이다.
        const crop = await ensureDataUrl(job.crop);
        // 입력 토큰을 줄이려고 크기를 낮춰 보낸다. 문제 전체는 본문 글자까지
        // 살아야 해서 **폭**을 기준으로 맞춘다.
        const mode: FigureMode = job.mode ?? "figure";
        const forModel =
          mode === "problem"
            ? await prepareProblemForModel(crop)
            : await prepareFigureForModel(crop, MODEL_INPUT_DIM);

        // 같은 그림을 이미 그린 적이 있으면 그대로 쓴다(세트 문항 대비).
        // 모드·모델·지시를 키에 넣는다 — 하나라도 빠지면 바꿨는데도 옛 결과가 나온다.
        const cacheKey = await figureCacheKey(
          `${mode}:${DEFAULT_FIGURE_MODEL}:${job.instruction ?? ""}:${forModel}`,
        );
        const cached = readFigureCache(cacheKey);
        if (cached) {
          // 서버를 안 거치므로 돈이 안 나갔다 — 비용 칸은 비워 둔다.
          patchJob(id, { status: "done", svg: cached });
          const fresh = jobsRef.current.find((j) => j.id === id);
          if (fresh) {
            void applyToProblem(fresh, cached).catch((err) =>
              console.error("[figureJobs] 저장본 갱신 실패:", err),
            );
          }
          return;
        }

        const size = await imageSizeOf(forModel);
        const res = await fetch("/api/figure-jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            figureId: id,
            problemKey: job.problemKey,
            label: job.label,
            image: forModel,
            mode,
            korean: job.korean ? true : undefined,
            instruction: job.instruction,
            // 넣을 때 아직 저장 전일 수 있다 — 화면이 계속 갱신해 주는
            // 스냅샷에서 지금 아는 값을 읽는다. 나중에 생기면 sync 가 알려 준다.
            problemId:
              job.problemId ??
              snapshotsRef.current.get(job.problemKey)?.problemId ??
              null,
            width: size?.width,
            height: size?.height,
          }),
        });
        const json = await jsonOf<{ job?: ServerJob; error?: string }>(res);
        if (!res.ok || !json.job) throw new Error(json.error ?? "작업을 넣지 못했어요.");

        const stillHere = jobsRef.current.some((j) => j.id === id && !j.serverId);
        if (!stillHere) {
          // 넣는 사이에 사용자가 치웠다 — 서버에서도 뺀다(보증금이 돌아온다).
          await fetch(`/api/figure-jobs?id=${encodeURIComponent(json.job.id)}`, {
            method: "DELETE",
          }).catch(() => {});
          return;
        }
        patchJob(id, { ...fromServer(json.job), cacheKey, crop: "", live: true });
        setTick((n) => n + 1);
      } catch (err) {
        patchJob(id, {
          status: "error",
          error: err instanceof Error ? err.message : "작업을 넣지 못했어요.",
        });
      }
    },
    [applyToProblem, fromServer, patchJob],
  );

  /**
   * 같은 id는 한 번만 받는다.
   *
   * **중복 과금을 막는 자리다.** 작업 하나가 곧 유료 API 호출 한 번이다.
   * 개발 모드의 StrictMode 가 이펙트를 두 번 실행해 같은 작업이 두 개 쌓인 적이
   * 있어서, 넣는 쪽을 믿지 않고 여기서 막는다(서버도 한 번 더 막는다).
   */
  const enqueue = useCallback(
    (job: Omit<FigureJob, "status">) => {
      if (jobsRef.current.some((j) => j.id === job.id)) return;
      setJobs((prev) =>
        prev.some((j) => j.id === job.id) ? prev : [...prev, { ...job, status: "pending" }],
      );
      signedOutRef.current = false;
      runOnChain(() => submit(job.id));
    },
    [runOnChain, setJobs, submit],
  );

  const retry = useCallback(
    (id: string) => {
      const job = jobsRef.current.find((j) => j.id === id);
      if (!job || job.status !== "error") return;
      if (!job.serverId) {
        // 서버에 넣기도 전에 실패했다 — 처음부터 다시 넣는다.
        patchJob(id, { status: "pending", error: undefined });
        runOnChain(() => submit(id));
        return;
      }
      const serverId = job.serverId;
      patchJob(id, {
        status: "pending",
        error: undefined,
        svg: undefined,
        gaveUp: false,
        live: true,
      });
      runOnChain(async () => {
        const res = await fetch("/api/figure-jobs", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: serverId, action: "retry" }),
        });
        const json = await jsonOf<{ job?: ServerJob; error?: string }>(res);
        if (!res.ok || !json.job) {
          patchJob(id, { status: "error", error: json.error ?? "다시 넣지 못했어요." });
          return;
        }
        patchJob(id, fromServer(json.job));
        setTick((n) => n + 1);
      });
    },
    [fromServer, patchJob, runOnChain, submit],
  );

  const dismiss = useCallback(
    (id: string) => {
      const job = jobsRef.current.find((j) => j.id === id);
      setJobs((prev) => prev.filter((j) => j.id !== id));
      const serverId = job?.serverId;
      if (!serverId) return; // 넣는 중이면 submit 이 알아채고 서버에서 뺀다
      runOnChain(async () => {
        await fetch(`/api/figure-jobs?id=${encodeURIComponent(serverId)}`, {
          method: "DELETE",
        });
      });
    },
    [runOnChain, setJobs],
  );

  const activeCount = jobs.filter(
    (j) => j.status === "pending" || j.status === "running",
  ).length;
  /** 아직 서버에 못 넣은 작업 수. 이것만은 탭을 닫으면 사라진다. */
  const submitting = jobs.filter((j) => j.status === "pending" && !j.serverId).length;
  const serverActive = jobs.some(
    (j) => j.serverId && (j.status === "pending" || j.status === "running"),
  );
  const awaitingResult = jobs.some(needsResult);

  // 처음 열 때 · 화면으로 돌아올 때 서버 목록을 되살린다.
  useEffect(() => {
    void sync();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      signedOutRef.current = false;
      void sync();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [sync]);

  // 로그인 화면에서 막 들어왔으면(그때는 401 이라 멈춰 뒀다) 다시 본다.
  const pathname = usePathname();
  useEffect(() => {
    if (!signedOutRef.current) return;
    signedOutRef.current = false;
    void sync();
  }, [pathname, sync]);

  // 도는 작업이 있는 동안만 서버를 들여다본다.
  useEffect(() => {
    if (!serverActive && !awaitingResult) return;
    const t = setInterval(() => void sync(), POLL_MS);
    return () => clearInterval(t);
  }, [serverActive, awaitingResult, sync, tick]);

  /**
   * **서버에 넣기 전인 작업이 있을 때만** 탭 닫기를 되묻는다.
   *
   * 서버에 들어간 작업은 탭을 닫아도 끝까지 돌고 저장된다 — 그걸 막아 세울
   * 이유가 없다. 다만 그림을 줄여 올리는 몇 초 사이에 닫으면 그 작업은 서버에
   * 닿지 못한다.
   */
  useEffect(() => {
    if (submitting === 0) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [submitting]);

  // 합계는 목록에서 센다 — 새로고침 뒤 되살린 작업도 함께 셈된다.
  const paid = jobs.filter((j) => j.serverId && j.status === "done");
  const calls = paid.length;
  const spentTokens = paid.reduce((s, j) => s + (j.chargedTokens ?? 0), 0);
  const spentUsd = paid.reduce((s, j) => s + (j.costUsd ?? 0), 0);
  const spentKrw = paid.reduce((s, j) => s + (j.costKrw ?? 0), 0);
  const krwRate = paid.find((j) => j.krwRate)?.krwRate ?? null;

  return (
    <FigureJobsContext.Provider
      value={{
        jobs,
        activeCount,
        calls,
        spentUsd,
        spentKrw,
        krwRate,
        spentTokens,
        enqueue,
        retry,
        dismiss,
        putSnapshot,
      }}
    >
      {children}
    </FigureJobsContext.Provider>
  );
}
