// 평가원 PDF 조립을 **화면과 다른 스레드에서** 한다(2026-10-04, 사용자 — "약간 부하 걸리고 렉 걸리는 건 해결 어려움?").
// pdf-lib 은 PNG 를 넣을 때 풀었다가 다시 압축하고(embedPng), 저장할 때 또 압축한다 — 문제 100여 개면 몇 초에서 십수 초를
// 화면 스레드에서 쓰는 바람에 버튼·스크롤·진행 표시가 통째로 멈췄다. pdf.ts 는 DOM 을 안 쓰므로(fetch 만) 그대로 여기서 돈다.
import { buildKicePdf, type KiceSpec } from "./pdf";

type Post = { postMessage(message: unknown, transfer?: Transferable[]): void };

self.onmessage = async (e: MessageEvent<{ spec: Omit<KiceSpec, "onWarn"> }>) => {
  const warns: string[] = [];
  const post = (self as unknown as Post).postMessage.bind(self);
  try {
    const bytes = await buildKicePdf({ ...e.data.spec, onWarn: (m) => warns.push(m) });
    post({ ok: true, bytes, warns }, [bytes.buffer]);
  } catch (err) {
    post({ ok: false, error: err instanceof Error ? err.message : String(err), warns });
  }
};
