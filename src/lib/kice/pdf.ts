/**
 * 평가원 문제지 판형을 pdf-lib 로 직접 그린다.
 *
 * 틀(제목·머리말·성명칸·쪽번호 상자·단 구분선)은 원본 문제지를 렌더링해 뽑아 둔
 * 좌표를 그대로 재생하고(`frames.json`), 그 위에 오답 이미지를 단을 따라 흘려
 * 넣는다.
 *
 * **왜 hwpx 가 아니라 PDF 인가:** 처음에는 글꼴 때문에 한글 파일로 내보냈다.
 * 수능 문제지는 한컴 전용 글꼴(HFT)로 짜여 있어 웹에 심을 수 없기 때문이다.
 * 지금은 같은 이름의 TTF 를 손에 넣어(신그래픽체·견명조·태고딕·디나루·신중명조)
 * 우리가 직접 그린다 — 한글이 없어도 되고, PDF 로 뽑는 마지막 한 걸음을
 * 사용자가 하지 않아도 된다.
 */
import {
  PDFDocument,
  rgb,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
  rectangle,
  clip,
  endPath,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { Frame, FrameBox, FrameItem, FrameSet } from "./frames";
import type { RichBlock } from "./richText";
import {
  DEFAULT_FLOW_STYLE,
  flowBlocks,
  type FlowColumn,
  type FlowItem,
} from "./textFlow";

/** 용지·여백·단 (hwpx 의 secPr 에서 그대로 가져온 값, 단위 pt). */
export const LAYOUT = {
  pageWidth: 771.02,
  pageHeight: 1116.85,
  marginLeft: 53,
  columnWidth: 326.84,
  columnGap: 11.34,
  /** 본문 아래 끝(위에서 잰 거리). 단 구분선이 끝나는 자리와 같다. */
  contentBottom: 1023.21,
  /** 문제 사이 세로 간격. */
  gap: 14,
};

const columnX = (i: number) => LAYOUT.marginLeft + i * (LAYOUT.columnWidth + LAYOUT.columnGap);

const hex = (h: string | null) => {
  const n = parseInt((h || "#000000").slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

const inside = (box: FrameBox, x: number, y: number) =>
  x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;

/** 지워야 할 영역 안에 들어가는 항목인지. */
function dropped(it: FrameItem, drops?: FrameBox[]) {
  if (!drops?.length) return false;
  const pts: [number, number][] =
    it.k === "line"
      ? [
          [it.x1, it.y1],
          [it.x2, it.y2],
        ]
      : it.k === "circle"
        ? [[it.cx, it.cy]]
        : it.k === "rect" || it.k === "image"
          ? [
              [it.x, it.y],
              [it.x + it.w, it.y + it.h],
            ]
          : [[it.x, it.y]];
  return drops.some((b) => pts.every(([x, y]) => inside(b, x, y)));
}

type TextItem = Extract<FrameItem, { k: "text" }>;

/**
 * 같은 줄·같은 서식의 글자를 한 덩어리로 묶는다.
 *
 * 묶는 목적은 오직 **갈아끼울 글자를 찾기 위해서**다. 그리는 것은 글자
 * 하나하나를 원래 x 에 그대로 놓는다 — 합쳐서 한 번에 그리면 원본이 벌려 둔
 * 사이(예: `성명` 칸과 `수험 번호` 칸)가 뭉개져 글자가 겹친다.
 */
function groupLines(items: FrameItem[]) {
  type Line = {
    y: number;
    size: number;
    font: string;
    x: number;
    end: number;
    items: TextItem[];
    standalone?: boolean;
    text: string;
  };
  const lines: Line[] = [];
  for (const it of items) {
    if (it.k !== "text") continue;
    const line = it.standalone
      ? null
      : lines.find(
          (l) =>
            !l.standalone &&
            Math.abs(l.y - it.y) < 1.2 &&
            Math.abs(l.size - it.size) < 0.01 &&
            l.font === it.font,
        );
    const right = it.x + (it.len ?? it.size * it.sx);
    if (line) {
      line.items.push(it);
      line.end = Math.max(line.end, right);
      line.x = Math.min(line.x, it.x);
    } else {
      lines.push({
        y: it.y,
        size: it.size,
        font: it.font,
        x: it.x,
        end: right,
        items: [it],
        standalone: it.standalone,
        text: "",
      });
    }
  }
  for (const l of lines) l.text = l.items.map((i) => i.t).join("").replace(/\s+/g, "");
  return lines;
}

/** 둥근 네모. pdf-lib 에는 없어서 경로로 직접 그린다. */
function roundedRectPath(x: number, y: number, w: number, h: number, r: number) {
  const k = Math.min(r, w / 2, h / 2);
  return (
    `M ${x + k} ${y} H ${x + w - k} A ${k} ${k} 0 0 1 ${x + w} ${y + k} ` +
    `V ${y + h - k} A ${k} ${k} 0 0 1 ${x + w - k} ${y + h} H ${x + k} ` +
    `A ${k} ${k} 0 0 1 ${x} ${y + h - k} V ${y + k} A ${k} ${k} 0 0 1 ${x + k} ${y} Z`
  );
}

/**
 * 틀만 보고 **본문이 놓일 위아래 끝**을 알아낸다.
 *
 * 그리기 전에 알아야 한다 — 전체 쪽수를 쪽번호 상자에 찍으려면 몇 쪽이
 * 나오는지 먼저 세어야 하고, 세려면 한 쪽에 얼마가 들어가는지 알아야 한다.
 * 판단 기준은 그리는 쪽과 **같은 규칙**이어야 한다(어긋나면 쪽수가 틀린다).
 */
function frameBounds(frame: Frame) {
  let headerBottom = 0;
  let contentBottom = LAYOUT.contentBottom;
  for (const it of frame.items) {
    if (it.k !== "line" || dropped(it, frame.drop)) continue;
    // 폭을 거의 다 가로지르는 가로줄이 곧 머리말과 본문의 경계다.
    if (Math.abs(it.y1 - it.y2) < 0.5 && Math.abs(it.x2 - it.x1) > 400) {
      headerBottom = Math.max(headerBottom, it.y1);
    }
    // 단 구분선이 끝나는 자리가 본문의 아래 끝이다(과목마다 다르다).
    if (Math.abs(it.x1 - it.x2) < 0.5 && Math.abs(it.y2 - it.y1) > 300) {
      contentBottom = Math.max(it.y1, it.y2);
    }
  }
  return { headerBottom, contentBottom };
}

const frameFor = (frames: FrameSet, pageNo: number) =>
  pageNo === 1 ? frames.first : pageNo % 2 === 0 ? frames.even : frames.odd;

/** 문제마다 위에 붙는 출처 표기. 작게 — 문제지 흉내를 방해하면 안 된다. */
const LABEL_SIZE = 8.5;
const LABEL_GAP = 3;
const LABEL_FONT = "(한)신중명조";

type Placed = {
  img: PDFImage;
  label: string;
  x: number;
  /** 그림 위 끝(위에서 잰 거리). 표기는 이 위에 놓인다. */
  y: number;
  w: number;
  h: number;
  /**
   * 이 네모 안만 보이게 자른다(위에서 잰 좌표).
   *
   * 지문을 두 단에 나눠 흘려 넣을 때 쓴다 — 같은 그림을 두 번 그리되 한 번은
   * 위쪽 띠만, 한 번은 아래쪽 띠만 보이게 한다. 그림을 실제로 자르지 않으므로
   * 다시 인코딩할 필요가 없다.
   */
  clip?: { x: number; y: number; w: number; h: number };
};

type Shot = { img: PDFImage; label: string };

/**
 * 한 단을 채운다. **넣기로 한 개수는 반드시 다 넣는다.**
 *
 * 남는 자리는 문제 사이에 고르게 나눠 준다(실제 문제지도 단을 꽉 채운다).
 * 모자라면 그림을 줄여서 넣는다 — 다음 쪽으로 미루면 쪽마다 정해 둔 문항 수가
 * 무너진다.
 */
function fitColumn(items: Shot[], x: number, top: number, bottom: number): Placed[] {
  if (!items.length) return [];
  const heads = items.map((it) => (it.label ? LABEL_SIZE + LABEL_GAP : 0));
  const base = items.map((it) => Math.min(LAYOUT.columnWidth / it.img.width, 1));
  let hs = items.map((it, n) => it.img.height * base[n]);

  const avail = bottom - top;
  const headSum = heads.reduce((a, b) => a + b, 0);
  const gaps = items.length - 1;
  const sum = () => hs.reduce((a, b) => a + b, 0);

  let k = 1;
  if (headSum + sum() + LAYOUT.gap * gaps > avail) {
    k = Math.max((avail - LAYOUT.gap * gaps - headSum) / sum(), 0.1);
    hs = hs.map((h) => h * k);
  }
  const gap = gaps > 0 ? Math.max((avail - headSum - sum()) / gaps, LAYOUT.gap) : 0;

  const out: Placed[] = [];
  let y = top;
  items.forEach((it, n) => {
    out.push({
      img: it.img,
      label: it.label,
      x,
      y: y + heads[n],
      w: it.img.width * base[n] * k,
      h: hs[n],
    });
    y += heads[n] + hs[n] + gap;
  });
  return out;
}

/**
 * **쪽마다 몇 문제**를 넣을지 정해 두고 그대로 짠다.
 *
 * 실제 탐구 문제지가 4·6·6·4 로 짜여 있어서, 흘러가는 대로 두면 아무리
 * 판형이 같아도 문제지처럼 보이지 않는다. `pattern` 은 쪽 순서대로 읽고
 * 모자라면 처음으로 돌아가 되풀이한다.
 *
 * 그리기 전에 한 번 짜 보는 이유는 전체 쪽수 때문이다 — 쪽번호 상자의 사선
 * 아래에 전체 쪽수가 찍히는데, 그 값은 마지막 쪽까지 짜 봐야 안다.
 */
function layoutPages(images: Shot[], frames: FrameSet, pattern: number[]) {
  // 문제가 하나도 없으면 쪽도 없다. `do...while` 이라 빈 쪽 하나가 생기는데,
  // 정답표만 뽑을 때(문제 없이) 그 빈 쪽이 표지 자리를 차지해 버린다.
  if (images.length === 0) return [];
  const groups: Shot[][] = [];
  let at = 0;
  do {
    const want = pattern[groups.length % pattern.length];
    groups.push(images.slice(at, at + want));
    at += want;
  } while (at < images.length);
  return layoutGroups(groups, frames);
}

/** 쪽마다 무엇을 넣을지 이미 정해졌을 때, 그것들을 단에 앉힌다. */
function layoutGroups(groups: Shot[][], frames: FrameSet, firstPage = 1) {
  return groups.map((take, n) => layoutOnePage(take, frames, firstPage + n));
}

/**
 * 한 쪽을 짠다. **쪽 번호를 받아야 한다** — 표지 틀과 본문 틀은 머리말
 * 아래 가로줄 높이가 다르다(168.65 vs 99.2). 0번째 쪽으로 가정하면 본문
 * 쪽인데도 표지 기준으로 짜여 위가 통째로 빈다.
 */
function layoutOnePage(take: Shot[], frames: FrameSet, pageNo: number) {
  const b = frameBounds(frameFor(frames, pageNo));
  const top = b.headerBottom + LAYOUT.gap;
  // 왼쪽 단부터 채운다. 홀수면 왼쪽이 하나 더 갖는다.
  const half = Math.ceil(take.length / 2);
  return {
    items: [
      ...fitColumn(take.slice(0, half), columnX(0), top, b.contentBottom),
      ...fitColumn(take.slice(half), columnX(1), top, b.contentBottom),
    ],
  };
}

/**
 * 지문 한 장을 **쪽 전체**에 앉힌다(단으로 나누지 않는다).
 *
 * 국어 지문은 세로로 길어 한 단에 넣으면 옆이 통째로 빈다. 쪽 전체를 쓰게
 * 두면 비율에 따라 알아서 자리를 잡는다 — 세로로 긴 지문은 결국 한 단 폭쯤
 * 이 되고, 넓은 지문은 두 단을 다 쓴다. 가운데로 모은다.
 */
function layoutPassage(
  shot: Shot,
  frames: FrameSet,
  pageNo: number,
  splitAt?: number,
): { items: Placed[] } {
  const b = frameBounds(frameFor(frames, pageNo));
  const top = b.headerBottom + LAYOUT.gap;
  const colW = LAYOUT.columnWidth;
  const colH = b.contentBottom - top;

  // **단 폭에 맞춰 놓는다.** 쪽 전체에 맞춰 줄이면 세로로 긴 지문이 가운데
  // 좁은 띠가 되어 글자가 작아진다 — 실제 문제지처럼 단을 따라 흘려야 한다.
  if (splitAt == null || splitAt <= 0 || splitAt >= 1) {
    // 좌단만으로 충분하면 좌단에 몰아넣는다. 넘치면(계획이 안 왔으면) 줄인다.
    const k = Math.min(colW / shot.img.width, colH / shot.img.height);
    return {
      items: [
        {
          img: shot.img,
          label: shot.label,
          x: columnX(0),
          y: top,
          w: shot.img.width * k,
          h: shot.img.height * k,
        },
      ],
    };
  }

  // 두 단에 나눠 흘린다. **두 띠의 배율이 같아야 한다** — 다르면 왼쪽과
  // 오른쪽의 글자 크기가 달라져 한 지문으로 안 보인다.
  const k = Math.min(
    colW / shot.img.width,
    colH / (shot.img.height * splitAt),
    colH / (shot.img.height * (1 - splitAt)),
  );
  const w = shot.img.width * k;
  const full = shot.img.height * k;
  const upper = full * splitAt;
  return {
    items: [
      {
        img: shot.img,
        label: shot.label,
        x: columnX(0),
        y: top,
        w,
        h: full,
        clip: { x: columnX(0), y: top, w, h: upper },
      },
      {
        // 아래 띠는 그림을 위로 밀어 올려 그 부분이 단 안에 오게 한다.
        img: shot.img,
        label: "",
        x: columnX(1),
        y: top - upper,
        w,
        h: full,
        clip: { x: columnX(1), y: top, w, h: full - upper },
      },
    ],
  };
}

export type KiceSpec = {
  frames: FrameSet;
  /** 틀에 적힌 글자 → 바꿔 넣을 글자(빈 문자열이면 지운다). 공백은 무시하고 찾는다. */
  replace: Record<string, string>;
  /** 글꼴 이름 → TTF 바이트. 저작권 때문에 저장소가 아니라 따로 받아 온다. */
  fonts: Record<string, Uint8Array>;
  /** 틀이 쓰는 그림(교시 딱지) 이름 → PNG 바이트. */
  images: Record<string, Uint8Array>;
  /** `label` 은 문제 위에 작게 찍히는 출처 표기(빈 문자열이면 찍지 않는다). */
  problems: { png: Uint8Array; label?: string }[];
  /** 쪽마다 넣을 문제 수. 쪽 순서대로 읽고 모자라면 되풀이한다(예: `[4,6,6,4]`). */
  pagePattern: number[];
  /**
   * **국어 배치.** 있으면 `pagePattern` 대신 이 계획대로 쪽을 짠다.
   *
   * 국어는 지문 하나에 문항 여러 개가 딸려서, 흘려 넣으면 지문과 문제가 다른
   * 쪽으로 갈라져 책을 앞뒤로 넘겨야 한다. 그래서 **짝수 쪽에 지문, 홀수 쪽에
   * 그 문제들**을 놓아 펼쳤을 때 나란히 보이게 한다(사용자 요청).
   * 첫 장은 표지 틀이고 본문 자리가 비어 있어서 거기에 목차를 적는다.
   *
   * 계획을 여기서 짜지 않고 받는 이유는, 쪽 번호가 목차에 그대로 적히기
   * 때문이다 — 목차를 만드는 쪽과 쪽을 짜는 쪽이 다르면 반드시 어긋난다.
   */
  koreanPlan?: {
    /** 첫 장에 적을 줄들(예: `2~3p, 이감 5-6, 이중차분법`). */
    toc: string[];
    pages: (
      | { kind: "toc" }
      /**
       * **글자로 된 지문.** 사진이 아니라 우리가 평가원 글꼴로 조판한다 —
       * 확대해도 또렷하고, 단을 따라 흐르고, 상자가 단을 넘어가면 잘린다.
       */
      | { kind: "passageText"; blocks: RichBlock[] }
      | {
          kind: "passage";
          index: number;
          /**
           * 두 단에 나눠 흘릴 때의 **가르는 자리**(그림 높이의 0~1).
           * 없으면 좌단에만 놓는다(좌단만으로 충분한 지문).
           */
          splitAt?: number;
        }
      | { kind: "questions"; indexes: number[] }
    )[];
  };
  /**
   * 마지막에 붙일 **정답표**. 비어 있으면 붙이지 않는다.
   *
   * 실제 문제지에는 없는 쪽이지만, 이건 문제지가 아니라 **오답프린트**다 —
   * 풀고 나서 맞춰 볼 답이 없으면 쓸모가 반이다. 그래서 맨 뒤에 한 쪽 붙인다.
   */
  answers?: { label: string; answer: string }[];
  /**
   * 정답표 쪽의 쪽번호를 **직접 정한다**(정답표 생성기 전용).
   *
   * 보통은 문제 쪽 뒤에 붙으므로 쪽번호가 저절로 정해진다. 그런데 문제 없이
   * 정답표만 뽑으면 그게 1쪽이 되어 **표지 틀** 위에 그려진다 — 제목 표와
   * 성명 칸이 함께 나온다. 정답표만 따로 뽑을 때 원하는 것은 본문 쪽 모양
   * 이므로, 쪽번호를 2 이상으로 주어 본문 틀(even/odd)을 쓰게 한다.
   */
  answerPage?: { no: number; total: number };
  /**
   * 그리다 생긴 문제를 알린다(글꼴에 없는 글자 등). 던지지 않는 이유는
   * **나머지는 멀쩡히 나오기 때문**이다 — PDF 는 주되 무엇이 어긋났는지
   * 화면에 적어 준다.
   */
  onWarn?: (message: string) => void;
};

export async function buildKicePdf(spec: KiceSpec): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);

  /**
   * 글꼴은 **미리 잘라 둔 것**(pyftsubset)을 `subset: false` 로 통째로 넣는다.
   * pdf-lib(fontkit)의 서브셋터에 맡기면 **글자가 대부분 빈칸으로 찍히는데
   * 오류는 나지 않는다** — 그 증상 때문에 한참 헤맸다.
   */
  const fallback = Object.keys(spec.fonts)[0];
  const fontCache = new Map<string, PDFFont>();
  const fontFor = async (name: string) => {
    const key = spec.fonts[name] ? name : fallback;
    let font = fontCache.get(key);
    if (!font) {
      font = await pdf.embedFont(spec.fonts[key], { subset: false });
      fontCache.set(key, font);
    }
    return font;
  };

  /**
   * **글꼴에 없는 글자를 ⊠ 로 찍지 않는다.**
   *
   * 버킷에 올려 둔 글꼴은 **미리 잘라 둔 것**(pyftsubset)이라 모든 한글이
   * 들어 있지 않다. 그래서 틀에 새 글자가 생기면 그 자리가 통째로 네모로
   * 찍힌다 — 국어 틀을 만들자 머리말이 `국⊠ 영역` 이 되었다(신그래픽체에
   * '국' 은 과목명 "한국지리" 때문에 들어 있었지만 '어' 는 어디에도 쓰이지
   * 않아 빠져 있었다).
   *
   * 그리기 직전에 글꼴이 그 글자를 가졌는지 보고, 없으면 **가진 글꼴로
   * 갈아탄다**(서체는 달라지지만 네모보다 낫다). 아무 글꼴에도 없으면 그
   * 글자를 빼고 그린 뒤 무엇이 없었는지 알린다 — 조용히 네모를 찍으면
   * 왜 깨졌는지 알 길이 없다.
   */
  const coverage = new Map<string, Set<number>>();
  const coverageOf = async (name: string) => {
    const key = spec.fonts[name] ? name : fallback;
    let set = coverage.get(key);
    if (!set) {
      set = new Set((await fontFor(key)).getCharacterSet());
      coverage.set(key, set);
    }
    return set;
  };

  const missing = new Set<string>();
  const swappedFont = new Set<string>();

  /** 이 글자를 실제로 그릴 수 있는 글꼴과, 그릴 수 있는 글자만 남긴 문자열. */
  const fontForText = async (name: string, text: string) => {
    const chars = [...text].filter((c) => c.trim());
    const covers = async (n: string) => {
      const set = await coverageOf(n);
      return chars.every((c) => set.has(c.codePointAt(0)!));
    };
    if (chars.length === 0 || (await covers(name))) {
      return { font: await fontFor(name), text };
    }
    for (const other of Object.keys(spec.fonts)) {
      if (other === name || !(await covers(other))) continue;
      swappedFont.add(text);
      return { font: await fontFor(other), text };
    }
    const set = await coverageOf(name);
    const keep = (c: string) => !c.trim() || set.has(c.codePointAt(0)!);
    for (const c of chars) if (!keep(c)) missing.add(c);
    return { font: await fontFor(name), text: [...text].filter(keep).join("") };
  };

  const imageCache = new Map<string, PDFImage>();
  const imageFor = async (file: string) => {
    let img = imageCache.get(file);
    if (!img) {
      img = await pdf.embedPng(spec.images[file]);
      imageCache.set(file, img);
    }
    return img;
  };

  const flip = (y: number) => LAYOUT.pageHeight - y;

  type Draw = { text: string; x: number; alignRight?: number };

  const drawFrame = async (
    page: PDFPage,
    frame: Frame,
    nums: { pageNo: number; total: number },
  ) => {
    const items = frame.items.filter((i) => !dropped(i, frame.drop));

    const drawText = async (text: string, o: TextItem, at: Draw) => {
      // 공백은 그리지 않는다. 글자마다 자리를 따로 잡으므로 공백은 아무 일도
      // 하지 않는데, 원본이 전각 공백(U+3000)을 쓰는 자리가 있어서 그대로
      // 그리면 글꼴에 없는 글자라 **네모(⊠)가 찍힌다**(머리말에서 실제로 났다).
      if (!text || !text.trim()) return;
      const picked = await fontForText(o.font, text);
      const font = picked.font;
      text = picked.text;
      if (!text.trim()) return;
      const sx = o.sx ?? 1;
      const x =
        at.alignRight === undefined
          ? at.x
          : at.alignRight - font.widthOfTextAtSize(text, o.size) * sx;
      // **원본이 적어 둔 글자 폭(textLength)은 쓰지 않는다.** 그 값은 원본
      // 문서의 한컴 전용 글꼴 메트릭으로 계산된 것이라, 우리가 바꿔 넣은
      // TTF 에 강제로 맞추면 글자마다 눌린 정도가 달라진다 — `제 4 교시` 에서
      // 숫자만 15% 넓게 늘어나 혼자 커 보였다. 장평(sx)만 쓰면 모든 글자가
      // 같은 비율이 되고, 글자 자리는 어차피 원본 x 를 그대로 쓴다.
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(sx, 0, 0, 1, x, 0));
      page.drawText(text, { x: 0, y: flip(o.y), size: o.size, font, color: hex(o.fill) });
      page.pushOperators(popGraphicsState());
    };

    // 글자 항목마다 무엇을 어디에 그릴지 미리 정해 둔다. 갈아끼우는 판단은
    // 줄 단위라서 먼저 해야 하지만, 실제로 그리는 건 **문서 순서**여야 한다.
    const plan = new Map<TextItem, Draw | null>();

    // 쪽번호와 전체 쪽수는 **글자로 짝지어 찾지 않는다.** 값이 쪽마다 달라져서
    // 문자열로 맞추려 들면 반드시 어긋난다(2쪽의 `2` 와 전체 쪽수 `20` 을
    // 글자로 구분할 방법이 없다). 틀에 붙여 둔 `role` 로 찾는다.
    for (const it of items) {
      if (it.k !== "text" || !it.role) continue;
      const group = items.filter(
        (o): o is TextItem =>
          o.k === "text" &&
          o.role === it.role &&
          Math.abs(o.y - it.y) < 1.2 &&
          Math.abs(o.size - it.size) < 0.01,
      );
      if (group[0] !== it) continue; // 무리마다 한 번만
      for (const o of group) plan.set(o, null);
      // 여러 자리 숫자는 조각으로 흩어져 있다. 왼쪽 끝에서 한 덩어리로 그린다.
      const head = group.reduce((a, b) => (a.x <= b.x ? a : b));
      plan.set(head, {
        text: String(it.role === "pageTotal" ? nums.total : nums.pageNo),
        x: head.x,
        alignRight: it.alignRight,
      });
    }

    for (const line of groupLines(items.filter((i) => !(i.k === "text" && i.role)))) {
      const swap = spec.replace[line.text];
      if (swap === undefined) {
        for (const it of line.items) plan.set(it, { text: it.t, x: it.x });
        continue;
      }
      if (!swap) {
        for (const it of line.items) plan.set(it, null);
        continue;
      }
      const bare = swap.replace(/\s+/g, "");
      // 괄호 안 과목명은 글자 수가 같아도 **한 덩어리로** 그린다. 자리마다
      // 한 자씩 끼우면 `(사회·문화)` 의 가운뎃점 자리에 로마숫자 Ⅰ 같은
      // 가는 글자가 들어가면서 앞뒤가 휑하게 벌어진다.
      if (bare.length === line.text.length && !swap.startsWith("(")) {
        // **글자 수가 같으면 자리마다 한 자씩 갈아끼운다.**
        // `사회탐구 영역` → `과학탐구 영역` 처럼 길이가 같은 경우가 흔한데,
        // 이때 한 덩어리로 다시 그려 가운데 맞추면 원본이 잡아 둔 글자 자리를
        // 통째로 벗어난다 — 실제로 영역명이 눈에 띄게 어긋났다.
        let i = 0;
        for (const it of line.items) {
          const n = it.t.replace(/\s+/g, "").length;
          plan.set(it, n ? { text: bare.slice(i, i + n), x: it.x } : null);
          i += n;
        }
        continue;
      }
      // 길이가 다르면 어쩔 수 없이 한 덩어리로 그린다. 제목은 원래 자리의
      // 가운데를 지키고, 괄호 안 과목명은 원래 시작점에 왼쪽을 맞춘다
      // (영역명 바로 뒤에 붙어야 하므로 가운데로 옮기면 사이가 벌어진다).
      const font = await fontFor(line.font);
      const width = font.widthOfTextAtSize(swap, line.size) * line.items[0].sx;
      const centered = !swap.startsWith("(");
      line.items.forEach((it, i) => {
        plan.set(
          it,
          i === 0
            ? { text: swap, x: centered ? (line.x + line.end) / 2 - width / 2 : line.x }
            : null,
        );
      });
    }

    for (const it of items) {
      if (it.k === "rect") {
        if (it.rx > 0) {
          // 둥근 모서리. `drawSvgPath` 는 좌표를 **SVG 처럼 위에서 아래로**
          // 읽으므로 미리 뒤집어 넘기면 두 번 뒤집혀 종이 밖으로 나간다.
          page.drawSvgPath(roundedRectPath(it.x, it.y, it.w, it.h, it.rx), {
            x: 0,
            y: LAYOUT.pageHeight,
            borderColor: it.stroke ? hex(it.stroke) : undefined,
            borderWidth: it.stroke ? it.sw || 0.75 : undefined,
            color: it.fill ? hex(it.fill) : undefined,
          });
        } else {
          page.drawRectangle({
            x: it.x,
            y: flip(it.y + it.h),
            width: it.w,
            height: it.h,
            color: it.fill ? hex(it.fill) : undefined,
            borderColor: it.stroke ? hex(it.stroke) : undefined,
            borderWidth: it.stroke ? it.sw || 0.5 : undefined,
          });
        }
      } else if (it.k === "line") {
        page.drawLine({
          start: { x: it.x1, y: flip(it.y1) },
          end: { x: it.x2, y: flip(it.y2) },
          thickness: it.sw || 0.5,
          color: hex(it.stroke),
          dashArray: it.dash
            ? it.dash.split(/[\s,]+/).map(Number).filter((n) => n > 0)
            : undefined,
        });
      } else if (it.k === "circle") {
        page.drawCircle({ x: it.cx, y: flip(it.cy), size: it.r, color: hex(it.fill) });
      } else if (it.k === "image") {
        page.drawImage(await imageFor(it.file), {
          x: it.x,
          y: flip(it.y + it.h),
          width: it.w,
          height: it.h,
        });
      } else {
        const how = plan.get(it);
        if (how) await drawText(how.text, it, how);
      }
    }
  };

  // ── 쪽을 짜 두고, 그 결과를 보고 그린다 ─────────────────────────────
  const images: { img: PDFImage; label: string }[] = [];
  for (const p of spec.problems) {
    images.push({ img: await pdf.embedPng(p.png), label: p.label ?? "" });
  }

  const pattern = spec.pagePattern.filter((n) => n > 0);
  const plan = spec.koreanPlan;
  // 국어는 쪽마다 무엇이 들어갈지 이미 정해져 있다(짝수 지문 / 홀수 문제).
  const pages = plan
    ? plan.pages.map((p, n) =>
        p.kind === "toc" || p.kind === "passageText"
          ? { items: [] as Placed[] }
          : p.kind === "passage"
            ? layoutPassage(images[p.index], spec.frames, n + 1, p.splitAt)
            : layoutOnePage(
                p.indexes.map((i) => images[i]),
                spec.frames,
                n + 1,
              ),
      )
    : layoutPages(images, spec.frames, pattern.length ? pattern : [4]);
  const answers = (spec.answers ?? []).filter((a) => a.answer.trim() !== "");
  // 정답표도 한 쪽을 차지하므로 전체 쪽수에 넣는다(쪽번호 상자에 찍힌다).
  const total = pages.length + (answers.length > 0 ? 1 : 0);

  for (let n = 0; n < pages.length; n++) {
    const page = pdf.addPage([LAYOUT.pageWidth, LAYOUT.pageHeight]);
    await drawFrame(page, frameFor(spec.frames, n + 1), { pageNo: n + 1, total });
    for (const it of pages[n].items) {
      if (it.label) {
        // 출처 표기는 사용자가 적은 실모 제목이라 글꼴에 없는 글자가 섞일 수
        // 있다(잘라 둔 글꼴이다). 틀 글자와 같은 길을 태운다.
        const label = await fontForText(LABEL_FONT, it.label);
        if (label.text.trim()) {
          page.drawText(label.text, {
            x: it.x,
            y: flip(it.y - LABEL_GAP),
            size: LABEL_SIZE,
            font: label.font,
            color: rgb(0.35, 0.35, 0.35),
          });
        }
      }
      // 자를 자리가 있으면 그 네모 안만 보이게 한다(지문 두 단 흘리기).
      if (it.clip) {
        page.pushOperators(
          pushGraphicsState(),
          rectangle(it.clip.x, flip(it.clip.y + it.clip.h), it.clip.w, it.clip.h),
          clip(),
          endPath(),
        );
      }
      page.drawImage(it.img, { x: it.x, y: flip(it.y + it.h), width: it.w, height: it.h });
      if (it.clip) page.pushOperators(popGraphicsState());
    }
    const planned = plan?.pages[n];
    if (planned?.kind === "toc") {
      await drawToc(page, frameFor(spec.frames, n + 1), plan!.toc, fontForText, flip);
    }
    if (planned?.kind === "passageText") {
      // 두 단에 흘려 넣는다. 남는 것이 있어도 이 쪽에서 끊는다 — 국어 계획은
      // 세트마다 쪽을 정해 두므로(짝수 지문 / 홀수 문제) 여기서 쪽을 더
      // 만들면 그 규칙이 무너진다. 넘칠 만큼 긴 지문은 계획을 짜는 쪽이
      // 두 쪽으로 나눠 준다.
      const b = frameBounds(frameFor(spec.frames, n + 1));
      const cols: FlowColumn[] = [0, 1].map((i) => ({
        x: columnX(i),
        top: b.headerBottom + LAYOUT.gap,
        bottom: b.contentBottom,
        width: LAYOUT.columnWidth,
      }));
      const body = await fontForText(BODY_FONT, "");
      const measure = (t: string, size: number, bold: boolean) =>
        body.font.widthOfTextAtSize(t, size) * (bold ? 1.02 : 1);
      const flowed = flowBlocks(planned.blocks, cols, measure, DEFAULT_FLOW_STYLE);
      for (const r of flowed.results) {
        await drawFlow(page, r.items, fontForText, flip, new Map());
      }
      if (flowed.rest.length > 0 && spec.onWarn) {
        spec.onWarn("지문이 한 쪽에 다 들어가지 않아 뒷부분이 잘렸습니다.");
      }
    }
  }

  if (answers.length > 0) {
    // 정답표만 따로 뽑을 때만 쪽번호를 직접 받는다(그때는 자동값이 1이라
    // 표지 틀에 그려진다). 문제와 함께 내보낼 때는 예전 그대로다.
    const pageNo = spec.answerPage?.no ?? total;
    const shownTotal = spec.answerPage?.total ?? total;
    const page = pdf.addPage([LAYOUT.pageWidth, LAYOUT.pageHeight]);
    const frame = frameFor(spec.frames, pageNo);
    // 정답표 쪽에는 **단 구분선을 긋지 않는다.** 표를 세로로 관통해 버린다.
    // 머리말·쪽번호는 그대로 둬서 앞쪽들과 한 묶음으로 보이게 한다.
    const bare: Frame = {
      ...frame,
      items: frame.items.filter(
        (i) =>
          !(i.k === "line" && Math.abs(i.x1 - i.x2) < 0.5 && Math.abs(i.y2 - i.y1) > 300),
      ),
    };
    await drawFrame(page, bare, { pageNo, total: shownTotal });
    // 본문 위아래 끝은 **원래 틀**에서 잰다(구분선을 뺀 틀에는 아래 끝이 없다).
    await drawAnswers(page, frame, answers, fontForText, flip);
  }

  if (spec.onWarn && (missing.size > 0 || swappedFont.size > 0)) {
    if (swappedFont.size > 0) {
      spec.onWarn(
        `글꼴에 없는 글자가 있어 다른 서체로 그렸습니다: ${[...swappedFont].join(", ")}`,
      );
    }
    if (missing.size > 0) {
      spec.onWarn(
        `어느 글꼴에도 없어 빼고 그린 글자: ${[...missing].join(" ")} ` +
          `— scripts/upload-kice-fonts.mjs 로 글자표를 넓혀 다시 올려야 합니다.`,
      );
    }
  }

  return pdf.save();
}

