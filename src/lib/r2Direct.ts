/**
 * 이 브라우저가 R2 와 **직접**(CORS) 주고받을 수 있는가 — 브라우저 전용(2026-10-05).
 *
 * Vercel 함수 전송량(Fast Origin Transfer, 무료 10GB)을 다 써서, 그림 바이트가 우리 서버를 안 지나게 바꿨다:
 * 받기는 `/api/card` 가 R2 서명 주소로 넘겨 주고, 올리기는 서명 주소로 R2 에 바로 PUT 한다. 둘 다 **버킷 CORS** 가 있어야
 * 되므로, 한 번 시험해 보고(`/api/blob/cors`) 되면 `r2d=1` 쿠키를 심는다 — `/api/card` 도 이 쿠키를 보고 넘겨 줄지 정한다.
 * 안 되면 `r2d=0` 을 잠깐(1시간) 두고 예전처럼 서버를 거친다. 되는 것도 12시간마다 다시 본다(CORS 를 바꿨을 때 따라가게).
 */

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

function setCookie(value: "0" | "1", maxAge: number) {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `r2d=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`;
}

let pending: Promise<boolean> | null = null;

/** 직접 주고받을 수 있으면 true. 처음 한 번만 시험하고 결과를 쿠키에 둔다. */
export function r2DirectReady(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  const c = readCookie("r2d");
  if (c === "1") return Promise.resolve(true);
  if (c === "0") return Promise.resolve(false);
  pending ??= check().finally(() => {
    pending = null;
  });
  return pending;
}

async function check(): Promise<boolean> {
  let info: { get?: string; put?: string; probePath?: string };
  try {
    const res = await fetch("/api/blob/cors", { cache: "no-store" });
    // 로그인 전·R2 꺼짐은 쿠키를 안 남긴다(로그인하면 다시 본다).
    if (res.status === 401 || res.status === 501 || res.status === 503) return false;
    if (!res.ok) {
      setCookie("0", 3600);
      return false;
    }
    info = await res.json();
  } catch {
    return false;
  }
  try {
    const got = await fetch(info.get!, { mode: "cors", cache: "no-store" });
    const putRes = await fetch(info.put!, {
      method: "PUT",
      mode: "cors",
      headers: { "Content-Type": "text/plain" },
      body: "ok",
    });
    const ok = got.ok && (await got.text()) === "ok" && putRes.ok;
    setCookie(ok ? "1" : "0", ok ? 43200 : 3600);
    if (putRes.ok && info.probePath) {
      void fetch("/api/blob", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: [info.probePath] }),
      }).catch(() => {});
    }
    if (!ok) console.warn("[r2Direct] R2 와 직접 주고받기가 안 됩니다(버킷 CORS 확인) — 서버를 거칩니다.");
    return ok;
  } catch (err) {
    // CORS 가 막히면 fetch 가 TypeError 로 던진다.
    console.warn("[r2Direct] R2 CORS 시험 실패 — 서버를 거칩니다.", err);
    setCookie("0", 3600);
    return false;
  }
}

/** 서명 주소로 R2 에 바로 올린다. 실패하면 false(부르는 쪽이 예전 길로 간다). */
export async function putDirect(path: string, blob: Blob, contentType: string): Promise<boolean> {
  try {
    const sign = await fetch("/api/blob/sign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [path] }),
    });
    if (!sign.ok) return false;
    const { urls } = (await sign.json()) as { urls?: string[] };
    if (!urls?.[0]) return false;
    const res = await fetch(urls[0], { method: "PUT", mode: "cors", headers: { "Content-Type": contentType }, body: blob });
    if (!res.ok) console.warn(`[r2Direct] R2 직접 올리기 실패(${res.status})`, (await res.text()).slice(0, 200));
    return res.ok;
  } catch (err) {
    console.warn("[r2Direct] R2 직접 올리기 요청 실패", err);
    return false;
  }
}
