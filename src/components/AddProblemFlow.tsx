"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import {
  clearQueue,
  loadQueue,
  preparePhoto,
  removePhoto,
  saveOrder,
  savePhoto,
  type QueuedPhoto,
} from "@/lib/photoQueue";
import { useFigureJobs } from "./FigureJobsProvider";
import BatchSplitPanel from "./BatchSplitPanel";
import KoreanModePanel from "./KoreanModePanel";
import BulkMappedImportPanel from "./BulkMappedImportPanel";
import PhotoQueueStrip from "./PhotoQueueStrip";

type Stage = "idle" | "upload" | "crop" | "loading" | "result";

/** 문제를 넣는 길. 한 화면에 전부 펼쳐 두면 어지러워서 탭으로 가른다. */
type Mode = "photo" | "page" | "korean" | "csv";
const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "photo", label: "사진", hint: "문제 사진 여러 장을 한 장씩 잘라 넣어요" },
  { id: "page", label: "지면 통째로", hint: "한 쪽에 문제가 여럿이면 문제마다 영역을 그려 한 번에" },
  { id: "korean", label: "국어 세트", hint: "지문 한 편과 그 문항들을 한 세트로" },
  { id: "csv", label: "CSV 일괄", hint: "이미 잘린 사진 여러 장 + 정답 CSV 를 한 번에(토큰 없음)" },
];
const MODE_KEY = "reprint.addMode";

/** 자르자마자 뒤에서 저장하는 문제 하나(진행 줄에 보여 준다). */
type QuickItem = {
  key: string;
  crop: string;
  status: "saving" | "saved" | "done" | "error";
  number?: number | null;
  answer?: string | null;
  error?: string;
};

