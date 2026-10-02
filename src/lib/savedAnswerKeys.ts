/**
 * **저장돼 있는 정답표를 불러온다**(2026-10-02, 사용자 — "이미 생성된 파일의 정답표를 불러와서 채점하거나, 다른
 * 파일에서 정답표 넣을 때 다른 파일로부터 불러오게끔").
 *
 * 정답표가 남아 있는 자리는 셋이다:
 * - **읽어 둔 답지**(`answer_keys.items`) — 답지 사진을 읽어 저장한 것.
 * - **채점 기록**(`exam_scores.items[].correctAnswer`) — 채점할 때 정답표 사진에서 읽은 것. 탐구는 1·2선택이
 *   따로 한 줄씩이다.
 * - **실모의 문제 정답**(`problems.answer` + `box_range.points`) — 문제마다 붙어 있는 정답. 번호는 화면·내보내기와
 *   같은 규칙(손으로 정한 값 → 본문 맨 앞)으로 매기고, 같은 번호에 답이 갈리면 그 번호는 뺀다(`answerMap.ts` 와
 *   같은 판단 — 잘못 붙이는 것보다 빠지는 편이 낫다). 지문은 문제가 아니라 뺀다.
 *
 * 브라우저 전용이다(로그인 세션으로 읽는다 — RLS 가 제 것만 보여 준다). 그림이 든 `box_range` 는 통째로 안 받고
 * 필요한 키만 뽑는다(문제 하나가 수백 KB~4MB 다).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnswerKeyItem } from "./gradeExam";
import { SUBJECT_LABEL } from "./examSubjects";
import { parseProblemNumber, readProblemNumber } from "./problemNumber";

export type SavedKeyKind = "key" | "grade" | "problems";

export type SavedKeySource = {
  /** `${kind}:${행 id}` — 목록에서 고를 때 쓰는 열쇠. */
  id: string;
  kind: SavedKeyKind;
  title: string;
  /** "20문항 · 1~20번 · 배점 있음 · 9월 2일" 같은 한 줄. */
  detail: string;
  categoryId: string | null;
  /** 정렬용(최근 것부터). */
  date: string;
  items: AnswerKeyItem[];
};

export const SAVED_KEY_KIND_LABEL: Record<SavedKeyKind, string> = {
  problems: "실모 문제의 정답",
  key: "읽어 둔 답지",
  grade: "채점 기록",
};

/** 들쭉날쭉한 저장 값을 정답표 한 줄로. 번호가 겹치면 첫 것만 남긴다. */
export function cleanKeyItems(list: unknown, answerField: "answer" | "correctAnswer"): AnswerKeyItem[] {
  if (!Array.isArray(list)) return [];
  const out: AnswerKeyItem[] = [];
  const seen = new Set<number>();
  for (const raw of list as Record<string, unknown>[]) {
    const no = Math.floor(Number(raw?.no));
    const a = raw?.[answerField];
    const answer = typeof a === "string" ? a.trim() : typeof a === "number" ? String(a) : "";
    if (!Number.isFinite(no) || no < 1 || !answer || seen.has(no)) continue;
    seen.add(no);
    const points = Number(raw?.points);
    out.push({ no, answer, ...(Number.isFinite(points) && points > 0 ? { points } : {}) });
  }
  return out.sort((x, y) => x.no - y.no);
}