/** 본문 글꼴. 실제 수능 문제지의 지문·문항이 이 계열이다. */
const BODY_FONT = "(한)신중명조";

/**
 * 조판된 지문을 그린다.
 *
 * **굵게는 글꼴을 바꾸지 않고 두 번 그려 흉내 낸다.** 버킷에 굵은 짝이 있는
 * 글꼴이 없고, 있더라도 잘라 둔 글꼴이라 글자가 빌 위험이 크다 — 아주 조금
 * 어긋나게 두 번 그리면 획이 두꺼워진다.
 *
 * **밑줄은 직접 긋는다.** `밑줄 친 ㉠` 처럼 문제가 가리키는 자리라 빠지면
 * 문제가 성립하지 않는다.
 */
async function drawFlow(
  page: PDFPage,
  items: FlowItem[],
  fontForText: (name: string, text: string) => Promise<{ font: PDFFont; text: string }>,
  flip: (y: number) => number,
  figures: Map<string, PDFImage>,
) {
  for (const it of items) {
    if (it.kind === "boxEdge") {
      const x0 = it.x;
      const x1 = it.x + it.w;
      const y0 = it.y;
      const y1 = it.y + it.h;
      const line = (ax: number, ay: number, bx: number, by: number) =>
        page.drawLine({
          start: { x: ax, y: flip(ay) },
          end: { x: bx, y: flip(by) },
          thickness: 0.7,
          color: rgb(0, 0, 0),
        });
      // 단을 넘어간 도막은 그쪽 테두리를 긋지 않는다 — 잘린 것처럼 보여야 한다.
      if (it.top) line(x0, y0, x1, y0);
      if (it.bottom) line(x0, y1, x1, y1);
      line(x0, y0, x0, y1);
      line(x1, y0, x1, y1);
      continue;
    }
    if (it.kind === "figure") {
      const img = figures.get(it.id);
      if (img) {
        page.drawImage(img, { x: it.x, y: flip(it.y + it.h), width: it.w, height: it.h });
      }
      continue;
    }
    for (const piece of it.pieces) {
      const picked = await fontForText(BODY_FONT, piece.t);
      if (!picked.text.trim()) continue;
      const x = it.x + piece.dx;
      // 글자 줄은 칸 위에서 크기만큼 내려온 자리다.
      const baseline = flip(it.y + it.size);
      page.drawText(picked.text, {
        x,
        y: baseline,
        size: it.size,
        font: picked.font,
        color: rgb(0, 0, 0),
      });
      if (piece.b) {
        // 굵게 흉내 — 아주 조금 어긋나게 한 번 더.
        page.drawText(picked.text, {
          x: x + it.size * 0.035,
          y: baseline,
          size: it.size,
          font: picked.font,
          color: rgb(0, 0, 0),
        });
      }
      if (piece.u) {
        page.drawLine({
          start: { x, y: baseline - it.size * 0.16 },
          end: { x: x + piece.w, y: baseline - it.size * 0.16 },
          thickness: 0.6,
          color: rgb(0, 0, 0),
        });
      }
    }
  }
}

