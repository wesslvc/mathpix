import { AwsClient } from "aws4fetch";

/**
 * Cloudflare R2 — 그림을 담는 곳.
 *
 * **왜 옮기나**(2026-09-17, 사용자 결정): 지금 구조의 근본 문제는 **Postgres 를
 * 파일 창고로 쓰는 것**이다. 그림이 base64 로 `box_range` 안에 들어가 있어서
 * ① base64 는 33% 부풀고 ② 가장 작은 할당량(무료 DB 500MB)을 먹고 ③ 조회할
 * 때마다 egress 로 나간다. 스토리지(1GB)와 egress(월 5GB)도 곧 따라 찬다.
 *
 * R2 는 **10GB 무료에 egress 요금이 아예 없다.** 그림이 여기로 오면 Supabase
 * 는 행(글자·메타데이터)만 들고 있으면 되고, 그러면 500MB 가 사실상 무한이
 * 된다(문제당 몇 백 바이트). 5GB/월 벽도 같이 사라진다.
 *
 * **키가 없으면 아무 일도 안 한다.** `r2Configured()` 가 false 면 부르는 쪽이
 * 예전처럼 Supabase Storage 를 쓴다 — 환경변수를 넣기 전까지 동작이 한 글자도
 * 안 바뀐다(Mathpix·Gemini 키가 없을 때 그 기능만 쉬는 것과 같은 방식이다).
 *
 * **서명은 손으로 안 짠다.** AWS SigV4 는 조용히 틀리는 종류의 코드라
 * 검증된 `aws4fetch`(10KB)에 맡긴다. 이 저장소가 "직접 그린다"를 여러 번
 * 택해 왔지만 그건 **틀렸는지 눈으로 보이는** 것들이었다(그래프·PDF 조판).
 * 서명은 틀리면 403 하나로 끝나서 어디가 틀렸는지 알 수 없다.
 *
 * **서버 전용이다.** 여기 있는 값이 브라우저로 새면 남의 그림을 다 읽을 수
 * 있다 — 그래서 환경변수에 `NEXT_PUBLIC_` 이 붙으면 안 되고, 이 파일을
 * 클라이언트 컴포넌트가 가져가서도 안 된다.
 */

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID ?? "";
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID ?? "";
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY ?? "";
const BUCKET = process.env.R2_BUCKET ?? "";

/** 넷이 다 있어야 켜진다. 하나라도 비면 예전 길(Supabase Storage)로 간다. */
export function r2Configured(): boolean {
  return Boolean(ACCOUNT_ID && ACCESS_KEY_ID && SECRET_ACCESS_KEY && BUCKET);
}

/** R2 는 지역이 하나다(`auto`). S3 API 라 서명에는 지역 이름이 필요하다. */
const REGION = "auto";

let client: AwsClient | null = null;
function aws(): AwsClient {
  if (!client) {
    client = new AwsClient({
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
      service: "s3",
      region: REGION,
    });
  }
  return client;
}

/**
 * 오브젝트 주소.
 *
 * 경로 조각마다 따로 인코딩한다 — 통째로 `encodeURIComponent` 하면 `/` 까지
 * `%2F` 가 되어 **폴더 구조가 사라진다**(경로 첫 조각이 사용자 id 라는 규칙이
 * 깨진다). 반대로 아무것도 안 하면 공백·한글이 든 이름에서 서명이 어긋난다.
 */
export function r2ObjectUrl(path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `https://${ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}/${encoded}`;
}

/** 없으면 `null`. 404 를 오류로 만들지 않는다 — 옛 그림은 아직 Supabase 에 있다. */
export async function r2Get(path: string): Promise<Response | null> {
  const res = await aws().fetch(r2ObjectUrl(path), { method: "GET" });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`R2 읽기 실패 (${res.status}) ${await res.text()}`);
  }
  return res;
}

/**
 * **`Content-Length` 를 우리가 직접 붙인다.**
 *
 * R2 는 S3 와 달리 PUT 에 길이를 반드시 요구하고, 없으면
 * `411 MissingContentLength` 로 거절한다(chunked 전송을 안 받는다). 런타임이
 * 알아서 붙여 주리라 기대하면 안 된다 — 로컬 Node 22 에서는 Uint8Array ·
 * ArrayBuffer · Blob 넷 다 붙었는데, **Vercel(Node 24)에서는 안 붙어서**
 * 카드 PNG 가 전부 411 로 떨어지고 있었다. 16바이트짜리 자체 점검만 통과해서
 * 프로브는 초록불인데 진짜 저장만 조용히 Supabase 로 내려갔다.
 *
 * `content-length` 는 aws4fetch 의 `UNSIGNABLE_HEADERS` 에 들어 있어서
 * **직접 붙여도 서명이 안 바뀐다** — 그래서 안전하다.
 */
export async function r2Put(
  path: string,
  body: ArrayBuffer | Uint8Array | Blob,
  contentType: string,
): Promise<void> {
  // 길이를 확실히 알 수 있는 모양으로 한 번 맞춘다(스트림이 되면 다시 411 이다).
  const bytes =
    body instanceof Uint8Array
      ? body
      : body instanceof ArrayBuffer
        ? new Uint8Array(body)
        : new Uint8Array(await body.arrayBuffer());

  const res = await aws().fetch(r2ObjectUrl(path), {
    method: "PUT",
    body: bytes as unknown as BodyInit,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.byteLength),
    },
  });
  if (!res.ok) {
    throw new Error(`R2 쓰기 실패 (${res.status}) ${await res.text()}`);
  }
}

/**
 * 지운다. **없는 것을 지워도 성공이다**(S3 규약) — 지우는 쪽에서 존재 확인을
 * 따로 하지 않아도 된다.
 *
 * 한 번에 여러 개를 지우는 S3 배치 삭제는 XML 본문에 Content-MD5 까지 붙여야
 * 해서, 우리 규모(한 번에 많아야 몇 개)에서는 하나씩 보내는 편이 단순하고
 * 틀릴 자리가 없다.
 */
export async function r2Delete(paths: string[]): Promise<void> {
  await Promise.all(
    paths.map(async (path) => {
      const res = await aws().fetch(r2ObjectUrl(path), { method: "DELETE" });
      // 404 도 성공으로 본다(이미 없으면 목적은 이룬 것이다).
      if (!res.ok && res.status !== 404) {
        throw new Error(`R2 삭제 실패 (${res.status}) ${await res.text()}`);
      }
    }),
  );
}

/**
 * 브라우저가 **직접** 올릴 수 있는 주소를 만든다.
 *
 * 우리 서버를 거쳐 올리면 **Vercel 요청 본문 4.5MB 제한**에 걸리고(지면 사진은
 * 그보다 크다) 같은 바이트가 두 번 흐른다. 서명된 주소를 주면 브라우저 →
 * R2 한 번으로 끝난다.
 *
 * 짧게 준다(기본 10분) — 이 주소를 가진 사람은 그동안 그 경로에 쓸 수 있다.
 */
export async function r2PresignPut(
  path: string,
  expiresInSeconds = 600,
): Promise<string> {
  const url = new URL(r2ObjectUrl(path));
  url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
  const signed = await aws().sign(url.toString(), {
    method: "PUT",
    aws: { signQuery: true },
  });
  return signed.url;
}
