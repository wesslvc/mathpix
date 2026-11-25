import { NextResponse } from "next/server";
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from "fflate";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import {
  r2Configured,
  r2Get,
  r2MultipartAbort,
  r2MultipartComplete,
  r2MultipartCreate,
  r2MultipartPart,
  r2PresignDownload,
} from "@/lib/r2";
import { buildXlsx, type Cell } from "@/lib/xlsx";
import { safeName } from "@/lib/zipExport";
import { parseProblemNumber, readProblemNumber } from "@/lib/problemNumber";
import { formatAnswer, toAnswerType } from "@/lib/answer";
import { SUBJECT_LABEL } from "@/lib/examSubjects";
import { examMaxScore } from "@/lib/gradeSummary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

/**
 * **기존 데이터 받기**(2027 수능 뒤, 사이트를 문항 제작 에디터로 바꾸기 전에).
 * 로그인한 사람의 문제 이미지 전부 + 성적·문제 목록 엑셀을 ZIP 하나로 묶어 **R2 에 올리고**, 그 파일의 내려받기 주소를 돌려준다.
 * 브라우저는 R2 에서 바로 받는다(Vercel 을 거치지 않는다). ZIP 은 조각으로 흘려 올려서 크기가 커도 메모리를 다 쓰지 않는다.
 */

const PART = 8 * 1024 * 1024; // R2 조각(마지막 빼고 5MB 이상)
const PREFETCH = 6;

type Cat = { id: string; source: string; folder_id: string | null; exam_date: string | null; is_variant?: boolean; created_at: string };
type Prob = {
  id: string;
  category_id: string;
  image_path: string | null;
  answer: string | null;
  answer_type: string | null;
  sort_order: number | null;
  text_content: string | null;
  created_at: string;
  problemNo: unknown;
  solution: string | null;
  korean: { role?: string; title?: string } | null;
};

const extOf = (mime: string, path: string) => {
  if (/png/i.test(mime) || /\.png$/i.test(path)) return "png";
  if (/webp/i.test(mime) || /\.webp$/i.test(path)) return "webp";
  return "jpg";
};