/**
 * 첫 장 빈 단에 목차를 적는다(국어 전용).
 *
 * 표지 틀은 제목 표 아래가 통째로 비어 있다. 국어는 세트마다 두 쪽을 쓰므로
 * "몇 쪽에 무슨 지문이 있는지"가 없으면 두꺼운 묶음에서 찾을 수가 없다.
 * 실제 문제지에는 없는 쪽이지만, 이건 문제지가 아니라 오답프린트다.
 *
 * 줄이 많으면 두 단으로 나눈다 — 한 단에 다 몰면 오른쪽이 통째로 빈다.
 */
async function drawToc(
  page: PDFPage,
  frame: Frame,
  lines: string[],
  fontForText: (name: string, text: string) => Promise<{ font: PDFFont; text: string }>,
  flip: (y: number) => number,
) {
  if (lines.length === 0) return;
  const bounds = frameBounds(frame);
  const title = "차 례";
  const titleSize = 18;
  const size = 11;
  const rowH = size * 1.9;
  let y = bounds.headerBottom + LAYOUT.gap + titleSize;

  const head = await fontForText(ANSWER_FONT, title);
  if (head.text.trim()) {
    page.drawText(head.text, {
      x: LAYOUT.marginLeft,
      y: flip(y),
      size: titleSize,
      font: head.font,
      color: rgb(0, 0, 0),
    });
  }
  y += LAYOUT.gap + size;

  // 한 단에 몇 줄이 들어가는지 보고, 넘치면 오른쪽 단으로 넘긴다.
  const perColumn = Math.max(1, Math.floor((bounds.contentBottom - y) / rowH));
  for (let i = 0; i < lines.length; i++) {
    const col = Math.floor(i / perColumn);
    // 단이 둘뿐이라 그 이상은 그리지 않는다(세트가 그만큼 많은 경우는 없다).
    if (col > 1) break;
    const picked = await fontForText(ANSWER_FONT, lines[i]);
    if (!picked.text.trim()) continue;
    page.drawText(picked.text, {
      x: columnX(col),
      y: flip(y + (i % perColumn) * rowH),
      size,
      font: picked.font,
      color: rgb(0.1, 0.1, 0.1),
    });
  }
}

