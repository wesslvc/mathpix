import type { SupabaseClient } from "@supabase/supabase-js";
import { putBlob } from "./blobClient";
import { cardUrl } from "./cardUrl";
import type { StoredFigure } from "./storedFigures";

/**
 * 저장 직전, 그림마다 인라인 base64(markup·origin)를 스토리지로 옮기고
 * 그 자리를 가리키는 마크업으로 바꾼다.
 *
 * **카드 원본(image_path)을 R2 로 옮긴 것과는 다른 문제다.** 그건 egress
 * (전송량)를 줄이는 것이었고, 이건 애초에 **저장 위치**(Postgres 무료 500MB)
 * 문제다 — `box_range.figures[].markup`/`.origin` 은 그림을 base64 로 그대로
 * jsonb 안에 담고 있어서, base64 가 33% 부풀리는 것까지 더해 DB 용량을
 * 가장 많이 먹는 자리였다(2026-09 실측: markup 75MB + origin 최대 123MB).
 * R2 로 egress 걱정이 없어졌다고 이 문제가 같이 없어지는 건 아니다.
 *
 * **껍데기를 `<img src="…">` 하나로 통일한다.** `rasterToSvg`가 만드는
 * `<svg><image href="data:…">`도 이 함수를 거치면 `<img>`가 된다. 일부러
 * 그렇게 했다 — `.problem-figure > svg, .problem-figure > img`가 둘 다
 * `width:100%; height:auto`로 맞추므로 겉보기는 같지만, `SVGImageElement`에는
 * `HTMLImageElement.complete` 같은 것이 없다. 캡처 직전에 "이 그림이 실제로
 * 로드됐는지"를 동기적으로 알 방법이 없으면(`layout.ts`의 `waitForImages`)
 * 이미 브라우저 캐시에 있는 그림에도 매번 로드 이벤트를 기다려야 해서, 캡처
 * 할 때마다 쓸데없이 몇 초씩 멈춘다.
 *
 * **이미 스토리지를 가리키고 있으면 손대지 않는다**(data: URI 가 없으면
 * 그대로 돌려준다). 그래서 그림을 안 건드리고 자리·글자만 고쳐 다시
 * 저장해도 중복으로 올라가지 않는다 — 이미 옮겨진 문제를 다시 저장할 때마다
 * 매번 새 사본이 쌓이면 옮기기 전보다 나빠진다.
 *
 * **실패하면 인라인 그대로 둔다.** 스토리지 업로드가 실패했다고 저장 자체를
 * 막으면 안 된다 — 그림을 잃는 것보다 DB 에 조금 더 남는 편이 낫다.
 */
export async function persistFigureBlobs(
  supabase: SupabaseClient,
  /** `<user id>/<category id>` — 카드 원본과 같은 폴더에 둔다. */
  dirPrefix: string,
  figures: StoredFigure[],
): Promise<StoredFigure[]> {
  return Promise.all(
    figures.map(async (f) => {
      // 표는 마크업을 저장하지 않는다(storedFigures.ts 참고) — 옮길 것이 없다.
      if (f.kind === "table") return f;
      const [markup, origin] = await Promise.all([
        persistFigureValue(supabase, dirPrefix, f.markup),
        persistFigureValue(supabase, dirPrefix, f.origin),
      ]);
      return { ...f, markup, origin };
    }),
  );
}

/**
 * `persistFigureBlobs`가 그림마다 하는 일을 값 하나에 대해서만 한다.
 *
 * **바뀐 그림 하나만 옮길 때 쓴다**(`FigureJobsProvider.resaveIfClosed`).
 * 배열 전체를 `persistFigureBlobs`에 넣으면 이미 옮겨진 다른 그림까지 다시
 * 훑는데, 거기서는 손댈 게 아니면 손대지 않는 게 맞다.
 */
export async function persistFigureValue(
  supabase: SupabaseClient,
  dirPrefix: string,
  value: string | undefined,
): Promise<string | undefined> {
  if (!value) return value;
  const m = value.match(/data:image\/([a-zA-Z0-9.+-]+);base64,[^"')\s]+/);
  if (!m) return value; // 이미 스토리지 주소를 가리키고 있다 — 손대지 않는다.

  const mimeRaw = m[1] === "jpg" ? "jpeg" : m[1];
  const ext = mimeRaw === "jpeg" ? "jpg" : mimeRaw === "svg+xml" ? "svg" : mimeRaw;
  try {
    const blob = await (await fetch(m[0])).blob();
    const path = `${dirPrefix}/figures/${crypto.randomUUID()}.${ext}`;
    const up = await putBlob(supabase, path, blob, `image/${mimeRaw}`);
    if (!up.ok) return value;
    return `<img src="${cardUrl(path)}" alt="" />`;
  } catch {
    return value; // 실패하면 인라인 그대로 — 그림을 잃는 것보다 낫다.
  }
}
