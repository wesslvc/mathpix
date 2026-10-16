"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { cardUrl } from "@/lib/cardUrl";
import { fileToDataUrl } from "@/lib/cropImage";
import { ensureDataUrl, imageSizeOf, prepareProblemForModel } from "@/lib/figureImage";
import { runAiTask } from "@/lib/aiTask";
import { Button } from "@/components/ui/button";
import { cardClass } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { LEVEL_LABEL, NOVELTY_LABEL, type VariantLevel, type VariantNovelty } from "@/lib/variantPlan";

/**
 * **변형문제 생성**(시험 중 — 무제한 계정 전용).
 *
 * 입력은 두 갈래다: 내 실모(폴더 → 실모 → 문제 고르기) 또는 문제 사진 올리기. 문제마다
 *  ① sol 이 문제를 이해하고 풀어서 핵심 논리·계산은 두고 숫자만 바꾼 변형을 설계 → 그림 모델에 줄 편집 지시를 만든다
 *  ② sunburst 가 **원본 문제 이미지 + 그 지시**로 이미지를 고쳐 그린다(그림·도표도 새 숫자에 맞게 고친다).
 * 결과는 원본과 나란히 보이고, sol 이 이해한 것·바꾼 값·새 정답·보낸 편집 지시를 펼쳐 볼 수 있다.
 */

type Folder = { id: string; name: string };
type Cat = { id: string; source: string; folder_id: string | null; is_variant?: boolean };
type Prob = { id: string; image_path: string; problemNo: number | null; sort_order: number | null };

type Item = {
  key: string;
  label: string;
  /** 원본 그림 — 실모 문제는 주소, 올린 사진은 data URL. */
  src: string;
  /** 저장할 때 쓴다 — 원본 실모와 번호(올린 사진은 없음). */
  catId?: string;
  no?: number | null;
};
type VariantResult = {
  imagePath: string;
  kind: string;
  summary: string;
  changes: { from: string; to: string; why: string }[];
  originalAnswer: string;
  newAnswer: string;
  solution: string;
  edits: string;
  traps?: string[];
  review?: {
    ok: boolean;
    solvedAnswer: string;
    answerMatches: boolean;
    trapsKept: boolean;
    settingsOk: boolean;
    issues: { kind: string; where: string; problem: string; fix: string }[];
    fixed: boolean;
    skipped?: string;
  } | null;
  estKrw?: number;
};
type Run = {
  key: string;
  label: string;
  copy: number;
  stage: "prep" | "queued" | "done" | "error";
  original?: string;
  result?: VariantResult;
  error?: string;
  ms?: number;
};

const KIND_LABEL: Record<string, string> = { comparison: "대소 비교형", computation: "계산형", concept: "개념형" };
/** 변형 생성은 고정이다(사용자 — "med auto 로 고정"): sol 설계 강도 medium, 그림 품질 auto(= 모델 기본, 서버에는 빈 값). */
const SOL_EFFORT = "medium";

type UnitRow = { id: string; catId: string; image_path: string; no: number | null; unit: string | null };
/** 검색용 정규화 — 공백·가운뎃점·화살표·하이픈을 없애고 소문자로. */
const normU = (t: string) => t.replace(/[\s·>\-→,/()]/g, "").toLowerCase();
const won = (n: number) => `${Math.round(n).toLocaleString()}원`;

