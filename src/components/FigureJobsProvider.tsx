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
  imageSizeOf,
  rasterToSvg,
  trimBlankBorder,
} from "@/lib/figureImage";
import type { FigureMode, FigureUsage } from "@/lib/figureImageGen";
import { thumbPathFor, uploadThumb } from "@/lib/cardThumb";
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
 * 하나 들지만, 문제 전체를 다시 그리는 값에 비하면 작고
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
  /**
   * "이렇게 다시 그려 주세요" — 사용자가 적어 준 요청. 프롬프트 끝에 붙는다.
   *
   * 없으면 프롬프트도 캐시 키도 예전과 **한 글자도 다르지 않다.**
   */
  instruction?: string;
  /**
   * 국어인가. 국어는 지문·문항이 **거의 글자뿐**이라 Mathpix 가 사진보다
   * 정확한 경우가 많다 — 그래서 참고 글을 더 앞세우라고 프롬프트에 적는다
   * (사용자 요청). 다른 과목은 표·그림이 섞여 있어 사진이 우선이다.
   */
  korean?: boolean;
  /**
   * 글자 인식(Mathpix)을 쓸지. 없으면 **쓴다**(문제 전체 모드일 때).
   *
   * 수정 화면에서 다시 그릴 때 끌 수 있다(사용자 요청). 참고 글이 늘 이로운
   * 것은 아니다 — Mathpix 가 잘못 읽으면 모델이 그 오류를 **베껴 쓴다**. 결과를
   * 눈으로 본 사람이 "이번엔 참고 없이 사진만 보고 그려 봐"를 고를 수 있어야
   * 한다. 인식 토큰 1도 아낀다.
   */
  useOcr?: boolean;
  status: "pending" | "running" | "done" | "error";
  /**
   * 글자 인식(Mathpix)이 어떻게 됐는가. **문제 전체를 그릴 때만** 쓴다.
   *   reading — 지금 읽는 중
   *   ok      — 읽어서 프롬프트에 참고로 넣었다
   *   none    — 못 읽었다(키가 없거나 실패). 참고 없이 그린다
   *   off     — 사용자가 **일부러 껐다**. 못 읽은 것과 갈라 둔다 — 안 그러면
   *             자기가 끈 것을 실패로 읽는다.
   * 화면에 그대로 보여 준다 — 글자 정확도가 걸린 단계라 됐는지 안 됐는지
   * 눈에 보여야 한다.
   */
  ocr?: "reading" | "ok" | "none" | "off";
  /** 읽어 낸 글자의 앞부분. 무엇을 참고했는지 눈으로 확인할 수 있게. */
  ocrPreview?: string;
  /**
   * 이 작업에 실제로 든 **추정** 비용(달러). 캐시에 걸렸으면 없다(돈이 안 났다).
   * 어느 문제가 비쌌는지 눈으로 보려는 것이다.
   */
  costUsd?: number;
  /** 같은 값을 원으로 옮긴 것. 서버가 환율까지 계산해 내려준다. */
  costKrw?: number;
  /**
   * 이 작업에 실제로 물린 토큰. 금액과 달리 **누구에게나 보인다** —
   * 변동 차감이라 얼마가 빠졌는지 안 보이면 불신이 생긴다.
   */
  chargedTokens?: number;
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
  /**
   * 이번에 실제로 나간 **유료** 생성 호출 수. 캐시에 걸린 것은 세지 않는다.
   *
   * 요청 수가 문제 수보다 훨씬 많아지는 것이 비용의 주범인데(재시도가 쌓인다)
   * 지금까지 화면에 아무 단서가 없었다. 숫자가 보이면 바로 알아챈다.
   */
  calls: number;
  /**
   * 이번에 나간 유료 호출의 **추정** 비용 합계(달러).
   *
   * 청구액이 아니다 — 사용자 청구 CSV 에서 역산한 단가로 계산한 값이라,
   * 화면에도 "추정치"라고 적어 둔다. 정확한 금액은 OpenAI 대시보드가 정답지다.
   */
  spentUsd: number;
  /** 같은 합계를 원으로. 환율은 서버가 정한다(USD_TO_KRW). */
  spentKrw: number;
  /** 서버가 쓴 환율. 화면이 "1달러=N원 기준"이라고 적는 데 쓴다. */
  krwRate: number | null;
  /** 이번에 물린 토큰 합계. 금액이 안 오는 일반 사용자는 이걸 본다. */
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
  /** 실제로 나간 유료 호출 수(캐시 적중은 제외). */
  const [calls, setCalls] = useState(0);
  /** 그 호출들의 추정 비용 합계(달러). 캐시 적중은 더하지 않는다. */
  const [spentUsd, setSpentUsd] = useState(0);
  /** 같은 합계를 원으로. 원 단위 반올림한 값을 더한다. */
  const [spentKrw, setSpentKrw] = useState(0);
  /** 서버가 쓴 환율. 화면에 숫자를 하드코딩하지 않으려고 받아 둔다. */
  const [krwRate, setKrwRate] = useState<number | null>(null);
  /** 실제로 물린 토큰 합계(캐시 적중은 제외 — 차감이 없었다). */
  const [spentTokens, setSpentTokens] = useState(0);
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
          // 원본을 남긴다. 이미 있으면 덮지 않는다 — 두 번째 AI 결과가 첫
          // 번째 AI 결과를 원본으로 만들어 버리면 안 된다.
          f.id === job.id
            ? { ...f, origin: f.origin ?? f.markup, markup: svg, ai: true }
            : f,
        ),
      };

      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      const { data: row } = await supabase
        .from("problems")
        .select("image_path, box_range, category_id")
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

      // 목록용 작은 미리보기도 같이(cardThumb.ts). 이걸 빠뜨리면 이 경로로
      // 갱신된 문제만 목록에서 원본을 받게 된다.
      await uploadThumb(supabase, newPath, blob);

      // **합쳐진 PNG(image_path)만 갱신하면 안 된다.** 수정 화면은 이
      // image_path 를 안 쓰고 box_range.figures 의 markup 으로 카드를 다시
      // 조립한다(끌어 옮기고 다시 오려낼 수 있어야 하므로). 여기서
      // box_range 를 안 고치면 PDF·목록은 AI 결과가 맞게 보이는데 수정
      // 화면만 원본으로 되돌아가 있고, 그 상태로 아무거나 고쳐 저장하는
      // 순간 그 원본으로 다시 렌더링한 PNG 가 image_path 까지 덮어써서
      // **방금 만든 AI 결과가 영영 사라진다** — 실제로 이렇게 났다(새로고침·
      // 다른 기기에서도 계속 원본으로 보이고, PDF 만 정상이었다).
      // persistWholeProblem(/api/figure/route.ts)의 병합 방식과 같다.
      const box = (row.box_range ?? {}) as Record<string, unknown>;
      const existingFigures = Array.isArray(box.figures)
        ? (box.figures as Record<string, unknown>[])
        : [];
      const nextFigures = existingFigures.map((f) =>
        f.id === job.id
          ? {
              ...f,
              ...(typeof f.origin === "string" || typeof f.markup !== "string"
                ? {}
                : { origin: f.markup }),
              markup: svg,
              ai: true,
            }
          : f,
      );

      const { error: dbErr } = await supabase
        .from("problems")
        .update({
          image_path: newPath,
          ...(existingFigures.some((f) => f.id === job.id)
            ? { box_range: { ...box, figures: nextFigures } }
            : {}),
        })
        .eq("id", snap.problemId);
      if (dbErr) {
        await supabase.storage
          .from("problem-images")
          .remove([newPath, thumbPathFor(newPath)]);
        throw dbErr;
      }
      await supabase.storage
        .from("problem-images")
        .remove([String(row.image_path), thumbPathFor(String(row.image_path))]);

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
        // **지시를 키에 넣어야 한다.** 안 넣으면 같은 크롭에 지시만 바꿔도
        // 캐시가 걸려 예전 그림이 그대로 나온다 — 사용자 눈에는 지시를 적었는데
        // 아무것도 안 바뀐 것으로 보인다. 지시가 없으면 빈 문자열이라 예전
        // 키와 같다.
        // **참고 글을 끈 것도 키에 들어가야 한다.** 같은 크롭·같은 지시로
        // "이번엔 참고 없이"를 골랐는데 캐시가 걸리면 참고를 썼던 예전 그림이
        // 그대로 나온다 — 사용자 눈에는 껐는데 아무것도 안 바뀐 것으로 보인다
        // (`instruction` 을 키에 넣은 것과 같은 이유). 켠 쪽(기본)은 꼬리표를
        // 안 붙여 **예전 키를 그대로 쓴다** — 이미 쌓인 캐시를 버릴 이유가 없다.
        const useOcr = next.useOcr !== false;
        const key = await figureCacheKey(
          `${mode}${useOcr ? "" : ":noocr"}:${next.instruction ?? ""}:${forModel}`,
        );
        let svg = readFigureCache(key);
        /** 이 작업에 실제로 든 추정 비용. 캐시에 걸리면 끝까지 undefined 다. */
        let costUsd: number | undefined;
        let costKrw: number | undefined;
        let chargedTokens: number | undefined;

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
          if (mode === "problem" && !useOcr) {
            // 사용자가 일부러 껐다. 못 읽은 것과 갈라서 보여 준다.
            setJobs((prev) =>
              prev.map((j) => (j.id === id ? { ...j, ocr: "off" as const } : j)),
            );
          } else if (mode === "problem") {
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
          // 보낼 그림의 크기를 재서 함께 넘긴다. 서버가 **출력 캔버스를 이
          // 비율에 맞추는** 데 쓴다 — 비율이 어긋나면 모델이 흰 여백을 붙여
          // 돌려주는데 우리는 그걸 잘라 버리므로, 그 여백이 곧 버리는 돈이다.
          const forModelSize = await imageSizeOf(forModel);
          // 실제로 나간 유료 호출을 센다(캐시에 걸린 것은 여기까지 오지 않는다).
          setCalls((n) => n + 1);
          const res = await fetch("/api/figure", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              image: forModel,
              mode,
              korean: next.korean ? true : undefined,
              width: forModelSize?.width,
              height: forModelSize?.height,
              // 서버가 결과를 직접 저장할 수 있게 알려준다(탭을 닫아도 남는다).
              // 작업을 넣을 때는 아직 저장 전일 수 있어서, 화면이 계속 갱신해
              // 주는 스냅샷에서 **호출 직전에** 최신 행 id를 읽는다.
              problemId:
                next.problemId ??
                snapshotsRef.current.get(next.problemKey)?.problemId ??
                null,
              figureId: next.id,
              reference,
              instruction: next.instruction,
            }),
          });
          let json: {
            image?: string;
            error?: string;
            usage?: FigureUsage;
            chargedTokens?: number | null;
          };
          try {
            json = await res.json();
          } catch {
            throw new Error(
              "서버에서 정상적인 응답을 받지 못했어요. 이미지 생성이 제한 시간을 넘겨 요청이 끊겼을 수 있습니다. 영역을 더 좁게 잘라 다시 시도해주세요.",
            );
          }
          if (!res.ok) throw new Error(json.error ?? "그림을 그리지 못했습니다.");
          if (
            typeof json.image !== "string" ||
            !json.image.startsWith("data:image/")
          ) {
            throw new Error("서버가 이미지를 돌려주지 않았어요.");
          }
          // 이 요청에 실제로 든 값. 캐시에 걸린 작업에는 붙지 않는다 —
          // 그때는 돈이 안 나갔으므로 0 이 아니라 "없음"이 맞다.
          if (typeof json.chargedTokens === "number") {
            chargedTokens = json.chargedTokens;
            setSpentTokens((v) => v + json.chargedTokens!);
          }
          // 금액은 무제한 계정에만 온다(서버가 가린다). 오면 쌓고, 안 오면 만다.
          if (typeof json.usage?.estUsd === "number") {
            costUsd = json.usage.estUsd;
            costKrw = json.usage.estKrw;
            setSpentUsd((v) => v + json.usage!.estUsd);
            setSpentKrw((v) => v + (json.usage!.estKrw ?? 0));
            if (json.usage.krwRate) setKrwRate(json.usage.krwRate);
          }
          // 생성 모델은 자기 비율에 맞춰 그려서 둘레에 흰 여백을 붙여 준다.
          svg = await rasterToSvg(await trimBlankBorder(json.image));
          writeFigureCache(key, svg);
        }

        setJobs((prev) =>
          prev.map((j) =>
            j.id === id
              ? {
                  ...j,
                  status: "done",
                  svg: svg as string,
                  costUsd,
                  costKrw,
                  chargedTokens,
                }
              : j,
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

  /**
   * **작업이 도는 중에 탭을 닫거나 새로고침하려 하면 되묻는다.**
   *
   * 큐는 브라우저 안에서 돈다. 그래서 새로고침하면 **대기 중이던 작업이
   * 통째로 사라지고**, 돌던 작업도 fetch 가 끊긴다. 문제 전체 그리기
   * (`mode: "problem"`)는 서버가 결과를 직접 저장하므로 그래도 남지만
   * (`persistWholeProblem`), **그림 하나 모드와 지문 인식은 그 보험이 없다** —
   * 토큰은 이미 서버에서 차감된 뒤라 돈만 나가고 아무것도 안 남는다.
   * 사용자 신고: "생성할 때 새로고침하면 AI 날아가고 브라우저 창 나가면
   * 중간에 중단됨."
   *
   * 브라우저는 안내 문구를 우리 마음대로 못 바꾸지만(자체 문구를 쓴다),
   * **되묻는 창이 뜨는 것만으로 실수로 날리는 것은 막힌다.** 작업이 없을
   * 때는 아무 방해도 하지 않는다.
   */
  useEffect(() => {
    if (activeCount === 0) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // 옛 브라우저를 위해 returnValue 도 채운다(문구는 무시된다).
      e.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [activeCount]);

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
