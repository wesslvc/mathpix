/**
 * 문제 카드(인식 결과 미리보기/수정 미리보기)의 고정 너비(px).
 * 화면 폭에 따라 반응형으로 줄바꿈이 달라지면 같은 문제를 폰/패드에서
 * 저장했을 때 오답프린트에 붙는 결과물의 줄바꿈이 달라져 버린다. 항상
 * 이 너비로 렌더링해 어떤 기기에서 저장하든 같은 모양이 나오게 한다.
 * 화면이 이보다 좁으면 가로 스크롤로 보게 한다(줄바꿈은 그대로 유지).
 */
export const PROBLEM_CARD_WIDTH = 640;

/**
 * 카드를 PNG로 캡처할 때 쓰는 공통 설정.
 *
 * **화면용 장식은 벗기고 찍는다.** 인식 결과 화면의 카드에는 둥근 모서리와
 * 회색 테두리, 옅은 그림자가 걸려 있는데 그건 "여기가 카드다"를 보여 주는
 * 화면 장치일 뿐이다. 그대로 캡처하면 그 테두리가 **저장된 이미지에 구워져**
 * 나중에 어떤 양식으로 인쇄하든 따라다닌다(평가원 문제지 양식에서는 실제
 * 문제지에 없는 네모가 문항마다 생긴다). `style` 은 html-to-image 가 복제한
 * 노드에만 적용하므로 화면은 그대로 둔 채 캡처만 깨끗해진다.
 *
 * **테두리를 없애지 않고 투명하게만 한다.** `border: none` 으로 지우면 좌우
 * 1px 씩이 본문 폭으로 돌아가 줄바꿈이 달라질 수 있다 — 이 카드의 폭을 못
 * 박아 둔 이유가 바로 그것(어느 기기에서 저장하든 같은 줄바꿈)이라, 보이지만
 * 않게 하고 자리는 그대로 둔다.
 */
export const CARD_CAPTURE_OPTIONS = {
  pixelRatio: 2,
  backgroundColor: "#ffffff",
  style: { borderColor: "transparent", boxShadow: "none" } as Partial<CSSStyleDeclaration>,
};

/**
 * 캡처 전에 카드 안의 `<img>` 가 전부 실제로 로드될 때까지 기다린다.
 *
 * **2026-09-17 이전에는 이게 필요 없었다.** 그림 마크업이 전부 `data:` URI로
 * 인라인돼 있어서 `<img>` 로드가 사실상 즉시(동기에 가깝게) 끝났다 — 그래서
 * `requestAnimationFrame` 한 틱만으로 충분했다. 그런데 그림을 스토리지로
 * 옮기면서(`figureBlob.ts`) 마크업이 `<img src="/api/card/...">` 같은 **네트워크
 * 주소**를 가리키게 됐다 — 저장된 문제를 열 때마다 실제로 그 그림을 내려받아야
 * 하므로, 못 기다리고 캡처하면 그 자리가 빈 채로 PNG 에 구워진다.
 *
 * 이미 로드됐거나(`complete`) 캐시로 즉시 끝나는 경우는 그냥 지나간다. 하나가
 * 실패해도(404 등) 캡처 자체를 막지는 않는다 — 빈 그림 하나보다 문제 전체를
 * 저장 못 하는 쪽이 더 나쁘다. 8초 안에 안 끝나면 그냥 진행한다(끊긴 네트워크
 * 때문에 저장이 영영 안 되는 것보다 낫다).
 */
export async function waitForImages(container: HTMLElement, timeoutMs = 8000): Promise<void> {
  const imgs = Array.from(container.querySelectorAll("img"));
  if (imgs.length === 0) return;
  const waits = imgs
    .filter((img) => !img.complete)
    .map(
      (img) =>
        new Promise<void>((resolve) => {
          img.addEventListener("load", () => resolve(), { once: true });
          img.addEventListener("error", () => resolve(), { once: true });
        }),
    );
  if (waits.length === 0) return;
  await Promise.race([
    Promise.all(waits),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
}
