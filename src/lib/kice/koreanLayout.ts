import { tocLine } from "../koreanSet";
import type { RichBlock } from "./richText";

/**
 * **국어 문제지의 쪽을 짠다**(2026-09-25, 사용자 요청).
 *
 * 규칙은 하나에서 나온다 — **인쇄해서 펼쳤을 때 지문과 문제가 한눈에 보여야
 * 한다.**
 *
 * - 지문이 한 단에 들어가고 그 문제들이 옆 단에 들어가면 **한 쪽에** 둔다
 *   (왼쪽 단 지문 · 오른쪽 단 문제). 한 쪽 안에 있으니 짝홀은 상관없다.
 * - 두 쪽에 걸치면 **반드시 짝수 쪽에 지문, 홀수 쪽에 문제**다. 펼친 면의
 *   왼쪽이 짝수 쪽이다. 다음 쪽이 홀수면 빈 쪽을 하나 넣어 맞춘다.
 * - 첫 세트가 한 쪽짜리면 **목차를 없애고** 1쪽부터 그 세트를 놓는다.
 *
 * 재는 일(글꼴 폭·그림 크기)은 밖에서 콜백으로 받는다 — 이 파일은 pdf-lib 을
 * 모른다. 그래야 규칙을 따로 떼어 시험할 수 있다. 네트워크 호출도 환경변수도 없다.
 */

export type KoreanPassage =
  | { kind: "text"; blocks: RichBlock[] }
  /** `splitAt` 은 두 쪽짜리(두 단에 나눠 흘릴 때) 가르는 자리(그림 높이의 0~1). */
  | { kind: "image"; index: number; splitAt?: number };

export type KoreanSetIn = {
  passage: KoreanPassage | null;
  /** 문제 그림의 자리(`problems` 배열의 번호). */
  questions: number[];
  title: string;
  source: string;
};

export type KoreanPage =
  | { kind: "toc" }
  | { kind: "passageText"; blocks: RichBlock[] }
  | { kind: "passage"; index: number; splitAt?: number }
  | { kind: "questions"; indexes: number[] }
  /** 한 쪽에 왼쪽 단 지문 · 오른쪽 단 문제. */
  | { kind: "spread"; passage: KoreanPassage; indexes: number[] }
  /** 짝홀을 맞추려고 넣는 빈 쪽(머리말·쪽번호만). */
  | { kind: "blank" };

export type KoreanFit = {
  /** 이 지문이 `pageNo` 쪽의 한 단에 다 들어가는가. */
  passageFitsColumn: (passage: KoreanPassage, pageNo: number) => boolean;
  /** 이 문제들이 `pageNo` 쪽의 한 단에 (충분한 크기로) 다 들어가는가. */
  questionsFitColumn: (indexes: number[], pageNo: number) => boolean;
};

/** 지문 한 편을 통째로(두 단에) 싣는 쪽. */
function passagePage(p: KoreanPassage): KoreanPage {
  return p.kind === "text"
    ? { kind: "passageText", blocks: p.blocks }
    : { kind: "passage", index: p.index, ...(p.splitAt ? { splitAt: p.splitAt } : {}) };
}

export function planKoreanPages(
  sets: KoreanSetIn[],
  loose: number[],
  fit: KoreanFit,
): { toc: string[]; pages: KoreanPage[] } {
  /** 이 세트를 `pageNo` 쪽 한 장에 다 실을 수 있는가. */
  const onePage = (set: KoreanSetIn, pageNo: number) =>
    !set.passage ||
    set.questions.length === 0 ||
    (fit.passageFitsColumn(set.passage, pageNo) && fit.questionsFitColumn(set.questions, pageNo));

  const pages: KoreanPage[] = [];
  // 첫 세트가 한 장짜리면 목차 없이 1쪽(표지 틀)부터 싣는다(사용자 요청).
  const withToc = !(sets.length > 0 && onePage(sets[0], 1));
  if (withToc) pages.push({ kind: "toc" });

  const toc: string[] = [];
  for (const set of sets) {
    const next = pages.length + 1;
    let from: number;
    if (onePage(set, next)) {
      from = next;
      if (set.passage && set.questions.length > 0) {
        pages.push({ kind: "spread", passage: set.passage, indexes: set.questions });
      } else if (set.passage) {
        pages.push(passagePage(set.passage));
      } else {
        pages.push({ kind: "questions", indexes: set.questions });
      }
    } else {
      // 두 쪽짜리 — 지문은 반드시 짝수 쪽(펼친 면의 왼쪽)에.
      if (next % 2 === 1) pages.push({ kind: "blank" });
      from = pages.length + 1;
      pages.push(passagePage(set.passage!));
      pages.push({ kind: "questions", indexes: set.questions });
    }
    toc.push(tocLine(from, pages.length, set.source, set.title || "지문"));
  }
  for (let i = 0; i < loose.length; i += 2) {
    pages.push({ kind: "questions", indexes: loose.slice(i, i + 2) });
  }
  return { toc: withToc ? toc : [], pages };
}