/** 정답표 한 칸의 높이. 글자 12pt 가 넉넉히 들어간다. */
const ANSWER_ROW = 26;
/** 한 벌(번호+정답)의 폭. 종이 폭을 다 늘리면 표가 아니라 줄자처럼 보인다. */
const ANSWER_GROUP_W = 150;
const ANSWER_FONT = "(한)신중명조";

/**
 * 마지막 쪽에 정답표를 그린다.
 *
 * 문제 쪽과 같은 틀 위에 그린다 — 머리말·쪽번호가 이어져야 한 묶음으로 보인다.
 * 표는 `번호 | 정답` 짝을 여러 벌 가로로 늘어놓는다. 답이 많을수록 벌 수를
 * 늘려 세로로 길어지지 않게 한다(한 쪽에 들어가야 한다).
 */
async function drawAnswers(
  page: PDFPage,
  frame: Frame,
  rows: { label: string; answer: string }[],
  // 정답표 글자는 사용자가 적은 것이라(정답에 한글이 들어가는 단답형도 있다)
  // 잘라 둔 글꼴에 없는 글자가 섞일 수 있다. 틀 글자와 같은 길을 태운다.
  fontForText: (name: string, text: string) => Promise<{ font: PDFFont; text: string }>,
  flip: (y: number) => number,
) {
  const font = await fontForText(ANSWER_FONT, "").then((r) => r.font);
  const bounds = frameBounds(frame);
  const left = LAYOUT.marginLeft;
  const width = LAYOUT.columnWidth * 2 + LAYOUT.columnGap;

  const title = "정답";
  const titleSize = 20;
  const titleY = bounds.headerBottom + LAYOUT.gap + titleSize;
  page.drawText(title, {
    x: left + (width - font.widthOfTextAtSize(title, titleSize)) / 2,
    y: flip(titleY),
    size: titleSize,
    font,
    color: rgb(0, 0, 0),
  });

  const top = titleY + LAYOUT.gap * 2;
  const avail = bounds.contentBottom - top;
  // 벌 수는 **개수에 맞춰** 정하고(한 벌에 열두 줄쯤), 그래도 한 쪽에 안 들어가면
  // 더 늘린다. 폭은 벌마다 고정이라 답이 적으면 표도 작게 나온다.
  const maxGroups = Math.max(1, Math.floor(width / ANSWER_GROUP_W));
  let groups = Math.min(maxGroups, Math.max(1, Math.ceil(rows.length / 12)));
  while (groups < maxGroups && (Math.ceil(rows.length / groups) + 1) * ANSWER_ROW > avail) {
    groups += 1;
  }
  const perGroup = Math.ceil(rows.length / groups);
  const groupW = ANSWER_GROUP_W;
  const numW = groupW * 0.5;
  // 표 전체를 종이 가운데에 놓는다.
  const tableLeft = left + (width - groupW * groups) / 2;

  const line = (x1: number, y1: number, x2: number, y2: number) =>
    page.drawLine({
      start: { x: x1, y: flip(y1) },
      end: { x: x2, y: flip(y2) },
      thickness: 0.5,
      color: rgb(0, 0, 0),
    });
  const cell = async (text: string, x: number, w: number, y: number, size = 12) => {
    if (!text) return;
    const picked = await fontForText(ANSWER_FONT, text);
    if (!picked.text.trim()) return;
    page.drawText(picked.text, {
      x: x + (w - picked.font.widthOfTextAtSize(picked.text, size)) / 2,
      y: flip(y + ANSWER_ROW / 2 + size * 0.36),
      size,
      font: picked.font,
      color: rgb(0, 0, 0),
    });
  };

  for (let g = 0; g < groups; g++) {
    const x = tableLeft + g * groupW;
    const count = Math.min(perGroup, Math.max(0, rows.length - g * perGroup));
    if (count === 0) continue;
    const height = (count + 1) * ANSWER_ROW;

    // 바깥 테두리와 가운데 세로선.
    line(x, top, x + groupW, top);
    line(x, top + height, x + groupW, top + height);
    line(x, top, x, top + height);
    line(x + groupW, top, x + groupW, top + height);
    line(x + numW, top, x + numW, top + height);

    await cell("번호", x, numW, top);
    await cell("정답", x + numW, groupW - numW, top);
    line(x, top + ANSWER_ROW, x + groupW, top + ANSWER_ROW);

    for (let r = 0; r < count; r++) {
      const row = rows[g * perGroup + r];
      const y = top + (r + 1) * ANSWER_ROW;
      await cell(row.label, x, numW, y);
      await cell(row.answer, x + numW, groupW - numW, y);
      line(x, y + ANSWER_ROW, x + groupW, y + ANSWER_ROW);
    }
  }
}