export async function POST() {
  if (!isSupabaseConfigured()) return NextResponse.json({ error: "Supabase가 설정되지 않았습니다." }, { status: 503 });
  if (!r2Configured()) return NextResponse.json({ error: "저장소(R2)가 설정되지 않아 만들 수 없어요." }, { status: 503 });
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const admin = createAdminClient();

  // ---- 자료 모으기(본인 것만: 사용자 세션 + RLS)
  const [{ data: folders }, { data: cats }, { data: scores }] = await Promise.all([
    supabase.from("folders").select("id,name"),
    supabase.from("categories").select("*").order("created_at"),
    supabase.from("exam_scores").select("*").order("taken_at"),
  ]);
  const folderName = new Map<string, string>((folders ?? []).map((f: { id: string; name: string }) => [f.id, f.name]));
  const catList = (cats ?? []) as Cat[];
  const catById = new Map(catList.map((c) => [c.id, c]));
  const probs: Prob[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("problems")
      .select(
        "id,category_id,image_path,answer,answer_type,sort_order,text_content,created_at,problemNo:box_range->number,solution:box_range->>solution,korean:box_range->korean",
      )
      .order("category_id")
      .order("sort_order", { nullsFirst: false })
      .range(from, from + 999);
    if (error) return NextResponse.json({ error: `문제 목록을 읽지 못했어요: ${error.message}` }, { status: 500 });
    probs.push(...((data ?? []) as unknown as Prob[]));
    if (!data || data.length < 1000) break;
  }

  // ---- 폴더 이름 정하기: 문제/<폴더>/<실모>/  (변형 묶음은 변형문제/<묶음>/)
  const dirOf = new Map<string, string>();
  const usedDir = new Set<string>();
  for (const c of catList) {
    const top = c.is_variant ? "변형문제" : c.folder_id && folderName.get(c.folder_id) ? `문제/${safeName(folderName.get(c.folder_id)!, "폴더")}` : "문제/폴더 없음";
    let d = `${top}/${safeName(c.source || "실모", "실모")}`;
    for (let k = 2; usedDir.has(d); k++) d = `${top}/${safeName(c.source || "실모", "실모")} (${k})`;
    usedDir.add(d);
    dirOf.set(c.id, d);
  }

  // ---- ZIP 을 흘려 쓰고 R2 에 조각으로 올린다
  const stamp = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const key = `${user.id}/_export/reprint-${stamp}.zip`;
  const uploadId = await r2MultipartCreate(key, "application/zip");
  const parts: { n: number; etag: string }[] = [];
  let buf: Uint8Array[] = [];
  let bufLen = 0;
  let total = 0;
  let zipErr: Error | null = null;
  const zip = new Zip((err, data) => {
    if (err) zipErr = err;
    else {
      buf.push(data);
      bufLen += data.length;
      total += data.length;
    }
  });
  const flush = async (force = false) => {
    if (zipErr) throw zipErr;
    while (bufLen >= PART || (force && bufLen > 0)) {
      const all = new Uint8Array(bufLen);
      let o = 0;
      for (const c of buf) {
        all.set(c, o);
        o += c.length;
      }
      const take = force ? all.length : PART;
      const piece = all.subarray(0, take);
      const rest = all.subarray(take);
      buf = rest.length ? [rest] : [];
      bufLen = rest.length;
      parts.push({ n: parts.length + 1, etag: await r2MultipartPart(key, uploadId, parts.length + 1, piece) });
      if (force && bufLen === 0) break;
    }
  };
  const addFile = (name: string, bytes: Uint8Array, compress = false) => {
    const f = compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
    zip.add(f);
    f.push(bytes, true);
  };

  const loadBytes = async (path: string): Promise<{ bytes: Uint8Array; mime: string } | null> => {
    try {
      const res = await r2Get(path);
      if (res) return { bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get("content-type") || "" };
    } catch {
      /* 아래 Supabase 로 */
    }
    const { data } = await admin.storage.from("problem-images").download(path);
    return data ? { bytes: new Uint8Array(await data.arrayBuffer()), mime: data.type || "" } : null;
  };

  const listRows: Cell[][] = [["파일", "폴더·실모", "실모 안 차례", "문제 번호", "구분", "정답", "유형", "해설", "만든 날"]];
  const missing: string[] = [];
  try {
    // 순서대로 넣되 앞에서 몇 장씩 미리 받는다.
    const seq = new Map<string, number>();
    const usedName = new Set<string>();
    const jobs = probs
      .filter((p) => p.image_path && catById.has(p.category_id))
      .map((p) => {
        const k = (seq.get(p.category_id) ?? 0) + 1;
        seq.set(p.category_id, k);
        const passage = p.korean?.role === "passage";
        const no = readProblemNumber(p.problemNo) ?? (p.text_content ? parseProblemNumber(p.text_content) : null);
        const base = passage ? `${String(k).padStart(2, "0")}_지문${p.korean?.title ? `_${safeName(p.korean.title, "")}` : ""}` : `${String(k).padStart(2, "0")}_${no ? `${no}번` : "번호없음"}`;
        return { p, k, no, passage, base };
      });
    const fetching: Promise<{ bytes: Uint8Array; mime: string } | null>[] = [];
    const start = (i: number) => {
      if (i < jobs.length && !fetching[i]) fetching[i] = loadBytes(jobs[i].p.image_path!);
    };
    for (let i = 0; i < Math.min(PREFETCH, jobs.length); i++) start(i);
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i];
      const got = await fetching[i];
      delete fetching[i];
      start(i + PREFETCH);
      const dir = dirOf.get(j.p.category_id)!;
      if (!got) {
        missing.push(`${dir}/${j.base}`);
        continue;
      }
      let name = `${dir}/${j.base}.${extOf(got.mime, j.p.image_path!)}`;
      for (let n = 2; usedName.has(name); n++) name = `${dir}/${j.base} (${n}).${extOf(got.mime, j.p.image_path!)}`;
      usedName.add(name);
      addFile(name, got.bytes);
      const answer = j.p.answer ? formatAnswer(j.p.answer, toAnswerType(j.p.answer_type)) : "";
      listRows.push([
        name,
        dir,
        j.k,
        j.no ?? "",
        j.passage ? "지문" : "문제",
        answer,
        j.p.answer_type === "short" ? "주관식" : j.p.answer ? "객관식" : "",
        j.p.solution ?? "",
        j.p.created_at.slice(0, 10),
      ]);
      await flush();
    }

    // ---- 엑셀: 성적 · 문항별 · 문제 목록
    const scoreRows: Cell[][] = [["응시일", "시험 이름", "과목", "선택과목", "점수", "만점", "등급", "문항 수", "맞은 수", "틀린 번호", "연결한 실모", "메모"]];
    const itemRows: Cell[][] = [["응시일", "시험 이름", "과목", "선택과목", "번호", "내 답", "정답", "배점", "정오"]];
    for (const s of (scores ?? []) as Record<string, unknown>[]) {
      const subject = String(s.subject) as keyof typeof SUBJECT_LABEL;
      const subj = SUBJECT_LABEL[subject] ?? String(s.subject);
      const cat = s.category_id ? catById.get(String(s.category_id)) : undefined;
      scoreRows.push([
        String(s.taken_at ?? ""),
        (s.exam_name as string) ?? cat?.source ?? "",
        subj,
        (s.elective_label as string) ?? "",
        typeof s.score === "number" ? s.score : "",
        examMaxScore(subject as never),
        typeof s.grade_level === "number" ? s.grade_level : "",
        typeof s.total_questions === "number" && s.total_questions > 0 ? s.total_questions : "",
        typeof s.total_questions === "number" && s.total_questions > 0 ? (s.correct_count as number) : "",
        Array.isArray(s.wrong_numbers) ? (s.wrong_numbers as number[]).join(", ") : "",
        cat?.source ?? "",
        (s.comment as string) ?? "",
      ]);
      for (const it of (Array.isArray(s.items) ? s.items : []) as { no: number; studentAnswer: string | null; correctAnswer: string; points?: number }[]) {
        const ok = it.studentAnswer !== null && String(it.studentAnswer).trim() === String(it.correctAnswer).trim();
        itemRows.push([String(s.taken_at ?? ""), (s.exam_name as string) ?? cat?.source ?? "", subj, (s.elective_label as string) ?? "", it.no, it.studentAnswer ?? "", it.correctAnswer, it.points ?? "", ok ? "O" : "X"]);
      }
    }
    addFile("성적_문제목록.xlsx", buildXlsx([
      { name: "성적", rows: scoreRows },
      { name: "문항별", rows: itemRows },
      { name: "문제 목록", rows: listRows },
    ]));
    addFile(
      "읽어 주세요.txt",
      strToU8(
        [
          "수학오답프린트 제작 — 기존 데이터",
          `만든 때: ${new Date().toISOString()}`,
          "",
          "문제/<폴더>/<실모>/  : 저장해 둔 문제 이미지(실모 안 차례_번호).",
          "변형문제/<묶음>/     : 만든 변형문제 이미지.",
          "성적_문제목록.xlsx   : 성적(시험별) · 문항별 채점 · 문제 목록(정답·해설).",
          missing.length ? `\n받지 못한 이미지 ${missing.length}개:\n${missing.join("\n")}` : "",
          "",
          "27수능 수고하셨습니다.",
        ].join("\r\n"),
      ),
      true,
    );
    zip.end();
    await flush(true);
    if (zipErr) throw zipErr;
    await r2MultipartComplete(key, uploadId, parts);
  } catch (err) {
    await r2MultipartAbort(key, uploadId);
    return NextResponse.json({ error: `묶지 못했어요: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
  }

  const url = await r2PresignDownload(key, `reprint-data-${stamp}.zip`);
  return NextResponse.json({ url, bytes: total, images: listRows.length - 1, missing: missing.length, scores: (scores ?? []).length });
}
