// `buildKicePdf` 를 웹 워커에서 돌린다(`pdf.worker.ts`). 워커를 못 띄우거나 워커 스크립트가 안 뜨면 예전처럼 화면 스레드에서 돈다
// — 느려질 뿐 PDF 는 나온다. 워커 안에서 난 진짜 오류(글꼴 없음 등)는 그대로 던진다(두 번 돌려 봐야 같다).
import type { KiceSpec } from "./pdf";

type Reply = { ok: true; bytes: Uint8Array; warns: string[] } | { ok: false; error: string; warns: string[] };

export async function buildKicePdfOffThread(spec: KiceSpec): Promise<Uint8Array> {
  const { onWarn, ...data } = spec;
  const onMainThread = async () => (await import("./pdf")).buildKicePdf(spec);
  let worker: Worker;
  try {
    worker = new Worker(new URL("./pdf.worker.ts", import.meta.url));
  } catch {
    return onMainThread();
  }
  const reply = await new Promise<Reply | null>((resolve) => {
    worker.onmessage = (e: MessageEvent<Reply>) => resolve(e.data);
    // 스크립트를 못 받았거나 워커가 죽었다 — 화면 스레드로 넘긴다.
    worker.onerror = (e) => {
      e.preventDefault();
      resolve(null);
    };
    // 그림 바이트는 옮기지(transfer) 않고 복사한다 — 글꼴·틀 그림은 화면 쪽이 캐시해 다시 쓴다.
    worker.postMessage({ spec: data });
  }).finally(() => worker.terminate());
  if (!reply) return onMainThread();
  for (const w of reply.warns) onWarn?.(w);
  if (!reply.ok) throw new Error(reply.error);
  return reply.bytes;
}
