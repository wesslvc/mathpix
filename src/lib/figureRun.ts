// AI 그림 생성의 서버 쪽 알맹이. **서버 전용**이다.
//
// 두 곳이 같이 쓴다 — 예전부터 있던 `/api/figure`(화면이 기다리며 받는 길)와
// 서버 큐의 일꾼(`/api/figure-jobs/run`, 브라우저를 닫아도 도는 길). 모델을
// 고르고 · 시간이 다 되면 먼저 끊고 · 결과를 문제 행에 저장하는 규칙이 두 벌이
// 되면 반드시 한쪽만 고쳐진다(이 저장소가 여러 번 데인 자리다).

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  FigureImageError,
  figureImageModelIds,
  generateFigureImage,
  isValidByokImageModel,
  type FigureMode,
  type FigureUsage,
} from "@/lib/figureImageGen";
import { thumbPathFor } from "@/lib/cardThumb";
import { cardUrl } from "@/lib/cardUrl";
import { keepOrigin } from "@/lib/figureOrigin";
import { r2Configured, r2Delete, r2Get, r2Put } from "@/lib/r2";

/**
 * 모델을 갈아타며 재시도할 최대 횟수.
 *
 * 기본 설정에서는 모델이 하나뿐이라 실제로는 한 번만 시도한다. 예전에 후보를
 * 여러 개 두고 실패하면 다음으로 내려가게 했다가, 고른 적도 없는 모델에
 * 요금이 나갔다. 폴백은 OPENAI_FIGURE_IMAGE_MODELS로 명시했을 때만 생긴다.
 */
const MAX_MODEL_ATTEMPTS = 2;

/**
 * BYOK는 본인이 고른 모델 하나만 쓴다(비용이 본인 계정으로 나가므로 우리 쪽
 * 폴백 캐스케이드가 필요 없다). 못 골랐으면 앱 기본 모델과 같은 이름을 그대로
 * 쓰되 본인 키로 부른다.
 */
export function pickModelIds(byok: boolean, byokModel: string | null): string[] {
  return byok
    ? [byokModel && isValidByokImageModel(byokModel) ? byokModel : figureImageModelIds()[0]]
    : figureImageModelIds();
}

export type RunInput = {
  image: string;
  mode: FigureMode;
  korean: boolean;
  instruction?: string;
  inputSize?: { width: number; height: number };
  modelIds: string[];
  byokApiKey?: string;
  /** 이 시간(ms)이 지나면 우리가 먼저 끊는다. */
  deadlineMs: number;
  /** 로그 머리말. */
  tag: string;
};

export type RunOutcome =
  | { ok: true; dataUrl: string; modelId: string; usage?: FigureUsage }
  | { ok: false; status: number; error: string };

/**
 * 모델을 불러 그림 한 장을 받는다. **토큰은 건드리지 않는다** — 차감·환불은
 * 부르는 쪽 사정이 달라서(화면은 세션으로, 일꾼은 서비스 키로) 거기서 한다.
 * 실패면 `ok:false` 이고, 그때는 부르는 쪽이 보증금을 돌려줘야 한다.
 */
export async function runFigureGeneration(input: RunInput): Promise<RunOutcome> {
  const { modelIds, tag } = input;
  let lastError: string | null = null;

  // 시간이 다 되면 우리가 먼저 끊는다. **Vercel 이 함수를 죽이면 환불 코드가
  // 아예 돌지 못한다** — 토큰만 나가고 아무것도 안 남는다.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), input.deadlineMs);
  const seconds = Math.round(input.deadlineMs / 1000);

  try {
    for (let i = 0; i < Math.min(modelIds.length, MAX_MODEL_ATTEMPTS); i++) {
      const modelId = modelIds[i];
      try {
        const result = await generateFigureImage(
          input.image,
          modelId,
          input.mode,
          input.korean,
          undefined,
          deadline.signal,
          input.inputSize,
          input.instruction,
          input.byokApiKey,
        );
        if (!result) {
          return {
            ok: false,
            status: 502,
            error: "자료를 다시 그리지 못했습니다. 다시 시도해주세요.",
          };
        }
        console.info(`[${tag}] ok model=${modelId}`);
        return { ok: true, dataUrl: result.dataUrl, modelId, usage: result.usage };
      } catch (err) {
        // 시간이 다 돼 우리가 끊은 경우. 다음 모델로 내려가 봐야 남은 시간이 없다.
        if (deadline.signal.aborted) {
          console.error(`[${tag}] ${seconds}초 안에 끝나지 않아 중단함`);
          return {
            ok: false,
            status: 504,
            error: `이미지 생성이 제한 시간 안에 끝나지 않았습니다. 토큰은 돌려드렸어요. 문제 영역을 조금 좁게 잘라 다시 시도해주세요.`,
          };
        }
        // 404(없는 이름)/403(권한 없음)/429(한도)면 이 모델로는 안 된다.
        if (err instanceof FigureImageError && err.shouldTryNextModel) {
          console.warn(`[${tag}] ${modelId} 사용 불가(${err.status}), 다음 모델로 내려감`);
          lastError = err.message;
          continue;
        }
        console.error(`[${tag}] unexpected error:`, err);
        return {
          ok: false,
          status: 502,
          error: err instanceof Error ? err.message : "알 수 없는 오류",
        };
      }
    }

    console.error(`[${tag}] 쓸 수 있는 이미지 모델을 찾지 못함. 후보=${modelIds.join(", ")}`);
    return {
      ok: false,
      status: 503,
      error:
        "쓸 수 있는 자료 생성 모델을 찾지 못했습니다. 관리자는 /api/figure/models 에서 이 키로 부를 수 있는 이미지 모델을 확인하고 OPENAI_FIGURE_IMAGE_MODELS 환경변수에 넣어주세요." +
        (lastError ? ` (마지막 오류: ${lastError})` : ""),
    };
  } finally {
    // 타이머를 꼭 지운다. 인스턴스가 재사용되면 엉뚱한 요청을 끊는다.
    clearTimeout(timer);
  }
}

