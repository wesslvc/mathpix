"use client";

import { loadDrawableFromFile } from "./cropImage";

/**
 * 여러 장 올린 사진의 **대기열** — 브라우저에 저장해 두고, 줄여서 들고 있는다.
 *
 * 사용자 신고(2026-09-28) — "여러 장 올려놨는데 갑자기 뒤로 가짐(튕김)".
 * 원인이 둘 겹쳐 있었다:
 *
 *  1. **고른 사진을 전부 원본 그대로 base64 글자로 바꿔 한꺼번에 들고 있었다**
 *     (`Promise.all(files.map(readAsDataURL))`). 휴대폰 카메라 사진은 한 장에
 *     4~12MB 라 글자로는 5~16MB, 열 장이면 100MB 가 넘는 문자열이 React state 에
 *     그대로 앉는다. 게다가 크롭 화면이 그 원본을 통째로 디코딩한다(1200만 화소면
 *     RGBA 로 48MB). 모바일 브라우저는 메모리가 모자라면 **탭을 죽였다 다시
 *     띄운다** — 사용자 눈에는 "갑자기 처음 화면으로 튕긴" 것이다. 사진을 고르려고
 *     갤러리 앱이 앞에 떠 있는 동안 뒤의 탭이 정리되는 일도 흔하다.
 *  2. **다시 띄우면 대기열이 통째로 사라졌다** — 메모리에만 있었으니까.
 *
 * 그래서 ① 고르는 순간 **한 장씩** 열어 긴 변 3000px JPEG 으로 줄이고 base64 가
 * 아니라 Blob 으로 든다(Blob 은 JS 힙 바깥에 있어 훨씬 가볍다), ② 작은 미리보기
 * (긴 변 240px)를 따로 만들어 목록은 그것만 그리고, ③ IndexedDB 에 실모별로
 * 저장해 **탭이 죽었다 살아나도 남은 사진이 그대로 있다.**
 *
 * 3000px 은 `cropImage.ts` 의 `DECODE_MAX_DIM` 과 같은 값이다 — 한 문제만 자르는
 * 화면은 잘린 것을 긴 변 1600px 로 줄여 보내므로, 반을 잘라도 1500px 가 남는다.
 *
 * IndexedDB 를 못 쓰는 환경(사생활 보호 모드 등)에서는 저장만 안 될 뿐 나머지는
 * 그대로 돈다.
 */

export type QueuedPhoto = {
  id: string;
  /** 자를 재료(긴 변 3000px JPEG). */
  blob: Blob;
  /** 목록에 그릴 작은 그림(긴 변 240px JPEG). */
  thumb: Blob;
  name: string;
  /** 들어온 차례. 저장했다 되살릴 때 순서를 지킨다. */
  order: number;
};

const FULL_DIM = 3000;
const THUMB_DIM = 240;

function toJpegBlob(src: CanvasImageSource, w: number, h: number, dim: number, q: number): Promise<Blob> {
  const scale = Math.min(1, dim / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("캔버스 컨텍스트를 생성할 수 없습니다."));
  // JPEG 에는 투명이 없다 — 투명한 PNG(캡처 등)가 검게 나오지 않게 흰 바탕을 깐다.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(src, 0, 0, cw, ch);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("사진을 줄이지 못했습니다."))),
      "image/jpeg",
      q,
    ),
  );
}

/**
 * 사진 파일 하나를 대기열에 넣을 모양으로 만든다. 여러 방법으로 열어 보는
 * `loadDrawableFromFile` 을 쓴다(갤럭시 원본·content:// 사진 대응, 채점 화면과 같다).
 */
export async function preparePhoto(file: File, order: number): Promise<QueuedPhoto> {
  const d = await loadDrawableFromFile(file);
  try {
    const blob = await toJpegBlob(d.src, d.width, d.height, FULL_DIM, 0.92);
    const thumb = await toJpegBlob(d.src, d.width, d.height, THUMB_DIM, 0.8);
    return { id: crypto.randomUUID(), blob, thumb, name: file.name, order };
  } finally {
    d.close();
  }
}

/**
 * 모델(luna 자동 자르기)에 보낼 크기로 줄인 데이터 URL. 사진 한 장에 문제 하나라 긴 변 1600px 이면 충분하다 — 모델은
 * 어차피 짧은 변을 768px 쯤으로 줄여 본다.
 */
export async function photoForModel(p: QueuedPhoto, dim = 1600): Promise<string> {
  const bmp = await createImageBitmap(p.blob);
  try {
    const scale = Math.min(1, dim / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("캔버스 컨텍스트를 생성할 수 없습니다.");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    bmp.close();
  }
}

// ── IndexedDB ─────────────────────────────────────────────────────────────

const DB = "reprint-photos";
const STORE = "queue";

type Row = QueuedPhoto & { category: string };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("no indexedDB"));
      return;
    }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: "id" });
      store.createIndex("category", "category");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? (req.result as T) : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

/** 이 실모에 남아 있던 사진들(들어온 차례대로). 못 읽으면 빈 목록. */
export async function loadQueue(category: string): Promise<QueuedPhoto[]> {
  try {
    const rows =
      (await tx<Row[]>("readonly", (s) => s.index("category").getAll(category))) ?? [];
    return rows
      .sort((a, b) => a.order - b.order)
      .map(({ id, blob, thumb, name, order }) => ({ id, blob, thumb, name, order }));
  } catch {
    return [];
  }
}

export async function savePhoto(category: string, p: QueuedPhoto): Promise<void> {
  try {
    await tx("readwrite", (s) => {
      s.put({ ...p, category } satisfies Row);
    });
  } catch {
    // 저장을 못 해도 이번 화면에서는 계속 쓸 수 있다.
  }
}

export async function removePhoto(id: string): Promise<void> {
  try {
    await tx("readwrite", (s) => {
      s.delete(id);
    });
  } catch {
    // 남아 있으면 다음에 "이어서"에 한 번 더 뜰 뿐이다.
  }
}

/** 순서를 바꿨으면 새 차례를 적어 둔다. */
export async function saveOrder(category: string, photos: QueuedPhoto[]): Promise<void> {
  try {
    await tx("readwrite", (s) => {
      photos.forEach((p, i) => s.put({ ...p, order: i, category } satisfies Row));
    });
  } catch {
    // 순서만 못 지킬 뿐이다.
  }
}

export async function clearQueue(category: string): Promise<void> {
  const rows = await loadQueue(category);
  try {
    await tx("readwrite", (s) => {
      rows.forEach((r) => s.delete(r.id));
    });
  } catch {
    // 무시.
  }
}
