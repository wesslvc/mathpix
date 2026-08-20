// 같은 자료를 두 번 보내지 않기 위한 캐시.
//
// 사과탐은 자료 하나에 문항이 2~3개 딸린 세트 문항이 흔하다. 같은 그림을
// 문제마다 다시 재구성하면 그때마다 돈이 나가므로, 한 번 그린 자료는 다시
// 그리지 않는다. 실수로 두 번 누르거나 네트워크 오류 뒤 재시도하는 경우에도
// 중복 과금을 막아준다.
//
// 브라우저 **localStorage**에 둔다. 한때 sessionStorage였는데 그러면 탭을 닫는
// 순간 캐시가 사라졌다 — 그런데 **재시도가 곧 재과금인 상황이 바로 그 자리다.**
// 생성이 오래 걸려 타임아웃이 나거나 오류가 난 뒤 사용자가 다시 들어와 누르면,
// 같은 크롭인데도 캐시가 비어 있어 유료 호출이 한 번 더 나갔다. 세션을 넘겨
// 살아 있어야 그 낭비가 없다.
//
// 서버나 DB에 두지 않는 이유: 결과 이미지 자체는 어차피 문제에 붙어 저장되고,
// 이 캐시는 같은 사람이 같은 크롭을 다시 보내는 것만 막으면 된다.

const STORAGE_KEY = "reprintocr.figureCache.v1";
/** 보관할 최대 개수. SVG 하나가 수십 KB라 너무 많이 들고 있지 않는다. */
const MAX_ENTRIES = 12;

type Entry = { key: string; svg: string };

function readAll(): Entry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Entry[]) : [];
  } catch {
    // 저장소를 못 읽는 환경(프라이빗 모드 등)에서도 기능은 그냥 돌아가야 한다.
    return [];
  }
}

function writeAll(entries: Entry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // 용량 초과 등으로 실패하면 캐시를 비우고 한 번만 더 시도한다.
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, 1)));
    } catch {
      // 그래도 안 되면 캐시 없이 동작한다(기능에는 지장 없음).
    }
  }
}

/** crypto.subtle을 못 쓰는 환경(비보안 컨텍스트)용 대체 해시. */
function fallbackHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 + c, 0x85ebca6b) ^ (h2 >>> 13);
  }
  return `f${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}${input.length}`;
}

/** 이미지 내용으로 캐시 키를 만든다. 같은 영역을 같게 잘랐으면 같은 키가 된다. */
export async function figureCacheKey(dataUrl: string): Promise<string> {
  if (!globalThis.crypto?.subtle) return fallbackHash(dataUrl);
  try {
    const bytes = new TextEncoder().encode(dataUrl);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .slice(0, 16)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return fallbackHash(dataUrl);
  }
}

export function readFigureCache(key: string): string | null {
  return readAll().find((e) => e.key === key)?.svg ?? null;
}

export function writeFigureCache(key: string, svg: string): void {
  const rest = readAll().filter((e) => e.key !== key);
  // 최신을 앞에 두고 오래된 것부터 버린다.
  writeAll([{ key, svg }, ...rest].slice(0, MAX_ENTRIES));
}