/**
 * **금액은 무제한·BYOK 계정에만 보여준다.** 막는 자리는 서버다 — 화면에서
 * 숨기는 건 얼마든지 우회할 수 있다. 일반 사용자에게는 토큰 수만 준다.
 */
export function visibleUsage(
  usage: FigureUsage | undefined,
  showMoney: boolean,
): Partial<FigureUsage> | undefined {
  if (!usage) return undefined;
  if (showMoney) return usage;
  return {
    inputText: usage.inputText,
    inputImage: usage.inputImage,
    output: usage.output,
    cached: usage.cached,
  };
}

/** 데이터 URL 을 바이트와 형식으로 가른다. */
export function splitDataUrl(
  dataUrl: string,
): { bytes: Buffer; mime: string; ext: string } | null {
  const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) return null;
  const mime = m[1];
  const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
  return { bytes: Buffer.from(m[2], "base64"), mime, ext };
}

/**
 * 파일을 올린다 — **R2 가 켜져 있으면 그쪽**, 실패하거나 꺼져 있으면
 * problem-images 버킷. 화면 쪽(`blobClient.ts`)과 같은 판단이다. 읽는 쪽
 * (`/api/card`)이 두 곳을 다 보므로 어디에 있든 똑같이 보인다.
 */
export async function storeBytes(
  supabase: SupabaseClient,
  path: string,
  bytes: Uint8Array,
  mime: string,
): Promise<boolean> {
  if (r2Configured()) {
    try {
      await r2Put(path, bytes, mime);
      return true;
    } catch (err) {
      console.error("[figureRun] R2 쓰기 실패, Supabase 로 넘어감:", err);
    }
  }
  const { error } = await supabase.storage
    .from("problem-images")
    .upload(path, bytes, { contentType: mime });
  if (error) {
    console.error("[figureRun] Supabase 쓰기 실패:", error.message);
    return false;
  }
  return true;
}