export default function VariantPanel() {
  const supabase = useRef(createClient()).current;
  const [folders, setFolders] = useState<Folder[]>([]);
  const [cats, setCats] = useState<Cat[]>([]);
  const [folderId, setFolderId] = useState<string>("");
  const [catId, setCatId] = useState<string>("");
  const [probs, setProbs] = useState<Prob[]>([]);
  /** 여러 폴더·실모에서 고른 문제를 모아 둔다(실모를 바꿔도 안 지워진다). */
  const [picked, setPicked] = useState<Record<string, Item>>({});
  const [uploads, setUploads] = useState<Item[]>([]);
  // 유형별 원본 가져오기(단원 검색)
  const [unitFolder, setUnitFolder] = useState("");
  const [unitRows, setUnitRows] = useState<UnitRow[]>([]);
  const [unitQuery, setUnitQuery] = useState("");
  const [unitBusy, setUnitBusy] = useState<"" | "load" | "label">("");
  const [unitProg, setUnitProg] = useState<{ done: number; total: number; fail: number } | null>(null);
  const [unitNote, setUnitNote] = useState<string | null>(null);
  const unitCancel = useRef(false);
  const [copies, setCopies] = useState(1);
  const [level, setLevel] = useState<VariantLevel>("similar");
  const [novelty, setNovelty] = useState<VariantNovelty>("slight");
  /** 변형문제 창의 폴더(= is_variant 묶음). "" = 새로 만들기. */
  const [saveTarget, setSaveTarget] = useState("");
  const [newFolder, setNewFolder] = useState("");
  const [tab, setTab] = useState<"make" | "library">("make");
  const [libId, setLibId] = useState("");
  const [libRows, setLibRows] = useState<{ id: string; image_path: string; answer: string | null; no: number | null; solution: string | null }[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [f, c] = await Promise.all([
        supabase.from("folders").select("id,name").order("name"),
        supabase.from("categories").select("id,source,folder_id,is_variant").order("created_at", { ascending: false }),
      ]);
      setFolders((f.data as Folder[]) ?? []);
      setCats((c.data as Cat[]) ?? []);
    })();
  }, [supabase]);

  useEffect(() => {
    if (!catId) {
      setProbs([]);
      return;
    }
    void (async () => {
      const { data, error: e } = await supabase
        .from("problems")
        .select("id,image_path,problemNo:box_range->number,korean:box_range->korean,sort_order")
        .eq("category_id", catId)
        .order("sort_order", { ascending: true });
      if (e) {
        setError(`문제를 불러오지 못했어요: ${e.message}`);
        return;
      }
      // 국어 지문은 변형 대상이 아니다.
      const rows = ((data as unknown as (Prob & { korean?: { role?: string } | null })[]) ?? []).filter(
        (p) => p.korean?.role !== "passage",
      );
      setProbs(rows);
    })();
  }, [catId, supabase]);

  const shownCats = cats.filter((c) => !c.is_variant).filter((c) => (folderId === "" ? true : folderId === "_none" ? !c.folder_id : c.folder_id === folderId));
  const catName = (id?: string) => cats.find((c) => c.id === id)?.source ?? "실모";
  const variantFolders = cats.filter((c) => c.is_variant);

  function itemOf(p: Prob): Item {
    return {
      key: `p:${p.id}`,
      label: `${catName(catId)} ${p.problemNo != null ? `${p.problemNo}번` : "(번호 없음)"}`,
      src: cardUrl(p.image_path),
      catId,
      no: p.problemNo,
    };
  }
  function toggle(p: Prob) {
    setPicked((m) => {
      const n = { ...m };
      if (n[`p:${p.id}`]) delete n[`p:${p.id}`];
      else n[`p:${p.id}`] = itemOf(p);
      return n;
    });
  }
  function setAllHere(on: boolean) {
    setPicked((m) => {
      const n = { ...m };
      for (const p of probs) {
        if (on) n[`p:${p.id}`] = itemOf(p);
        else delete n[`p:${p.id}`];
      }
      return n;
    });
  }


  const unitItem = (r: UnitRow): Item => ({
    key: `p:${r.id}`,
    label: `${catName(r.catId)} ${r.no != null ? `${r.no}번` : "(번호 없음)"}`,
    src: cardUrl(r.image_path),
    catId: r.catId,
    no: r.no,
  });

  /** 고른 과목 폴더의 모든 실모 문제(국어 지문 빼고)와, 이미 적어 둔 단원 표지를 불러온다. */
  async function loadUnitRows() {
    if (!unitFolder) return;
    setUnitBusy("load");
    setUnitNote(null);
    setUnitRows([]);
    setUnitProg(null);
    try {
      const catIds = cats
        .filter((c) => !c.is_variant && (unitFolder === "_none" ? !c.folder_id : c.folder_id === unitFolder))
        .map((c) => c.id);
      if (!catIds.length) {
        setUnitNote("이 폴더에는 실모가 없어요.");
        return;
      }
      const rows: UnitRow[] = [];
      for (let i = 0; i < catIds.length; i += 20) {
        const { data, error: e } = await supabase
          .from("problems")
          .select("id,category_id,image_path,problemNo:box_range->number,korean:box_range->korean")
          .in("category_id", catIds.slice(i, i + 20));
        if (e) throw e;
        for (const p of (data as unknown as { id: string; category_id: string; image_path: string; problemNo: number | null; korean?: { role?: string } | null }[]) ?? []) {
          if (p.korean?.role === "passage" || !p.image_path) continue;
          rows.push({ id: p.id, catId: p.category_id, image_path: p.image_path, no: p.problemNo, unit: null });
        }
      }
      const labels = new Map<string, string>();
      for (let i = 0; i < rows.length; i += 60) {
        const { data, error: e } = await supabase
          .from("problem_units")
          .select("problem_id,unit")
          .in("problem_id", rows.slice(i, i + 60).map((r) => r.id));
        if (e) throw e;
        for (const l of (data as { problem_id: string; unit: string }[]) ?? []) labels.set(l.problem_id, l.unit);
      }
      const order = new Map(catIds.map((id, i) => [id, i]));
      rows.sort((a, b) => (order.get(a.catId) ?? 0) - (order.get(b.catId) ?? 0) || (a.no ?? 1e9) - (b.no ?? 1e9));
      setUnitRows(rows.map((r) => ({ ...r, unit: labels.get(r.id) ?? null })));
      if (!rows.length) setUnitNote("문제가 없어요.");
    } catch (err) {
      setUnitNote(`불러오지 못했어요: ${err instanceof Error ? err.message : (err as { message?: string })?.message ?? ""}`);
    } finally {
      setUnitBusy("");
    }
  }

  /** 단원 표지가 없는 문제를 luna 가 읽어 적는다(문제당 한 번, 8개 동시). 한 번 적으면 다시 검색할 때 공짜다. */
  async function labelMissing() {
    const todo = unitRows.filter((r) => !r.unit);
    if (!todo.length) return;
    unitCancel.current = false;
    setUnitBusy("label");
    setUnitNote(null);
    setUnitProg({ done: 0, total: todo.length, fail: 0 });
    const hint = folders.find((f) => f.id === unitFolder)?.name ?? "";
    const queue = [...todo];
    let done = 0;
    let fail = 0;
    let firstErr = "";
    await Promise.all(
      Array.from({ length: Math.min(8, queue.length) }, async () => {
        for (let r = queue.shift(); r && !unitCancel.current; r = queue.shift()) {
          const row = r;
          try {
            const out = await runAiTask<{ unit: string }>("unitLabel", {
              label: `단원 · ${catName(row.catId)} ${row.no ?? ""}`,
              params: { problemId: row.id, hint },
            });
            setUnitRows((rs) => rs.map((x) => (x.id === row.id ? { ...x, unit: out.result.unit } : x)));
          } catch (err) {
            fail++;
            firstErr = firstErr || (err instanceof Error ? err.message : "실패");
          }
          done++;
          setUnitProg({ done, total: todo.length, fail });
        }
      }),
    );
    if (firstErr) setUnitNote(`${fail}개는 단원을 못 읽었어요: ${firstErr}`);
    setUnitBusy("");
  }

  const unitTokens = normU(unitQuery) ? unitQuery.trim().split(/\s+/).map(normU).filter(Boolean) : [];
  const unitHits = unitTokens.length ? unitRows.filter((r) => r.unit && unitTokens.every((t) => normU(r.unit!).includes(t))) : [];
  const unitLabeled = unitRows.filter((r) => r.unit).length;
  function addUnitHits(rows: UnitRow[]) {
    setPicked((m) => {
      const n = { ...m };
      for (const r of rows) n[`p:${r.id}`] = unitItem(r);
      return n;
    });
  }

  async function onFiles(files: FileList | null) {
    if (!files) return;
    const out: Item[] = [];
    for (const f of Array.from(files)) {
      try {
        out.push({ key: `up:${f.name}:${f.size}:${f.lastModified}`, label: f.name, src: await fileToDataUrl(f) });
      } catch {
        setError(`${f.name} 을(를) 열지 못했어요.`);
      }
    }
    setUploads((u) => [...u, ...out]);
  }

  const items: Item[] = [...Object.values(picked), ...uploads];

  function patch(key: string, p: Partial<Run>) {
    setRuns((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  }

  /** 변형문제 폴더(= is_variant 묶음)를 (없으면 만들어) 돌려준다. 서버 작업들이 동시에 만들다 겹치지 않게 미리 한다. */
  async function ensureTarget(uid: string): Promise<string> {
    if (saveTarget) return saveTarget;
    const d = new Date();
    const stamp = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const name = newFolder.trim() || `변형 묶음 ${stamp}`;
    const existing = cats.find((c) => c.is_variant && c.source === name);
    if (existing) return existing.id;
    const { data, error: e } = await supabase
      .from("categories")
      .insert({ user_id: uid, source: name, is_exam: false, score: null, exam_date: null, folder_id: null, is_variant: true })
      .select("id,source,folder_id,is_variant")
      .single();
    if (e) throw e;
    setCats((c) => [data as Cat, ...c]);
    setSaveTarget((data as Cat).id);
    return (data as Cat).id;
  }

  async function start() {
    if (!items.length) return;
    setError(null);
    setBusy(true);
    const all: Run[] = [];
    for (const it of items) for (let k = 1; k <= copies; k++) all.push({ key: `${it.key}#${k}`, label: it.label, copy: k, stage: "prep" });
    setRuns(all);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) throw new Error("로그인이 필요해요.");
      const targetId = await ensureTarget(uid);
      // 원본 준비(줄이기)는 4개씩, 서버에 넣는 건 곧바로 — 이후는 서버 대기열이 돌린다(창을 닫아도 계속).
      const warmRef: { current: Promise<unknown> | null } = { current: null };
      const queue = [...items];
      await Promise.all(
        Array.from({ length: Math.min(4, queue.length) }, async () => {
          for (let it = queue.shift(); it; it = queue.shift()) {
            const item = it;
            let original: string;
            let size: { width: number; height: number } | null = null;
            try {
              original = await prepareProblemForModel(await ensureDataUrl(item.src));
              size = await imageSizeOf(original);
            } catch (err) {
              for (let k = 1; k <= copies; k++) {
                patch(`${item.key}#${k}`, { stage: "error", error: err instanceof Error ? err.message : "원본을 열지 못했어요." });
              }
              continue;
            }
            for (let k = 1; k <= copies; k++) patch(`${item.key}#${k}`, { original, stage: "queued" });
            void Promise.all(
              Array.from({ length: copies }, async (_, i) => {
                const k = i + 1;
                const key = `${item.key}#${k}`;
                const t0 = Date.now();
                try {
                  // 같은 원본의 두 번째 변형부터는 잠깐 늦게 낸다 — 첫 요청이 지시문+원본 그림을 읽어 두어야
                  // 뒤 요청이 OpenAI 프롬프트 캐시(입력 단가 대폭 할인)에 맞는다. 동시에 내면 전부 캐시 미스다.
                  // 이번 실행에서 맨 처음 나가는 요청 하나만 먼저 보내고 나머지는 25초 뒤에 낸다 — 지시문(약 2천 토큰)은
                  // 원본이 달라도 같아서, 처음 요청이 읽어 두면 다른 원본·다른 변형도 그 앞부분이 캐시에 맞는다.
                  if (!warmRef.current) {
                    warmRef.current = new Promise((r) => setTimeout(r, 25_000));
                  } else {
                    await warmRef.current;
                    if (k > 1) await new Promise((r) => setTimeout(r, 2_000 * (k - 1)));
                  }
                  const out = await runAiTask<VariantResult>("variant", {
                    label: `변형 · ${item.label}${copies > 1 ? ` (${k}/${copies})` : ""}`,
                    images: [original],
                    params: {
                      effort: SOL_EFFORT,
                      quality: "",
                      level,
                      novelty,
                      copies,
                      copy: k,
                      categoryId: targetId,
                      no: item.no ?? null,
                      srcKey: item.key,
                      srcLabel: item.label,
                      width: size?.width,
                      height: size?.height,
                    },
                  });
                  patch(key, { stage: "done", result: out.result, ms: Date.now() - t0 });
                } catch (err) {
                  patch(key, { stage: "error", error: err instanceof Error ? err.message : "실패했습니다.", ms: Date.now() - t0 });
                }
              }),
            );
          }
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : (err as { message?: string })?.message ?? "시작하지 못했어요.");
    }
    // 화면은 결과를 기다리지만, 서버 작업은 이 화면을 닫아도 계속 돌아 폴더에 저장된다.
    setBusy(false);
  }

  const stageText: Record<Run["stage"], string> = {
    prep: "준비 중",
    queued: "서버에서 변형을 설계하고 그리는 중 (창을 닫아도 계속돼요)",
    done: "완료 · 폴더에 저장됨",
    error: "실패",
  };
  const totalJobs = items.length * copies;
  const doneN = runs.filter((r) => r.stage === "done").length;
  const sumKrw = runs.reduce((a, r) => a + (r.result?.estKrw ?? 0), 0);

  useEffect(() => {
    if (!libId) {
      setLibRows([]);
      return;
    }
    void (async () => {
      const { data } = await supabase
        .from("problems")
        .select("id,image_path,answer,no:box_range->number,solution:box_range->>solution")
        .eq("category_id", libId)
        .order("sort_order", { ascending: true });
      setLibRows((data as unknown as typeof libRows) ?? []);
    })();
  }, [libId, tab, supabase]);

  async function renameFolder(id: string) {
    const cur = cats.find((c) => c.id === id)?.source ?? "";
    const name = window.prompt("폴더 이름", cur)?.trim();
    if (!name || name === cur) return;
    const { error: e } = await supabase.from("categories").update({ source: name }).eq("id", id);
    if (e) return setError(e.message);
    setCats((cs) => cs.map((c) => (c.id === id ? { ...c, source: name } : c)));
  }
  async function deleteFolder(id: string) {
    if (!window.confirm("이 변형문제 폴더와 안의 문제를 모두 지울까요?")) return;
    const { error: e } = await supabase.from("categories").delete().eq("id", id);
    if (e) return setError(e.message);
    setCats((cs) => cs.filter((c) => c.id !== id));
    if (libId === id) setLibId("");
    if (saveTarget === id) setSaveTarget("");
  }
  async function deleteRow(id: string) {
    if (!window.confirm("이 변형문제를 지울까요?")) return;
    const { error: e } = await supabase.from("problems").delete().eq("id", id);
    if (e) return setError(e.message);
    setLibRows((r) => r.filter((x) => x.id !== id));
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        <Button variant={tab === "make" ? "dark" : "outline"} size="sm" onClick={() => setTab("make")}>
          만들기
        </Button>
        <Button variant={tab === "library" ? "dark" : "outline"} size="sm" onClick={() => setTab("library")}>
          모아보기 ({variantFolders.length})
        </Button>
      </div>

      {tab === "library" && (
        <section className={cn(cardClass, "flex flex-col gap-3 p-4 sm:p-5")}>
          <h2 className="text-sm font-semibold text-ink">변형문제 폴더</h2>
          {variantFolders.length === 0 && <p className="text-sm text-slate-500">아직 폴더가 없어요. 만들기에서 변형문제를 만들면 생겨요.</p>}
          <div className="flex flex-wrap gap-2">
            {variantFolders.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setLibId(c.id)}
                className={cn("rounded-full border px-3 py-1 text-sm", libId === c.id ? "border-blue-500 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-700")}
              >
                📁 {c.source}
              </button>
            ))}
          </div>
          {libId && (
            <>
              <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
                <span>{libRows.length}문제</span>
                <button className="underline" onClick={() => void renameFolder(libId)}>
                  이름 바꾸기
                </button>
                <button className="underline text-red-600" onClick={() => void deleteFolder(libId)}>
                  폴더 지우기
                </button>
                <a className="underline" href={`/export?ids=${libId}`}>
                  PDF 내보내기 (해설 포함)
                </a>
                <a className="underline" href={`/categories/${libId}`}>
                  실모처럼 열어 수정
                </a>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {libRows.map((r) => (
                  <div key={r.id} className="flex flex-col gap-1 rounded-lg border border-slate-200 p-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={cardUrl(r.image_path)} alt="" className="w-full rounded" loading="lazy" />
                    <div className="flex items-center justify-between text-xs text-slate-600">
                      <span>
                        {r.no != null ? `${r.no}번 · ` : ""}정답 {r.answer ?? "?"}
                      </span>
                      <button className="text-red-600 underline" onClick={() => void deleteRow(r.id)}>
                        지우기
                      </button>
                    </div>
                    {r.solution && (
                      <details className="text-xs text-slate-600">
                        <summary className="cursor-pointer">해설</summary>
                        <pre className="whitespace-pre-wrap">{r.solution}</pre>
                      </details>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {tab === "make" && (<>
      <section className={cn(cardClass, "flex flex-col gap-3 p-4 sm:p-5")}>
        <h2 className="text-sm font-semibold text-ink">유형별 원본 가져오기 (단원 검색)</h2>
        <p className="text-xs text-slate-500">
          과목 폴더 안 모든 문항의 단원을 luna 가 읽어 적어 두고(문제당 한 번, 약 1원 — 한 번 적으면 다시 검색할 땐 무료), 입력한 단원명이 든 문제를 찾아 아래 원본으로 담아요.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm"
            value={unitFolder}
            onChange={(e) => {
              setUnitFolder(e.target.value);
              setUnitRows([]);
              setUnitProg(null);
              setUnitNote(null);
            }}
          >
            <option value="">과목 폴더 고르기</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
            <option value="_none">(폴더 없음)</option>
          </select>
          <Button size="sm" variant="outline" disabled={!unitFolder || unitBusy !== ""} onClick={() => void loadUnitRows()}>
            {unitBusy === "load" ? "불러오는 중…" : "문항 불러오기"}
          </Button>
          {unitRows.length > 0 && (
            <>
              <span className="text-xs text-slate-600">
                {unitRows.length}문항 · 단원 표지 {unitLabeled}개
              </span>
              {unitLabeled < unitRows.length && (
                <Button size="sm" disabled={unitBusy !== ""} onClick={() => void labelMissing()}>
                  {unitBusy === "label" ? "단원 읽는 중…" : `단원 읽기 (${unitRows.length - unitLabeled}개, luna)`}
                </Button>
              )}
              {unitBusy === "label" && (
                <button className="text-xs underline" onClick={() => (unitCancel.current = true)}>
                  멈추기
                </button>
              )}
            </>
          )}
        </div>
        {unitProg && (
          <p className="text-xs text-slate-600">
            {unitProg.done}/{unitProg.total} 읽음{unitProg.fail > 0 && ` · 실패 ${unitProg.fail}`}
          </p>
        )}
        {unitNote && <p className="text-xs text-red-600">{unitNote}</p>}
        {unitRows.length > 0 && (
          <>
            <input
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
              value={unitQuery}
              onChange={(e) => setUnitQuery(e.target.value)}
              placeholder="단원명 검색 (예: 판 구조론, 이차함수 · 여러 단어는 모두 들어간 것만)"
            />
            {unitTokens.length > 0 && (
              <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
                <span>{unitHits.length}문항 찾음</span>
                {unitHits.length > 0 && (
                  <button className="underline" onClick={() => addUnitHits(unitHits)}>
                    찾은 {unitHits.length}문항 모두 원본으로 담기
                  </button>
                )}
                {unitLabeled < unitRows.length && <span>(단원 표지가 없는 {unitRows.length - unitLabeled}문항은 아직 검색에 안 나와요)</span>}
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {unitHits.slice(0, 60).map((r) => {
                const on = !!picked[`p:${r.id}`];
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() =>
                      setPicked((m) => {
                        const n = { ...m };
                        if (n[`p:${r.id}`]) delete n[`p:${r.id}`];
                        else n[`p:${r.id}`] = unitItem(r);
                        return n;
                      })
                    }
                    className={cn("flex flex-col gap-1 rounded-lg border p-2 text-left", on ? "border-blue-500 bg-blue-50" : "border-slate-200 bg-white")}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={cardUrl(r.image_path)} alt="" className="w-full rounded" loading="lazy" />
                    <span className="text-xs font-medium text-ink">
                      {on ? "✓ " : ""}
                      {catName(r.catId)} {r.no != null ? `${r.no}번` : ""}
                    </span>
                    <span className="text-[11px] leading-snug text-slate-500">{r.unit}</span>
                  </button>
                );
              })}
            </div>
            {unitHits.length > 60 && <p className="text-xs text-slate-500">앞 60문항만 보여요(모두 담기는 전체에 적용돼요).</p>}
          </>
        )}
      </section>

      <section className={cn(cardClass, "flex flex-col gap-3 p-4 sm:p-5")}>
        <h2 className="text-sm font-semibold text-ink">1. 원본 문제 고르기 (여러 폴더·실모에서 모아 담을 수 있어요)</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs text-slate-500">
            폴더
            <select
              className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-sm text-ink"
              value={folderId}
              onChange={(e) => {
                setFolderId(e.target.value);
                setCatId("");
              }}
            >
              <option value="">전체</option>
              <option value="_none">폴더 없음</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-500">
            실모
            <select
              className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-sm text-ink"
              value={catId}
              onChange={(e) => setCatId(e.target.value)}
            >
              <option value="">선택…</option>
              {shownCats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.source}
                </option>
              ))}
            </select>
          </label>
        </div>

        {probs.length > 0 && (
          <>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <button className="underline" onClick={() => setAllHere(true)}>
                이 실모 전체 담기
              </button>
              <button className="underline" onClick={() => setAllHere(false)}>
                이 실모 빼기
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {probs.map((p) => {
                const on = !!picked[`p:${p.id}`];
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => toggle(p)}
                    className={cn(
                      "overflow-hidden rounded-lg border bg-white text-left",
                      on ? "border-blue-500 ring-2 ring-blue-200" : "border-slate-200",
                    )}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={cardUrl(p.image_path)} alt="" className="h-28 w-full object-cover object-top" loading="lazy" />
                    <div className="px-2 py-1 text-xs text-slate-600">{p.problemNo != null ? `${p.problemNo}번` : "번호 없음"}</div>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {Object.keys(picked).length > 0 && (
          <div className="rounded-lg bg-slate-50 p-2 text-xs text-slate-600">
            <div className="mb-1 flex items-center justify-between">
              <b>담은 문제 {Object.keys(picked).length}개</b>
              <button className="underline" onClick={() => setPicked({})}>
                모두 비우기
              </button>
            </div>
            <ul className="flex flex-wrap gap-1">
              {Object.values(picked).map((it) => (
                <li key={it.key} className="rounded-full bg-white px-2 py-0.5">
                  {it.label}{" "}
                  <button
                    className="text-slate-400"
                    onClick={() =>
                      setPicked((m) => {
                        const n = { ...m };
                        delete n[it.key];
                        return n;
                      })
                    }
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="border-t border-slate-100 pt-3">
          <label className="flex flex-col gap-1 text-xs text-slate-500">
            또는 문제 사진 올리기(여러 장 가능)
            <input type="file" accept="image/*" multiple onChange={(e) => void onFiles(e.target.files)} className="text-sm" />
          </label>
          {uploads.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-2 text-xs text-slate-600">
              {uploads.map((u) => (
                <li key={u.key} className="rounded-full bg-slate-100 px-2 py-1">
                  {u.label}{" "}
                  <button className="text-slate-400" onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className={cn(cardClass, "flex flex-wrap items-center gap-3 p-4 sm:p-5")}>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          문제당 변형 수
          <select className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm" value={copies} onChange={(e) => setCopies(Number(e.target.value))}>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}개
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          난이도
          <select className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm" value={level} onChange={(e) => setLevel(e.target.value as VariantLevel)}>
            {(Object.keys(LEVEL_LABEL) as VariantLevel[]).map((k) => (
              <option key={k} value={k}>
                {LEVEL_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          새로운 정도
          <select className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm" value={novelty} onChange={(e) => setNovelty(e.target.value as VariantNovelty)}>
            {(["same", "slight", "new"] as VariantNovelty[]).map((k) => (
              <option key={k} value={k}>
                {NOVELTY_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">sol 설계 medium · 그림 auto (고정)</span>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          저장할 묶음
          <select className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm" value={saveTarget} onChange={(e) => setSaveTarget(e.target.value)}>
            <option value="">+ 새 묶음 만들기</option>
            {variantFolders.map((c) => (
              <option key={c.id} value={c.id}>
                {c.source}
              </option>
            ))}
          </select>
        </label>
        {!saveTarget && (
          <input
            className="w-40 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm"
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
            placeholder="묶음 이름 (비우면 날짜·시간)"
          />
        )}
        <Button onClick={() => void start()} disabled={busy || items.length === 0 || totalJobs > 60}>
          {busy ? "서버에 넣는 중…" : `변형문제 만들기 (${totalJobs}개)`}
        </Button>
        <p className="w-full text-xs text-slate-500">
          서버 대기열에서 돌아요(수정하기와 같은 부분 수정 방식 — 창을 닫아도 끝까지 가서 고른 묶음 하나에 모두 저장돼요(원본 실모별로 나누지 않아요)). 한 번에 최대 60개. 토큰은 안 떼고 원가만 보여요(시험 중).
          {totalJobs > 60 && <b className="text-red-600"> 지금 {totalJobs}개라 너무 많아요.</b>}
        </p>
        {runs.length > 0 && (
          <p className="w-full text-xs text-slate-600">
            {doneN}/{runs.length} 완료 {sumKrw > 0 && `· 원가 ${won(sumKrw)}`}
          </p>
        )}
      </section>

      {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {runs.map((r) => (
        <section key={r.key} className={cn(cardClass, "flex flex-col gap-3 p-4 sm:p-5")}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-ink">
              {r.label}
              {copies > 1 && ` · 변형 ${r.copy}`}
              {r.result?.kind && <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-normal text-slate-600">{KIND_LABEL[r.result.kind] ?? r.result.kind}</span>}
            </h3>
            <span className={cn("text-xs", r.stage === "error" ? "text-red-600" : r.stage === "done" ? "text-emerald-600" : "text-slate-500")}>
              {stageText[r.stage]}
              {r.result?.estKrw ? ` · ${won(r.result.estKrw)}` : ""}
              {r.ms != null && ` · ${(r.ms / 1000).toFixed(0)}초`}
            </span>
          </div>
          {r.error && <p className="text-sm text-red-700">{r.error}</p>}
          {(r.original || r.result) && (
            <div className="grid gap-3 sm:grid-cols-2">
              <figure className="flex flex-col gap-1">
                <figcaption className="text-xs text-slate-500">원본</figcaption>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {r.original && <img src={r.original} alt="원본" className="w-full rounded border border-slate-200" />}
              </figure>
              <figure className="flex flex-col gap-1">
                <figcaption className="text-xs text-slate-500">변형</figcaption>
                {r.result ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={cardUrl(r.result.imagePath)} alt="변형" className="w-full rounded border border-blue-200" />
                ) : (
                  <div className="flex h-32 items-center justify-center rounded border border-dashed border-slate-300 text-xs text-slate-400">
                    {r.error ? "만들지 못했어요" : "만드는 중…"}
                  </div>
                )}
              </figure>
            </div>
          )}
          {r.result?.review && (
            <div
              className={cn(
                "rounded-lg border px-3 py-2 text-xs",
                r.result.review.skipped ? "border-slate-200 bg-slate-50 text-slate-600" : r.result.review.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-300 bg-amber-50 text-amber-900",
              )}
            >
              <b>제작 검수 · </b>
              {r.result.review.skipped
                ? r.result.review.skipped
                : r.result.review.ok
                  ? `기획대로 나왔어요(sol 이 푼 정답 ${r.result.review.solvedAnswer || "?"})`
                  : `${r.result.review.issues.length}건 지적${r.result.review.fixed ? " — 고칠 수 있는 곳은 한 번 고쳤어요(다시 검수는 안 함)" : ""}${
                      r.result.review.answerMatches ? "" : ` · 정답 불일치(기획 ${r.result.newAnswer} / sol 이 푼 값 ${r.result.review.solvedAnswer})`
                    }${r.result.review.trapsKept ? "" : " · 함정 요소가 빠졌을 수 있어요"}${r.result.review.settingsOk ? "" : " · 난이도/새로움이 설정과 다를 수 있어요"}`}
              {r.result.review.issues.length > 0 && (
                <ul className="mt-1 list-disc pl-5">
                  {r.result.review.issues.map((i, n) => (
                    <li key={n}>
                      [{i.kind}] {i.where && `${i.where}: `}
                      {i.problem}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {r.result && (
            <details className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
              <summary className="cursor-pointer text-xs font-semibold text-slate-600">sol 이 이해한 것 · 바꾼 값 · 새 정답 · 해설</summary>
              <p className="mt-2">{r.result.summary}</p>
              {r.result.traps && r.result.traps.length > 0 && (
                <p className="mt-2 text-xs">
                  <b>그대로 살린 함정:</b> {r.result.traps.join(" / ")}
                </p>
              )}
              <ul className="mt-2 list-disc pl-5 text-xs">
                {r.result.changes.map((c, i) => (
                  <li key={i}>
                    <b>{c.from}</b> → <b>{c.to}</b>
                    {c.why && <span className="text-slate-500"> — {c.why}</span>}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs">
                정답: {r.result.originalAnswer || "?"} → <b>{r.result.newAnswer || "?"}</b>
              </p>
              {r.result.solution && <pre className="mt-1 whitespace-pre-wrap text-xs text-slate-600">{r.result.solution}</pre>}
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-slate-500">그림 모델에 보낸 편집 지시</summary>
                <pre className="mt-1 whitespace-pre-wrap text-xs">{r.result.edits}</pre>
              </details>
            </details>
          )}
        </section>
      ))}
      </>)}
    </div>
  );
}
