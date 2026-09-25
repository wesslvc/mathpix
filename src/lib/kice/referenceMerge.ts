import { alignCircledToReference, type RichBlock, type RichRun } from "./richText";

/**
 * **글자는 Mathpix, 모양은 AI**(2026-09-25, 사용자 지시 — "텍스트 자체는
 * mathpix 가 하고, ai 가 알려 줄 거는 줄바꿈·띄어쓰기·정렬 위치·볼드체·기호·
 * 특수문자 등등").
 *
 * 예전에는 AI 가 지문을 통째로 옮겨 적고 Mathpix 글은 "참고"로만 줬다. 그러면
 * 참고를 얼마나 따를지는 모델 마음이라, 글자가 조금씩 바뀌는 일을 막을 수가
 * 없었다. 이제 **AI 의 결과를 뼈대로 쓰되 글자는 우리가 Mathpix 것으로 갈아
 * 끼운다.** 두 글을 글자 단위로 맞춰 보고(Myers diff):
 *
 * - **글자**(한글 음절·한자·라틴·숫자)는 Mathpix 것을 쓴다.
 * - **그 밖의 것**(띄어쓰기·줄바꿈·문장부호·원문자·기호·ㄱㄴㄷ 표지)과 서식
 *   (굵게·밑줄·네모·정렬·들여쓰기·상자)은 AI 것을 그대로 둔다.
 *
 * 맞춰지지 않는 자리는 **내용을 잃지 않는 쪽으로** 정한다:
 * - AI 가 빠뜨린 짧은 글자(Mathpix 에만 있음)는 제자리에 끼운다. 단 **맨 앞·맨
 *   끝에만 있는 것은 버린다** — 크롭에 딸려 온 쪽번호·머리말·아래 문항이다.
 * - Mathpix 가 빠뜨린 **긴** 덩어리(AI 에만 있음)는 AI 것을 남긴다. Mathpix 가
 *   글자 분수·한 줄을 통째로 흘리는 일이 실제로 있다. 짧은 것은 AI 가 지어낸
 *   글자로 보고 버린다.
 *
 * 원문자 **정체**(㉠ 인지 ㉡ 인지)는 여기서 안 바꾼다 — 자리는 AI, 글자는
 * 이어서 `alignCircledToReference` 가 Mathpix 것으로 맞춘다(계열별로).
 *
 * 이 파일에는 네트워크 호출도 환경변수도 없다(화면과 서버가 같이 쓴다).
 */

/** Mathpix 가 준 글에서 "글자"로 칠 것. 나머지는 모양으로 본다. */
const isLetter = (ch: string) =>
  /[\uAC00-\uD7A3\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFFA-Za-z0-9]/.test(ch);

/** 한자(한중일 통합·확장 A·호환). 코드포인트를 글자로 적으면 비슷한 글자와 헷갈린다. */
const HANJA = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

/** AI 에만 있는 글자 덩어리를 **남길** 최소 길이(이보다 짧으면 지어낸 것으로 본다). */
const KEEP_MODEL_ONLY = 4;
/** Mathpix 에만 있는 글자를 **끼울** 최대 길이(더 길면 딸려 온 딴 글로 본다). */
const INSERT_REFERENCE_ONLY = 12;
/** 이만큼 넘게 차이 나면 맞추기를 포기한다(두 글이 딴판이다). */
const MAX_EDIT = 800;

export type MergeStats = {
  /** Mathpix 글자로 바꾼 개수(원래 같던 것은 안 센다). */
  replaced: number;
  /** AI 가 빠뜨려 Mathpix 에서 끼운 글자 수. */
  inserted: number;
  /** Mathpix 가 빠뜨려 AI 것을 남긴 글자 수. */
  keptModel: number;
  /** AI 에만 있어 버린 글자 수. */
  dropped: number;
  /** 맞춰 본 글자 수(Mathpix 쪽). */
  referenceLetters: number;
  /** 두 글이 너무 달라 손대지 않았으면 true. */
  skipped: boolean;
};

/**
 * Mathpix 글에서 글자 아닌 군더더기(그림 링크·LaTeX 명령)를 걷어 낸다.
 * 글자와 함께 **그 글자가 걷어 낸 글의 어디에 있었는지**도 돌려준다 — AI 가
 * 빠뜨린 낱말을 끼울 때 그 앞의 띄어쓰기까지 함께 가져오려고.
 */
