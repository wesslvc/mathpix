/**
 * **문항 제작 에디터**의 문항 한 개(평가원 스타일). 순수 모듈 — 화면·서버·내보내기가 같은 모양을 읽는다.
 *
 * 글 칸의 표기: 빈 줄 = 문단, `$…$` = 수식(LaTeX), `**굵게**`, `__밑줄__`.
 */
export type QFigure = {
  /** 그림 SVG 원문(AI 가 그렸거나 사람이 고친 것). */
  svg: string;
  /** 단 폭 대비 그림 폭(%). */
  widthPct: number;
  /** 그림 아래 작은 글(예: "(가)"). */
  caption?: string;
};

export type QDoc = {
  id: string;
  title: string;
  /** 과목(자유 글 — 예: 세계지리, 지구과학Ⅰ, 수학). */
  subject: string;
  number: number;
  points: number;
  /** 발문(+ 자료 글). */
  stem: string;
  figure: QFigure | null;
  /** 발문 뒤 묻는 문장(예: "이에 대한 설명으로 옳은 것만을 <보기>에서 있는 대로 고른 것은?"). */
  question: string;
  /** <보기> ㄱ·ㄴ·ㄷ 진술. 비면 상자를 안 그린다. */
  bogi: string[];
  /** 선지 다섯 개. */
  choices: string[];
  /** 정답 1~5(0 = 안 정함). */
  answer: number;
  solution: string;
  updatedAt: string;
};

export type QIndexRow = { id: string; title: string; subject: string; updatedAt: string };

export function newDoc(id: string): QDoc {
  return {
    id,
    title: "새 문항",
    subject: "",
    number: 1,
    points: 2,
    stem: "",
    figure: null,
    question: "",
    bogi: [],
    choices: ["", "", "", "", ""],
    answer: 0,
    solution: "",
    updatedAt: new Date().toISOString(),
  };
}

const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
const num = (v: unknown, lo: number, hi: number, d: number) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : d;
};

/** SVG 원문을 받기 전에 위험한 것을 뺀다(스크립트·외부 참조·이벤트). */
export function cleanSvg(raw: string): string | null {
  const s = raw.trim();
  if (!/^<svg[\s>]/i.test(s) || !/<\/svg>\s*$/i.test(s) || s.length > 400_000) return null;
  if (/<script|<foreignObject|javascript:|<iframe|<object|<embed/i.test(s)) return null;
  return s
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, "")
    .replace(/(xlink:)?href\s*=\s*("(?!#|data:image\/)[^"]*"|'(?!#|data:image\/)[^']*')/gi, "");
}

/** 저장·받기 전에 모양을 맞춘다(모르는 값은 버린다). */
export function readDoc(raw: unknown, id: string): QDoc {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = newDoc(id);
  const f = o.figure as Record<string, unknown> | null | undefined;
  const svg = f && typeof f.svg === "string" ? cleanSvg(f.svg) : null;
  const choices = Array.isArray(o.choices) ? o.choices.slice(0, 5).map((c) => str(c, 400)) : d.choices;
  while (choices.length < 5) choices.push("");
  return {
    id,
    title: str(o.title, 120) || d.title,
    subject: str(o.subject, 40),
    number: num(o.number, 1, 99, 1),
    points: num(o.points, 1, 9, 2),
    stem: str(o.stem, 8000),
    figure: svg ? { svg, widthPct: num(f!.widthPct, 20, 100, 80), caption: str(f!.caption, 60) || undefined } : null,
    question: str(o.question, 600),
    bogi: Array.isArray(o.bogi) ? o.bogi.slice(0, 6).map((b) => str(b, 600)) : [],
    choices,
    answer: num(o.answer, 0, 5, 0),
    solution: str(o.solution, 8000),
    updatedAt: new Date().toISOString(),
  };
}

export const BOGI_LABELS = ["ㄱ", "ㄴ", "ㄷ", "ㄹ", "ㅁ", "ㅂ"];
export const CIRCLED = ["①", "②", "③", "④", "⑤"];
