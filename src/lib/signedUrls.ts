import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 서명 URL 을 **같은 주소로 재사용한다.**
 *
 * **왜 필요한가 (무료 요금제 egress 한도가 한 달 5GB 다).** 브라우저의 이미지
 * 캐시는 **주소(URL)로** 걸린다. 그런데 `createSignedUrls` 는 부를 때마다 새
 * 토큰이 박힌 **다른 주소**를 내주므로, 같은 그림인데도 브라우저가 매번 처음
 * 보는 파일로 여겨 **전부 다시 받는다.** 실모 화면에 들어갔다 나왔다 하거나
 * PDF 를 여러 번 뽑으면 그때마다 통째로 다시 나가는 것이다 — 사용자 계정에서
 * 하루 444MB(전체 egress 의 80%)가 Storage 에서 나가고 있었다.
 *
 * 서명해 둔 주소를 **잠깐 들고 있다가 그대로 다시 주면** 브라우저 캐시가
 * 비로소 일을 한다. 두 번째부터는 Supabase 로 요청 자체가 안 간다.
 *
 * **만료보다 넉넉히 일찍 버린다.** 캐시에 남은 주소를 만료 직전에 내주면
 * 사용자가 그 페이지를 보는 동안 그림이 깨진다. 서명은 6시간, 재사용은
 * 5시간까지만 한다.
 *
 * **왜 1시간에서 6시간으로 늘렸나.** 서명 URL 은 그 파일 하나에 대한
 * 열쇠라, 새어 나가면 그 시간만큼 열려 있다. 이 그림들은 사용자 본인의
 * 오답 사진이고, 늘어난 값(6시간)에 견줘 얻는 것(재방문·재출력 때 egress 가
 * 0)이 훨씬 크다고 봤다. 더 짧게 두면 캐시가 그만큼 덜 걸린다.
 *
 * **인스턴스마다 따로 산다**(서버리스라 그렇다). 그래서 적중률이 100%는
 * 아니지만, 한 사람이 이어서 쓰는 동안에는 대개 같은 인스턴스가 받는다 —
 * 안 걸려도 예전과 같을 뿐이라 손해는 없다.
 */

const TTL_SEC = 60 * 60 * 6;
const REUSE_MS = 1000 * 60 * 60 * 5;
/** 인스턴스 하나가 들고 있을 최대 개수. 넘으면 오래된 것부터 버린다. */
const MAX_ENTRIES = 2000;

const cache = new Map<string, { url: string; until: number }>();

function remember(key: string, url: string, until: number) {
  // Map 은 넣은 차례를 지키므로 맨 앞이 가장 오래된 것이다.
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { url, until });
}

/**
 * 경로들을 서명해 `경로 → 주소` 로 돌려준다. 이미 서명해 둔 것은 **같은
 * 주소**를 그대로 준다. 실패하거나 없는 파일은 그냥 빠진다(빈 map 이 될 수도
 * 있다) — 부르는 쪽이 없을 때를 이미 다루고 있다.
 */
export async function signCached(
  supabase: SupabaseClient,
  bucket: string,
  paths: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;

  const now = Date.now();
  const need: string[] = [];
  for (const path of paths) {
    const hit = cache.get(`${bucket}/${path}`);
    if (hit && hit.until > now) out.set(path, hit.url);
    else need.push(path);
  }
  if (need.length === 0) return out;

  const { data } = await supabase.storage
    .from(bucket)
    .createSignedUrls(need, TTL_SEC);
  for (const row of data ?? []) {
    if (!row.signedUrl || !row.path) continue;
    remember(`${bucket}/${row.path}`, row.signedUrl, now + REUSE_MS);
    out.set(row.path, row.signedUrl);
  }
  return out;
}