/** "20문항 · 1~20번 · 배점 있음" */
export function describeKey(items: AnswerKeyItem[]): string {
  if (items.length === 0) return "비어 있음";
  const first = items[0].no;
  const last = items[items.length - 1].no;
  const withPoints = items.filter((it) => it.points != null).length;
  const pts =
    withPoints === 0 ? "배점 없음" : withPoints === items.length ? "배점 있음" : `배점 ${withPoints}개`;
  return `${items.length}문항 · ${first === last ? `${first}번` : `${first}~${last}번`} · ${pts}`;
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[2])}월 ${Number(m[3])}일` : "";
}

type CategoryRow = { id: string; source: string; folder_id: string | null; exam_date: string | null; created_at: string };
type FolderRow = { id: string; name: string };
type KeyRow = { id: string; name: string | null; category_id: string | null; items: unknown; created_at: string };
type GradeRow = {
  id: string;
  exam_name: string | null;
  subject: keyof typeof SUBJECT_LABEL;
  elective_label: string | null;
  category_id: string | null;
  taken_at: string | null;
  created_at: string;
  items: unknown;
};
type ProblemRow = {
  category_id: string;
  answer: string | null;
  text_content: string | null;
  latex: string | null;
  problemNo: unknown;
  points: unknown;
  role: string | null;
};

/**
 * 고를 수 있는 정답표를 전부 모은다(최근 것부터, 갈래마다). 문항이 하나도 없는 것은 뺀다.
 * `excludeCategoryId` 의 **문제 정답**은 뺀다 — 그 실모에 정답을 넣는 중이면 제 정답을 다시 불러올 이유가 없다.
 */
export async function listSavedAnswerKeys(
  supabase: SupabaseClient,
  opts: { excludeCategoryId?: string } = {},
): Promise<SavedKeySource[]> {
  const [cats, folders, keys, grades, probs] = await Promise.all([
    supabase.from("categories").select("id, source, folder_id, exam_date, created_at").returns<CategoryRow[]>(),
    supabase.from("folders").select("id, name").returns<FolderRow[]>(),
    supabase
      .from("answer_keys")
      .select("id, name, category_id, items, created_at")
      .order("created_at", { ascending: false })
      .limit(300)
      .returns<KeyRow[]>(),
    supabase
      .from("exam_scores")
      .select("id, exam_name, subject, elective_label, category_id, taken_at, created_at, items")
      .order("taken_at", { ascending: false })
      .limit(300)
      .returns<GradeRow[]>(),
    supabase
      .from("problems")
      .select(
        "category_id, answer, text_content, latex, problemNo:box_range->number, points:box_range->points, role:box_range->korean->>role",
      )
      .not("answer", "is", null)
      .neq("answer", "")
      .returns<ProblemRow[]>(),
  ]);
  if (cats.error) throw new Error(cats.error.message);

  const catById = new Map((cats.data ?? []).map((c) => [c.id, c]));
  const folderName = new Map((folders.data ?? []).map((f) => [f.id, f.name]));
  /** 실모 이름(폴더가 있으면 "폴더 · 이름"). 같은 이름이 여러 폴더에 있어도 가려진다. */
  const catTitle = (id: string | null): string | null => {
    const c = id ? catById.get(id) : undefined;
    if (!c) return null;
    const f = c.folder_id ? folderName.get(c.folder_id) : undefined;
    return f ? `${f} · ${c.source}` : c.source;
  };

  const out: SavedKeySource[] = [];

  // ① 실모 문제의 정답 — 실모마다 하나.
  const byCat = new Map<string, Map<number, AnswerKeyItem | null>>();
  for (const p of probs.data ?? []) {
    if (p.role === "passage" || !p.answer?.trim()) continue;
    if (opts.excludeCategoryId && p.category_id === opts.excludeCategoryId) continue;
    const no = readProblemNumber({ number: p.problemNo }) ?? parseProblemNumber(p.text_content || p.latex || "");
    if (no == null) continue;
    const m = byCat.get(p.category_id) ?? new Map<number, AnswerKeyItem | null>();
    byCat.set(p.category_id, m);
    const answer = p.answer.trim();
    const points = typeof p.points === "number" && p.points > 0 ? p.points : undefined;
    const had = m.get(no);
    if (had === undefined) m.set(no, { no, answer, ...(points ? { points } : {}) });
    else if (had && had.answer !== answer) m.set(no, null); // 같은 번호에 답이 갈림 → 뺀다
  }
  for (const [catId, m] of byCat) {
    const items = [...m.values()].filter((x): x is AnswerKeyItem => x !== null).sort((a, b) => a.no - b.no);
    if (items.length === 0) continue;
    const c = catById.get(catId);
    out.push({
      id: `problems:${catId}`,
      kind: "problems",
      title: catTitle(catId) ?? "이름 없는 실모",
      detail: `${describeKey(items)}${c?.exam_date ? ` · ${shortDate(c.exam_date)}` : ""}`,
      categoryId: catId,
      date: c?.exam_date ?? c?.created_at ?? "",
      items,
    });
  }

  // ② 읽어 둔 답지.
  for (const k of keys.data ?? []) {
    const items = cleanKeyItems(k.items, "answer");
    if (items.length === 0) continue;
    const cat = catTitle(k.category_id);
    out.push({
      id: `key:${k.id}`,
      kind: "key",
      title: cat ?? k.name ?? "답지",
      detail: `${describeKey(items)} · ${shortDate(k.created_at)} 읽음`,
      categoryId: k.category_id,
      date: k.created_at,
      items,
    });
  }

  // ③ 채점 기록(정답 칸) — 손으로 적은 성적은 문항이 없어 저절로 빠진다.
  for (const g of grades.data ?? []) {
    const items = cleanKeyItems(g.items, "correctAnswer");
    if (items.length === 0) continue;
    const subj = `${SUBJECT_LABEL[g.subject] ?? ""}${g.elective_label ? ` · ${g.elective_label}` : ""}`;
    const name = g.exam_name || catTitle(g.category_id) || subj;
    out.push({
      id: `grade:${g.id}`,
      kind: "grade",
      title: g.exam_name || g.category_id ? `${name} (${subj})` : name,
      detail: `${describeKey(items)}${g.taken_at ? ` · ${shortDate(g.taken_at)} 응시` : ""}`,
      categoryId: g.category_id,
      date: g.taken_at ?? g.created_at,
      items,
    });
  }

  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