/** 올린 파일을 데이터 URL 로 읽어 온다(R2 먼저, 없으면 Supabase). */
export async function loadAsDataUrl(
  supabase: SupabaseClient,
  path: string,
): Promise<string | null> {
  if (r2Configured()) {
    try {
      const res = await r2Get(path);
      if (res) {
        const mime = res.headers.get("content-type") || "image/jpeg";
        const buf = Buffer.from(await res.arrayBuffer());
        return `data:${mime};base64,${buf.toString("base64")}`;
      }
    } catch (err) {
      console.error("[figureRun] R2 읽기 실패:", err);
    }
  }
  const { data, error } = await supabase.storage.from("problem-images").download(path);
  if (error || !data) return null;
  const mime = data.type || "image/jpeg";
  const buf = Buffer.from(await data.arrayBuffer());
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/** 두 곳 다에서 지운다(없는 것을 지워도 성공이다). */
export async function removeStored(
  supabase: SupabaseClient,
  paths: string[],
): Promise<void> {
  const list = paths.filter(Boolean);
  if (list.length === 0) return;
  await supabase.storage.from("problem-images").remove(list);
  if (r2Configured()) {
    await r2Delete(list).catch((err) => console.error("[figureRun] R2 삭제 실패:", err));
  }
}

/**
 * 다 그린 문제 이미지를 서버가 직접 저장한다. 성공하면 새 image_path 를 준다.
 *
 * **브라우저를 닫아도 결과가 남게 하려는 것이다.** 화면이 살아 있으면 화면이
 * 더 예쁜 카드로 다시 저장하므로 이건 "최소한 남기는" 보험이다.
 *
 * `ownerId` 를 주면 그 사람의 행만 고친다 — 서비스 키로 부르는 일꾼은 RLS 가
 * 대신 막아 주지 않으므로 여기서 막는다.
 */
export async function persistWholeProblem(
  supabase: SupabaseClient,
  problemId: string,
  figureId: string | null,
  dataUrl: string,
  ownerId?: string,
): Promise<string | null> {
  try {
    let q = supabase.from("problems").select("image_path, box_range").eq("id", problemId);
    if (ownerId) q = q.eq("user_id", ownerId);
    const { data: row } = await q.maybeSingle();
    if (!row?.image_path) return null;

    const parts = splitDataUrl(dataUrl);
    if (!parts) return null;

    const dir = String(row.image_path).split("/").slice(0, -1).join("/");
    const newPath = `${dir}/${crypto.randomUUID()}.${parts.ext}`;
    if (!(await storeBytes(supabase, newPath, parts.bytes, parts.mime))) return null;

    // 그림 목록에서 이 그림의 마크업만 갈아끼운다. 화면이 저장해 둔 자리·크기는
    // 건드리지 않는다(사용자가 옮겨 놨을 수 있다).
    const box = (row.box_range ?? {}) as Record<string, unknown>;
    const figures = Array.isArray(box.figures)
      ? (box.figures as Record<string, unknown>[])
      : [];
    // **base64 를 그대로 box_range 에 넣지 않는다.** 문제 전체 모드에서는 그림
    // 한 장이 곧 카드 전체라, 방금 올린 바이트가 이 그림의 마크업과 같다.
    const markup = `<img src="${cardUrl(newPath)}" alt="" />`;
    // 갈아치우기 전의 그림을 원본으로 남긴다. **이미 있으면 덮지 않는다.**
    const nextFigures =
      figures.length > 0
        ? figures.map((f) =>
            !figureId || f.id === figureId
              ? { ...keepOrigin(f, f.markup), markup, ai: true }
              : f,
          )
        : [
            {
              id: figureId ?? crypto.randomUUID(),
              markup,
              layout: { scale: 100, offsetX: 0, offsetY: 0 },
              position: 0,
              kind: "figure",
            },
          ];

    const { error: dbErr } = await supabase
      .from("problems")
      .update({ image_path: newPath, box_range: { ...box, figures: nextFigures } })
      .eq("id", problemId);
    if (dbErr) {
      await removeStored(supabase, [newPath]);
      return null;
    }
    // 예전 원본과 그 미리보기를 지운다(미리보기는 서버가 못 만든다 — 낡은
    // 미리보기를 남겨 두면 지금 그림과 다른 그림이 목록에 뜬다).
    await removeStored(supabase, [
      String(row.image_path),
      thumbPathFor(String(row.image_path)),
    ]);
    return newPath;
  } catch (err) {
    console.error("[figureRun] 결과 저장 실패:", err);
    return null;
  }
}

/**
 * 그림 하나(figure) 모드의 결과를 **재료(box_range.figures)에만** 먼저 넣는다.
 *
 * 합쳐진 카드 PNG(image_path)는 본문과 함께 카드를 다시 그려야 해서 브라우저
 * (html-to-image)에서만 만들 수 있다. 그래도 재료를 먼저 넣어 두면 앱을 다시
 * 열지 않더라도 결과는 잃지 않는다 — 수정 화면이 재료로 카드를 조립하고, 한 번
 * 저장하면 카드 PNG 도 따라온다. 앱이 열리면 화면이 카드까지 다시 그린다.
 *
 * 그 그림이 이미 없어졌으면(사용자가 지웠다) 아무것도 안 한다.
 */
export async function persistFigureMaterial(
  supabase: SupabaseClient,
  problemId: string,
  figureId: string,
  resultPath: string,
  ownerId: string,
): Promise<boolean> {
  try {
    const { data: row } = await supabase
      .from("problems")
      .select("box_range")
      .eq("id", problemId)
      .eq("user_id", ownerId)
      .maybeSingle();
    if (!row) return false;
    const box = (row.box_range ?? {}) as Record<string, unknown>;
    const figures = Array.isArray(box.figures)
      ? (box.figures as Record<string, unknown>[])
      : [];
    if (!figures.some((f) => f.id === figureId)) return false;
    const markup = `<img src="${cardUrl(resultPath)}" alt="" />`;
    const nextFigures = figures.map((f) =>
      f.id === figureId ? { ...keepOrigin(f, f.markup), markup, ai: true } : f,
    );
    const { error } = await supabase
      .from("problems")
      .update({ box_range: { ...box, figures: nextFigures } })
      .eq("id", problemId);
    return !error;
  } catch (err) {
    console.error("[figureRun] 재료 저장 실패:", err);
    return false;
  }
}
