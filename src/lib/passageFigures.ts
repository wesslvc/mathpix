import { createClient } from "@/lib/supabase/client";
import { putBlob } from "./blobClient";
import { cardUrl } from "./cardUrl";
import {
  ensureDataUrl,
  imageSizeOf,
  MODEL_INPUT_DIM,
  prepareFigureForModel,
  trimBlankBorder,
} from "./figureImage";
import type { RichBlock } from "./kice/richText";
import { placePassageFigures } from "./kice/passageFigurePlace";

/**
 * **지문 안 그림을 붙인다**(2026-09-25, 사용자 지시 — "luna 가 지문 영역에 그림이
 * 있어요라고 sol 에게 알려 줘, 그러면 sol 이 sunburst 시켜, 그다음 그 이미지를
 * 붙여 주는 것까지 싹").
 *
 *   ① luna(지문 찾기)가 지문 자리와 **그 안의 그림 자리**를 함께 돌려준다
 *   ② 그림을 원본에서 잘라 지문 사진 뒤에 붙여 sol(지문 인식)에 보낸다 —
 *      sol 은 각 그림이 지문의 어디에 들어가는지 `figure` 블록(`f1`, `f2`…)으로 짚는다
 *   ③ 짚은 그림마다 sunburst(`/api/figure`, 그림 하나 모드)로 다시 그린다
 *   ④ 결과를 스토리지에 올려 `figure.src` 로 붙인다 — PDF 가 그 자리에 그린다
 *
 * sunburst 가 실패하면 **원본 크롭을 그대로** 붙인다(그림이 통째로 빠지는 것보다
 * 낫다). sol 이 자리를 못 짚은 그림은 **지문 끝에** 붙이고 알린다 — 버리지 않는다.
 *
 * 브라우저 전용이다(이미지를 줄이고 자르는 일은 캔버스가 한다).
 */

/** 지문 안 그림 하나. `crop` 은 원본에서 자른 것, `scale` 은 지문 폭 대비 그림 폭. */
export type PassageFigureInput = {
  crop: string;
  scale: number;
  /** 이미 붙어 있던 그림(다시 인식할 때) — 있으면 다시 그리지 않고 그대로 쓴다. */
  src?: string;
  ratio?: number;
};

/** sol 에게 보낼 작은 사본(입력 토큰을 아낀다 — 자리만 알아보면 된다). */
export async function figuresForReader(figs: PassageFigureInput[]): Promise<string[]> {
  return Promise.all(
    figs.map(async (f) => prepareFigureForModel(await ensureDataUrl(f.crop), 512)),
  );
}

/** 그림 하나를 sunburst 로 다시 그린다. 실패하면 null. */
async function redraw(crop: string): Promise<{ image: string; tokens?: number; krw?: number } | null> {
  try {
    const forModel = await prepareFigureForModel(await ensureDataUrl(crop), MODEL_INPUT_DIM);
    const size = await imageSizeOf(forModel);
    const res = await fetch("/api/figure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: forModel,
        mode: "figure",
        korean: true,
        width: size?.width,
        height: size?.height,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      image?: string;
      chargedTokens?: number | null;
      usage?: { estKrw?: number };
      error?: string;
    };
    if (!res.ok || typeof json.image !== "string" || !json.image.startsWith("data:image/")) {
      console.warn("[passageFigures] 다시 그리기 실패:", json.error ?? res.status);
      return null;
    }
    return {
      image: await trimBlankBorder(json.image),
      tokens: typeof json.chargedTokens === "number" ? json.chargedTokens : undefined,
      krw: json.usage?.estKrw,
    };
  } catch (err) {
    console.warn("[passageFigures] 다시 그리기 실패:", err);
    return null;
  }
}

/**
 * 그림을 스토리지에 올리고 주소를 돌려준다. 실패하면 data URL 그대로(그림을
 * 잃는 것보다 DB 에 조금 더 남는 편이 낫다 — `figureBlob.ts` 와 같은 판단).
 */
async function upload(dataUrl: string): Promise<string> {
  try {
    const m = dataUrl.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,/);
    if (!m) return dataUrl;
    const mime = m[1] === "jpg" ? "jpeg" : m[1];
    const ext = mime === "jpeg" ? "jpg" : mime;
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return dataUrl;
    const blob = await (await fetch(dataUrl)).blob();
    const path = `${user.id}/passage-figures/${crypto.randomUUID()}.${ext}`;
    const up = await putBlob(supabase, path, blob, `image/${mime}`);
    return up.ok ? cardUrl(path) : dataUrl;
  } catch {
    return dataUrl;
  }
}

export type AttachResult = {
  blocks: RichBlock[];
  /** 화면에 보여 줄 한 줄 요약. 그림이 없으면 빈 글자. */
  note: string;
  /** sunburst 에 쓴 토큰(일반 계정) / 원가(무제한). */
  tokens: number;
  krw: number;
};

/**
 * sol 이 짚은 자리에 그림을 붙인다(③④). `onProgress` 로 진행을 알린다.
 */
export async function attachPassageFigures(
  blocks: RichBlock[],
  figs: PassageFigureInput[],
  onProgress?: (text: string) => void,
): Promise<AttachResult> {
  if (figs.length === 0) {
    return { blocks, note: "", tokens: 0, krw: 0 };
  }
  const toMake = figs.filter((f) => !f.src).length;
  let done = 0;
  onProgress?.(toMake ? `그림 ${toMake}개를 sunburst 로 다시 그리는 중…` : "그림을 붙이는 중…");

  let tokens = 0;
  let krw = 0;
  let kept = 0;
  const made = await Promise.all(
    figs.map(async (f) => {
      if (f.src) return { src: f.src, ratio: f.ratio ?? 1, scale: f.scale };
      const drawn = await redraw(f.crop);
      done += 1;
      onProgress?.(`그림 다시 그리는 중… (${done}/${toMake})`);
      if (drawn) {
        tokens += drawn.tokens ?? 0;
        krw += drawn.krw ?? 0;
      } else {
        kept += 1;
      }
      const image = drawn?.image ?? (await ensureDataUrl(f.crop));
      const size = await imageSizeOf(image);
      return {
        src: await upload(image),
        ratio: size ? size.height / size.width : 1,
        scale: f.scale,
      };
    }),
  );

  const placed = placePassageFigures(blocks, made);

  const parts = [`그림 ${figs.length}개 붙임`];
  if (toMake > 0) parts.push(`sunburst 로 ${toMake - kept}개 다시 그림`);
  if (kept > 0) parts.push(`${kept}개는 다시 그리지 못해 원본을 붙였어요`);
  if (placed.missing > 0) parts.push(`${placed.missing}개는 자리를 못 짚어 지문 끝에 붙였어요`);
  return { blocks: placed.blocks, note: parts.join(" · "), tokens, krw };
}

/** 이미 붙어 있는 그림들(다시 인식할 때 sol 에게 다시 알려 준다). */
export function existingPassageFigures(blocks: RichBlock[] | undefined): PassageFigureInput[] {
  const out: PassageFigureInput[] = [];
  const walk = (list: RichBlock[]) => {
    for (const b of list) {
      if (b.kind === "box") walk(b.blocks);
      else if (b.kind === "figure" && b.src) {
        out.push({ crop: b.src, src: b.src, ratio: b.ratio, scale: b.scale ?? 1 });
      }
    }
  };
  walk(blocks ?? []);
  return out;
}