function referenceLetters(reference: string): { chars: string[]; letters: string[]; at: number[] } {
  const text = reference
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    // `\text`, `\mathrm`, `\section*` 같은 명령 이름은 글자가 아니다.
    .replace(/\\[a-zA-Z]+\*?/g, " ")
    // 마크다운·LaTeX 껍데기 문자도 글에 끼면 안 된다.
    .replace(/[$*_#\\{}]/g, " ")
    .replace(/\s+/g, " ");
  const chars = [...text];
  const letters: string[] = [];
  const at: number[] = [];
  chars.forEach((ch, i) => {
    if (isLetter(ch)) {
      letters.push(ch);
      at.push(i);
    }
  });
  return { chars, letters, at };
}

type Op = "eq" | "del" | "ins";

/**
 * Myers diff — 두 글자 배열을 맞춘다. 편집 거리가 `MAX_EDIT` 를 넘으면 null.
 * 한 단계(d)마다 V 를 `2d+1` 칸만 복사해 두므로 메모리는 대략 d² 이다.
 */
function myers(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, MAX_EDIT); d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;

  // 되짚어 가며 편집 목록을 만든다.
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d]; // d 단계를 시작할 때의 V(= d-1 단계가 끝난 값)
    const at = (k: number) => prev[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push("eq");
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push("ins");
      y--;
    } else {
      ops.push("del");
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push("eq");
    x--;
    y--;
  }
  return ops.reverse();
}

type Cell = { ch: string; b?: boolean; u?: boolean; sq?: boolean; gone?: boolean };

/** 문단 하나를 글자 칸으로. 서식은 칸마다 들고 간다. */
function toCells(runs: RichRun[]): Cell[] {
  const out: Cell[] = [];
  for (const r of runs) {
    for (const ch of r.t) {
      out.push({
        ch,
        ...(r.b ? { b: true } : {}),
        ...(r.u ? { u: true } : {}),
        ...(r.sq ? { sq: true } : {}),
      });
    }
  }
  return out;
}

/**
 * 칸들을 서식이 같은 것끼리 다시 묶는다. 비워진 칸은 버린다.
 * 낱말을 통째로 버린 자리에는 띄어쓰기가 두 칸 남으므로(`이 반드시 다시` →
 * `이  다시`), 버린 칸을 사이에 둔 공백은 하나만 남긴다.
 */
function toRuns(cells: Cell[]): RichRun[] {
  const runs: RichRun[] = [];
  let prev = "";
  let droppedSince = false;
  for (const c of cells) {
    if (c.gone) droppedSince = true;
    if (!c.ch) continue;
    if (droppedSince && c.ch === " " && (prev === " " || prev === "")) continue;
    prev = c.ch.slice(-1);
    droppedSince = false;
    const last = runs[runs.length - 1];
    if (last && !!last.b === !!c.b && !!last.u === !!c.u && !!last.sq === !!c.sq) {
      last.t += c.ch;
    } else {
      runs.push({
        t: c.ch,
        ...(c.b ? { b: true } : {}),
        ...(c.u ? { u: true } : {}),
        ...(c.sq ? { sq: true } : {}),
      });
    }
  }
  return runs;
}

