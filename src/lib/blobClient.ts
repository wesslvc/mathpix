import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 그림을 올리고 지우는 자리 — **화면이 쓰는 쪽.**
 *
 * 예전에는 화면마다 `supabase.storage.from("problem-images").upload(...)` 를
 * 직접 불렀다. 저장하는 자리가 넷(오답추가 · 수정 재저장 · 화면 밖 재저장 ·
 * 미리보기)이라, 저장소를 옮기려면 넷을 다 고쳐야 하고 **하나라도 빠지면 그
 * 경로로 들어온 그림만 조용히 다른 곳에 쌓인다**(고아 150장을 만든 사고가
 * 정확히 그 모양이었다). 그래서 한 곳으로 모았다.
 *
 * **실패하면 예전 길로 간다.** 저장이 실패하면 사용자가 방금 한 일을 잃는다 —
 * R2 가 안 되거나(키 없음·장애) 파일이 너무 크면 Supabase 로 올린다. 읽는 쪽
 * (`/api/card`)이 두 곳을 다 보므로 어디에 저장됐든 똑같이 보인다.
 */

/** Vercel 요청 본문 상한(4.5MB)보다 넉넉히 낮게. 넘으면 Supabase 로 간다. */
const MAX_VIA_SERVER = 4 * 1024 * 1024;

/**
 * 실패한 응답에서 읽을 수 있는 이유를 꺼낸다.
 *
 * **이게 없어서 한참 헤맸다.** 예전에는 실패하면 아무 말 없이 Supabase 로
 * 내려갔는데, 그러면 401(세션) · 403(경로) · 501(R2 꺼짐) · 502(R2 오류)가
 * 전부 **똑같이 보인다** — 저장은 되는데 R2 에는 아무것도 안 쌓이고, 왜인지
 * 알 방법이 없다. 실제로 그 상태로 하루를 보냈다.
 */
async function reason(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "(본문을 읽지 못함)";
  }
}

/**
 * 올린다. 성공하면 어디에 저장됐는지 돌려준다.
 *
 * 던지지 않는다 — 부르는 쪽은 `ok` 만 보면 된다(예전 `upload()` 의 `error` 와
 * 같은 자리).
 */
export async function putBlob(
  supabase: SupabaseClient,
  path: string,
  blob: Blob,
  contentType: string,
): Promise<{ ok: true; store: "r2" | "supabase" } | { ok: false; error: string }> {
  if (blob.size <= MAX_VIA_SERVER) {
    try {
      const res = await fetch(`/api/blob?path=${encodeURIComponent(path)}`, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: blob,
      });
      if (res.ok) return { ok: true, store: "r2" };
      // 501 = R2 가 꺼져 있다. 그 밖의 실패도 예전 길로 내려간다 — 저장을
      // 통째로 잃는 것보다 낫다. **다만 조용히 넘어가지는 않는다.**
      console.warn(`[blob] R2 업로드 실패(${res.status}) → Supabase 로 갑니다.`, await reason(res));
    } catch (err) {
      // 네트워크 오류도 마찬가지.
      console.warn("[blob] R2 업로드 요청 자체가 실패 → Supabase 로 갑니다.", err);
    }
  } else {
    console.warn(`[blob] ${blob.size}바이트라 서버를 못 거칩니다 → Supabase 로 갑니다.`);
  }

  const { error } = await supabase.storage
    .from("problem-images")
    .upload(path, blob, { contentType });
  if (error) return { ok: false, error: error.message };
  return { ok: true, store: "supabase" };
}

/**
 * 지운다. **R2 와 Supabase 양쪽에서** 지운다(어디에 있는지 몰라도 된다).
 *
 * 실패해도 던지지 않는다 — 지우기가 안 됐다고 삭제 자체를 막으면 사용자는
 * 지워지지 않는 문제를 보게 된다. 남는 것은 아무도 안 가리키는 파일 하나다.
 */
export async function removeBlobs(paths: string[]): Promise<void> {
  const list = paths.filter((p) => typeof p === "string" && p.length > 0);
  if (list.length === 0) return;
  try {
    const res = await fetch("/api/blob", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: list }),
    });
    if (!res.ok) {
      // 여기가 실패하면 **아무도 안 가리키는 파일이 쌓인다**(고아 150장을
      // 만든 사고가 그것이었다). 지우기를 막지는 않되 이유는 남긴다.
      console.warn(`[blob] 삭제 실패(${res.status})`, await reason(res));
    }
  } catch (err) {
    console.warn("[blob] 삭제 요청 자체가 실패", err);
  }
}