const byOrder = (a: QueuedPhoto, b: QueuedPhoto) => a.order - b.order;

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
  const [mode, setModeState] = useState<Mode>("photo");
  const [result, setResult] = useState<RecognizeResponse | null>(null);
  // 인식(result)을 만든 바로 그 이미지. 도형 영역을 오려낼 때 필요하다.
  const [recognizedSourceImage, setRecognizedSourceImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 초록 안내 한 줄(뒤로 가기로 빠져나왔을 때 등). */
  const [notice, setNotice] = useState<string | null>(null);
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

  // ── 사진 대기열 ────────────────────────────────────────────────────────
  // `photoQueue.ts` 주석 참고 — 여러 장을 원본 그대로 한꺼번에 들고 있다가 탭이
  // 죽어 "튕기던" 자리다. 지금은 한 장씩 줄여 Blob 으로 들고, 브라우저에 저장해
  // 탭이 다시 떠도 남은 사진이 그대로 있다.
  /** 지금 자르는 사진. 인식이 끝나 결과 화면으로 넘어가도(= 다 쓴 사진) 되돌아
   *  올 수 있게 들고 있는다(`activeUsed`). */
  const [active, setActive] = useState<QueuedPhoto | null>(null);
  /** 아직 안 자른 사진들(들어온 차례). 지금 자르는 사진은 빠져 있다. */
  const [pending, setPending] = useState<QueuedPhoto[]>([]);
  /** 사진을 줄이는 중이면 진행 상황. */
  const [preparing, setPreparing] = useState<{ done: number; total: number } | null>(null);
  /** 지금 사진을 이미 다 썼는가(저장 대기열·결과 화면으로 넘어갔다). */
  const activeUsedRef = useRef(false);
  const activeRef = useRef<QueuedPhoto | null>(null);
  const orderRef = useRef(0);
  const addInputRef = useRef<HTMLInputElement>(null);
  /** 지금 사진의 화면용 주소. 사진이 바뀌면 옛 주소를 풀어 준다. */
  const [activeUrl, setActiveUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!active) {
      setActiveUrl(null);
      return;
    }
    const u = URL.createObjectURL(active.blob);
    setActiveUrl(u);
    return () => URL.revokeObjectURL(u);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  // 들어오면 이 실모에서 자르다 만 사진이 있는지 본다(탭이 죽었다 살아난 경우).
  useEffect(() => {
    let alive = true;
    void loadQueue(categoryId).then((rows) => {
      if (!alive || rows.length === 0) return;
      orderRef.current = Math.max(orderRef.current, ...rows.map((r) => r.order + 1));
      setPending((prev) => {
        const have = new Set(prev.map((p) => p.id));
        return [...prev, ...rows.filter((r) => !have.has(r.id))].sort(byOrder);
      });
    });
    return () => {
      alive = false;
    };
  }, [categoryId]);

  // 고른 탭을 기억한다(자주 쓰는 길이 사람마다 다르다).
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(MODE_KEY) as Mode | null;
      if (saved && MODES.some((m) => m.id === saved)) setModeState(saved);
    } catch {
      // 기억 못 해도 된다.
    }
  }, []);
  function setMode(m: Mode) {
    setModeState(m);
    try {
      window.localStorage.setItem(MODE_KEY, m);
    } catch {
      // 무시.
    }
  }

  // 아직 저장이 안 끝난 문제가 있으면 탭 닫기를 되묻는다(사진이 통째로 사라진다).
  useEffect(() => {
    if (unsaved === 0 && !preparing) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved, preparing]);

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

  /** 이 사진을 지금 자를 사진으로 올린다. */
  const activate = useCallback((p: QueuedPhoto | null) => {
    activeRef.current = p;
    activeUsedRef.current = false;
    setActive(p);
    setResult(null);
    setRecognizedSourceImage(null);
    setStage(p ? "crop" : "upload");
  }, []);

  /**
   * 고른 사진을 **한 장씩** 줄여 대기열에 넣는다. 첫 장이 준비되는 대로 곧바로
   * 자르기 화면을 띄운다 — 나머지는 자르는 동안 뒤에서 준비된다.
   *
   * 한 장이 안 열려도 나머지는 계속한다(예전에는 하나만 실패해도 통째로 멈췄다).
   */
  async function handleImagesSelected(files: File[]) {
    if (files.length === 0) return;
    setError(null);
    setNotice(null);
    const failed: string[] = [];
    setPreparing({ done: 0, total: files.length });
    for (let i = 0; i < files.length; i++) {
      try {
        const p = await preparePhoto(files[i], orderRef.current++);
        void savePhoto(categoryId, p);
        if (!activeRef.current) activate(p);
        else setPending((prev) => [...prev, p]);
      } catch (err) {
        failed.push(err instanceof Error ? err.message : `"${files[i].name}" 사진을 열지 못했습니다.`);
      }
      setPreparing(i + 1 < files.length ? { done: i + 1, total: files.length } : null);
    }
    if (failed.length > 0) {
      setError(
        failed.length === 1 ? failed[0] : `${failed.length}장은 열지 못해 뺐어요. ${failed[0]}`,
      );
    }
  }

  /** 지금 사진을 다 썼다고 적는다(브라우저 저장소에서도 지운다). */
  function markActiveUsed() {
    const a = activeRef.current;
    if (!a || activeUsedRef.current) return;
    activeUsedRef.current = true;
    void removePhoto(a.id);
  }

  /** 다음 사진으로. 없으면 곧바로 사진 고르기 화면 — 계속 넣겠다는 뜻이므로. */
  function advanceQueue() {
    setError(null);
    const [next, ...rest] = pending;
    setPending(rest);
    activate(next ?? null);
  }

  /** 다 쓰지 않은 지금 사진을 대기열로 돌려놓는다(차례는 원래 자리). */
  function returnActive() {
    const a = activeRef.current;
    if (a && !activeUsedRef.current) {
      setPending((prev) => [...prev.filter((p) => p.id !== a.id), a].sort(byOrder));
    }
    activeRef.current = null;
    setActive(null);
  }

  function jumpTo(id: string) {
    const target = pending.find((p) => p.id === id);
    if (!target) return;
    const a = activeRef.current;
    const back = a && !activeUsedRef.current ? [a] : [];
    setPending((prev) => [...prev.filter((p) => p.id !== id), ...back].sort(byOrder));
    activate(target);
  }

  function removeFromQueue(id: string) {
    void removePhoto(id);
    if (activeRef.current?.id === id) {
      activeUsedRef.current = true;
      advanceQueue();
      return;
    }
    setPending((prev) => prev.filter((p) => p.id !== id));
  }

  /** 이 사진은 나중에 — 맨 뒤로 보낸다. */
  function skipActive() {
    const a = activeRef.current;
    if (!a) return;
    const moved = { ...a, order: orderRef.current++ };
    const rest = [...pending, moved];
    void saveOrder(categoryId, rest);
    activeUsedRef.current = true; // 대기열에 새 차례로 이미 넣었다.
    const [next, ...others] = rest;
    setPending(others);
    activate(next);
  }

  async function clearAll() {
    await clearQueue(categoryId);
    setPending([]);
    if (!activeUsedRef.current) activeRef.current = null;
  }

  /** 자르기를 접고 처음 화면으로. 남은 사진은 버리지 않는다. */
  function exitToIdle() {
    returnActive();
    setResult(null);
    setRecognizedSourceImage(null);
    setStage("idle");
    onDone?.();
  }

  // ── 뒤로 가기가 페이지를 떠나지 않게 ────────────────────────────────────
  // 휴대폰에서 자르다가 화면 가장자리를 쓸면(제스처 뒤로 가기) 실모 화면을 통째로
  // 떠나 버렸다 — 이것도 "갑자기 뒤로 가짐"의 한 갈래다. 자르는 동안에는 같은 주소로
  // 기록을 하나 쌓아 두고, 뒤로 가기가 오면 **페이지를 떠나지 않고 자르기만 접는다.**
  // (Next 14.2 는 `history.pushState` 를 가로채 제 상태를 옮겨 담으므로 주소 없이
  // 쌓아도 라우터가 깨지지 않는다.)
  const inFlow = stage !== "idle";
  const guardRef = useRef(false);
  const ignorePopRef = useRef(false);
  const exitRef = useRef(exitToIdle);
  exitRef.current = exitToIdle;

  useEffect(() => {
    if (inFlow && !guardRef.current) {
      window.history.pushState({ reprintAddFlow: true }, "");
      guardRef.current = true;
    } else if (!inFlow && guardRef.current) {
      // 버튼으로 접었으면 쌓아 둔 기록을 걷는다(안 걷으면 다음 뒤로 가기가 헛돈다).
      guardRef.current = false;
      ignorePopRef.current = true;
      window.history.back();
    }
  }, [inFlow]);

  useEffect(() => {
    const onPop = () => {
      if (ignorePopRef.current) {
        ignorePopRef.current = false;
        return;
      }
      if (!guardRef.current) return;
      guardRef.current = false;
      exitRef.current();
      setNotice("자르기를 접었어요. 남은 사진은 그대로 있으니 ‘이어서 자르기’로 계속하세요.");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  async function handleCropConfirm(croppedDataUrl: string, cropMode: "ocr" | "problem" | "asis") {
    if (cropMode === "problem" || cropMode === "asis") {
      quickAdd(croppedDataUrl, cropMode);
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
      // 결과 화면이 곧 저장한다 — 이 사진은 다 쓴 것이다.
      markActiveUsed();
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
  function quickAdd(crop: string, addMode: "problem" | "asis") {
    const key = crypto.randomUUID();
    const nth = ++quickCountRef.current;
    const patch = (next: Partial<QuickItem>) =>
      setQuick((prev) => prev.map((q) => (q.key === key ? { ...q, ...next } : q)));
    setQuick((prev) => [{ key, crop, status: "saving" as const }, ...prev].slice(0, 30));
    setError(null);
    markActiveUsed();
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
      if (addMode === "problem") {
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

  /** 크롭 화면에서 사진을 못 열었다 — 그 사진만 빼고 다음으로 간다. */
  function handleCropImageError(message: string) {
    setError(message);
    const a = activeRef.current;
    if (a) removeFromQueue(a.id);
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

  const inCrop = stage === "crop" || stage === "upload";

  return (
    <div className="flex flex-col gap-4">
      {/* 사진 더 넣기(대기열 끝의 +). 어느 단계에서든 같은 입력칸을 쓴다. */}
      <input
        ref={addInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith("image/"));
          e.target.value = "";
          void handleImagesSelected(files);
        }}
      />

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" onClick={() => setError(null)} className="shrink-0 text-red-400 hover:text-red-600" aria-label="닫기">
            ×
          </button>
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <span className="min-w-0 flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="shrink-0 text-emerald-500 hover:text-emerald-700" aria-label="닫기">
            ×
          </button>
        </div>
      )}

      {stage === "idle" && !canAdd && (
        <div className="flex flex-col gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900">
          <p>토큰을 모두 사용해 오답을 더 추가할 수 없어요. 이용권을 구매하면 5000토큰이 충전돼요.</p>
          <a href="/api/checkout?plan=tokens" className="g-btn w-fit bg-amber-600 text-white hover:bg-amber-700">
            이용권 구매하기
          </a>
        </div>
      )}

      {/* ── 문제 넣기 ── 예전에는 "+ 오답 추가" 버튼 · 지면 통째로 · 국어 모드 ·
          CSV 가 한 화면에 전부 펼쳐져 있어 무엇부터 해야 할지 안 보였다. 탭 하나로
          모으고, 가장 많이 쓰는 "사진"은 누를 것 없이 곧바로 끌어다 놓게 한다.
          다른 탭의 패널은 감추기만 한다(작업하던 것이 날아가지 않게). */}
      {stage === "idle" && canAdd && (
        <section className="g-panel overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 sm:px-5">
            <h2 className="text-sm font-semibold text-ink">문제 넣기</h2>
            <div className="g-tabs" role="tablist" aria-label="넣는 방법">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="tab"
                  aria-selected={mode === m.id}
                  data-active={mode === m.id || undefined}
                  onClick={() => setMode(m.id)}
                  className="g-tab"
                  title={m.hint}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <div className="p-4 sm:p-5">
            <p className="mb-3 text-xs text-slate-500">{MODES.find((m) => m.id === mode)?.hint}</p>

            {/* `hidden` 은 껍데기에만 건다 — 같은 요소에 `flex` 를 주면 그 클래스가
                이겨서 감춰지지 않는다. */}
            <div hidden={mode !== "photo"}>
              <div className="flex flex-col gap-3">
                {pending.length > 0 && (
                  <ResumeCard
                    pending={pending}
                    onResume={() => {
                      const [next, ...rest] = pending;
                      setPending(rest);
                      setNotice(null);
                      activate(next);
                    }}
                    onClear={() => void clearAll()}
                  />
                )}
                <ImageUploader
                  onImagesSelected={(f) => void handleImagesSelected(f)}
                  onError={setError}
                  compact
                  pasteEnabled={mode === "photo"}
                />
              </div>
            </div>
            <div hidden={mode !== "page"}>
              {/* 지면 통째로 넣기. 손으로 영역을 그려 자르는 것은 누구나 쓴다 —
                  모델을 부르지 않아 공짜다. 영역을 **자동으로** 찾는 것만 무제한
                  계정에서 보이고, 막는 자리는 서버다(화면은 우회할 수 있다). */}
              <BatchSplitPanel
                onSave={handleSaveToCategory}
                answerByNumber={answerByNumber}
                unlimited={tokenStatus?.unlimited ?? false}
                byok={tokenStatus?.byok ?? false}
                figureCost={tokenStatus?.figureCost ?? null}
              />
            </div>
            <div hidden={mode !== "korean"}>
              {/* 국어는 지문 한 편에 문항 여러 개가 딸려서 낱개로 넣으면 인쇄할 때
                  지문과 문제가 갈라진다. 세트로 묶어 넣는 길을 따로 둔다. */}
              <KoreanModePanel
                onSave={handleSaveToCategory}
                unlimited={tokenStatus?.unlimited ?? false}
                byok={tokenStatus?.byok ?? false}
                figureCost={tokenStatus?.figureCost ?? null}
              />
            </div>
            <div hidden={mode !== "csv"}>
              {/* 이미 깔끔하게 잘려 있는 사진 여러 장 + 정답 CSV(학원가 "연계교재
                  선별" 자료가 흔히 이 모양)를 한 번에 매칭해서 올린다. */}
              <BulkMappedImportPanel categoryId={categoryId} embedded />
            </div>
          </div>
        </section>
      )}

      {(inCrop || stage === "loading" || stage === "result") && (
        <section className="g-panel flex flex-col gap-4 p-4 sm:p-5">
          {inCrop && (active || pending.length > 0 || preparing) && (
            <PhotoQueueStrip
              active={active}
              pending={pending}
              preparing={preparing}
              onJump={jumpTo}
              onRemove={removeFromQueue}
              onAdd={() => addInputRef.current?.click()}
            />
          )}

          {stage === "upload" && (
            <div key="upload" className="animate-stage-in flex flex-col gap-3">
              {pending.length > 0 ? (
                <ResumeCard
                  pending={pending}
                  onResume={() => {
                    const [next, ...rest] = pending;
                    setPending(rest);
                    activate(next);
                  }}
                  onClear={() => void clearAll()}
                />
              ) : (
                !preparing && (
                  <p className="text-sm text-slate-500">
                    남은 사진을 다 넣었어요. 더 넣으려면 사진을 고르세요.
                  </p>
                )
              )}
              <ImageUploader onImagesSelected={(f) => void handleImagesSelected(f)} onError={setError} compact />
              <button type="button" onClick={exitToIdle} className="g-btn g-btn-ghost self-start">
                그만 넣기
              </button>
            </div>
          )}

          {stage === "crop" && activeUrl && (
            <div key={activeUrl} className="animate-stage-in">
              <CropStage
                imageSrc={activeUrl}
                onConfirm={handleCropConfirm}
                onCancel={exitToIdle}
                onSkip={pending.length > 0 ? skipActive : undefined}
                onError={handleCropImageError}
                problemTokenCost={tokenStatus?.figureCost ?? null}
                unlimited={tokenStatus?.unlimited ?? false}
                byok={tokenStatus?.byok ?? false}
              />
            </div>
          )}

          {stage === "loading" && (
            <div key="loading" className="animate-stage-in flex flex-col items-center gap-4 py-16">
              <div className="relative h-12 w-12">
                <div className="absolute inset-0 rounded-full border-4 border-slate-200" />
                <div className="absolute inset-0 animate-spin rounded-full border-4 border-transparent border-t-blue-600" />
              </div>
              <div className="flex flex-col items-center gap-1">
                <p className="text-sm font-medium text-slate-700">문제를 읽고 있어요</p>
                <p className="text-xs text-slate-400">글자와 수식을 인식하는 중입니다. 보통 몇 초면 끝나요.</p>
              </div>
            </div>
          )}

          {stage === "result" && result && (
            <div key="result" className="animate-stage-in">
              <ResultStage
                result={result}
                onBack={() => setStage("crop")}
                onRestart={exitToIdle}
                onSaveToCategory={handleSaveToCategory}
                remainingCount={pending.length}
                onNext={advanceQueue}
                onAddAnother={() => activate(null)}
                sourceImage={recognizedSourceImage}
              />
            </div>
          )}
        </section>
      )}

      {quick.length > 0 && stage !== "result" && stage !== "loading" && (
        <QuickList
          items={quick}
          onClear={() => setQuick((prev) => prev.filter((q) => q.status === "saving" || q.status === "saved"))}
        />
      )}
    </div>
  );
}

/** 자르다 만 사진이 남아 있을 때(탭이 다시 떴거나, 뒤로 가기로 접었거나). */
function ResumeCard({
  pending,
  onResume,
  onClear,
}: {
  pending: QueuedPhoto[];
  onResume: () => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-blue-200 bg-blue-50/70 px-4 py-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink">자르다 만 사진 {pending.length}장이 있어요</p>
        <p className="text-xs text-slate-500">이 기기에 저장돼 있어서 창을 닫았다 와도 남아 있어요.</p>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2">
        <button type="button" onClick={onClear} className="g-btn g-btn-ghost g-btn-sm">
          비우기
        </button>
        <button type="button" onClick={onResume} className="g-btn g-btn-primary g-btn-sm">
          이어서 자르기
        </button>
      </div>
    </div>
  );
}

/** 방금 넣은 문제들 — 저장 중 / 번호 · 정답 / 실패. AI 진행은 오른쪽 아래 패널에 뜬다. */
function QuickList({ items, onClear }: { items: QuickItem[]; onClear: () => void }) {
  const busy = items.some((q) => q.status === "saving" || q.status === "saved");
  return (
    <div className="g-panel flex flex-col gap-2 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-slate-600">
          방금 넣은 문제 {items.length}개
          {busy && <span className="ml-1.5 text-slate-400">· 뒤에서 처리 중</span>}
        </p>
        {!busy && (
          <button type="button" onClick={onClear} className="text-xs text-slate-400 hover:text-slate-600">
            지우기
          </button>
        )}
      </div>
      <ul className="flex gap-2 overflow-x-auto pb-1">
        {items.map((q) => (
          <li key={q.key} className="flex w-44 shrink-0 items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/60 p-1.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={q.crop} alt="" className="h-10 w-10 shrink-0 rounded-md bg-white object-cover object-top" />
            <span
              className={`min-w-0 text-xs leading-snug ${
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