export function mergeTextFromReference(
  blocks: RichBlock[],
  reference: string,
): { blocks: RichBlock[]; stats: MergeStats } {
  const stats: MergeStats = {
    replaced: 0,
    inserted: 0,
    keptModel: 0,
    dropped: 0,
    referenceLetters: 0,
    skipped: false,
  };
  const { chars: refChars, letters: ref, at: refAt } = referenceLetters(reference);
  stats.referenceLetters = ref.length;
  /** Mathpix 글자 [from, to) 를 그 앞의 띄어쓰기·문장부호까지 붙여 꺼낸다. */
  const refSlice = (from: number, to: number) =>
    refChars.slice(from > 0 ? refAt[from - 1] + 1 : refAt[from], refAt[to - 1] + 1).join("");
  if (ref.length === 0) return { blocks, stats: { ...stats, skipped: true } };

  // 문단마다 칸을 만들고, 글자 칸의 자리를 한 줄로 늘어놓는다.
  const letterAt: Cell[] = [];
  const clone = (list: RichBlock[]): RichBlock[] =>
    list.map((b) => {
      if (b.kind === "box") return { ...b, blocks: clone(b.blocks) };
      if (b.kind !== "para") return b;
      const cells = toCells(b.runs);
      for (const c of cells) if (isLetter(c.ch)) letterAt.push(c);
      // 자리만 잡아 두고, 다 고친 뒤 runs 를 다시 채운다.
      return { ...b, runs: [], __cells: cells } as RichBlock;
    });
  const draft = clone(blocks);
  const model = letterAt.map((c) => c.ch);

  const ops = myers(model, ref);
  if (!ops) return { blocks, stats: { ...stats, skipped: true } };

  // 편집 목록을 덩어리로 묶어 규칙대로 적용한다.
  let ai = 0; // model 쪽 자리
  let ri = 0; // ref 쪽 자리
  let seenEq = false;
  let i = 0;
  while (i < ops.length) {
    if (ops[i] === "eq") {
      ai++;
      ri++;
      seenEq = true;
      i++;
      continue;
    }
    const aStart = ai;
    const rStart = ri;
    while (i < ops.length && ops[i] !== "eq") {
      if (ops[i] === "del") ai++;
      else ri++;
      i++;
    }
    const aLen = ai - aStart;
    const rLen = ri - rStart;
    const atEdge = !seenEq || i >= ops.length;

    if (aLen === 0) {
      // Mathpix 에만 있다(AI 가 빠뜨림). 맨 앞·맨 끝은 딸려 온 딴 글이다.
      if (atEdge || rLen > INSERT_REFERENCE_ONLY || aStart === 0) continue;
      letterAt[aStart - 1].ch += refSlice(rStart, ri);
      stats.inserted += rLen;
      continue;
    }
    if (rLen === 0) {
      // AI 에만 있다. 길면 Mathpix 가 흘린 것, 짧으면 AI 가 지어낸 것.
      // 한자는 짧아도 남긴다 — `적벽가(赤壁歌)` 의 한자를 Mathpix 가 흘리는 일은
      // 있어도 AI 가 없는 한자를 지어 넣을 까닭은 없다.
      const onlyHanja = letterAt
        .slice(aStart, ai)
        .every((c) => HANJA.test(c.ch));
      if (aLen >= KEEP_MODEL_ONLY || onlyHanja) {
        stats.keptModel += aLen;
      } else {
        for (let k = aStart; k < ai; k++) {
          letterAt[k].ch = "";
          letterAt[k].gone = true;
        }
        stats.dropped += aLen;
      }
      continue;
    }
    // 둘 다 있다 — 자리 수만큼 Mathpix 글자로 갈아 끼운다. 너무 차이 나면
    // (Mathpix 쪽에 딴 글이 끼었다) 손대지 않는다.
    if (rLen > aLen * 2 + 8) {
      stats.keptModel += aLen;
      continue;
    }
    for (let k = 0; k < aLen; k++) {
      const cell = letterAt[aStart + k];
      if (k < rLen) {
        if (cell.ch !== ref[rStart + k]) stats.replaced++;
        cell.ch = ref[rStart + k];
      } else {
        cell.ch = "";
        cell.gone = true;
        stats.dropped++;
      }
    }
    if (rLen > aLen) {
      letterAt[ai - 1].ch += refSlice(rStart + aLen, ri);
      stats.inserted += rLen - aLen;
    }
  }

  // 칸을 다시 runs 로 묶는다.
  const finish = (list: RichBlock[]): RichBlock[] =>
    list
      .map((b) => {
        if (b.kind === "box") return { ...b, blocks: finish(b.blocks) };
        if (b.kind !== "para") return b;
        const { __cells, ...rest } = b as RichBlock & { __cells: Cell[] };
        return { ...rest, runs: toRuns(__cells) } as RichBlock;
      })
      .filter((b) => (b.kind === "para" ? b.runs.length > 0 : true));
  return { blocks: finish(draft), stats };
}

/**
 * 모델이 준 블록을 참고 글에 맞춘다 — **글자**(`mergeTextFromReference`)를 먼저,
 * 그다음 **원문자 정체**(`alignCircledToReference`). 국어 모드·수정 화면·비교
 * 화면이 모두 이것 하나를 부른다(한 곳만 다르면 견준 결과가 운영과 어긋난다).
 */
export function applyReference(
  raw: RichBlock[],
  reference: string,
): { blocks: RichBlock[]; replaced: number; matched: boolean; letters: MergeStats } {
  const merged = mergeTextFromReference(raw, reference);
  // 글자를 맞추다 문단이 통째로 비면(있을 수 없지만) 모델 것을 그대로 쓴다.
  const base = merged.blocks.length > 0 ? merged.blocks : raw;
  const circled = alignCircledToReference(base, reference);
  return { ...circled, letters: merged.stats };
}

/** 화면에 한 줄로 적을 글자 맞춤 요약. 손댄 게 없으면 빈 문자열. */
export function describeMerge(stats: MergeStats): string {
  if (stats.skipped) {
    return stats.referenceLetters > 0 ? "글자: 참고 글과 너무 달라 AI 글자를 그대로 씀" : "";
  }
  const parts: string[] = [];
  if (stats.replaced) parts.push(`${stats.replaced}자 바꿈`);
  if (stats.inserted) parts.push(`${stats.inserted}자 끼움`);
  if (stats.dropped) parts.push(`${stats.dropped}자 뺌`);
  if (stats.keptModel) parts.push(`Mathpix 에 없는 ${stats.keptModel}자는 AI 것을 둠`);
  return parts.length ? `글자를 Mathpix 기준으로 ${parts.join(" · ")}` : "글자: Mathpix 와 일치";
}
