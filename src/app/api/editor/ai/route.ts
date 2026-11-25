import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { askSol } from "@/lib/problemLoopRun";
import { parseJsonObject } from "@/lib/problemCompare";
import { logAiCost, solTokens } from "@/lib/costLog";
import { cleanSvg, readDoc } from "@/lib/editor/doc";
import { stripMedia } from "@/lib/editor/blocks";
import { DRAFT_PROMPT, REVIEW_PROMPT, REVISE_PROMPT, SVG_PROMPT } from "@/lib/editor/prompts";
import { requireEditor } from "../auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const EFFORT = () => process.env.EDITOR_SOL_EFFORT?.trim() || "high";

/**
 * 문항 제작 AI(sol). `action`:
 *   draft  — 요청(과목·단원·난이도·자유 지시)으로 새 문항 초안
 *   revise — 지금 문항을 지시대로 고침
 *   review — 지금 문항을 풀어 보고 문제점을 짚음(그림이 있으면 PNG 를 함께 받는다)
 *   svg    — 설명(+ 지금 SVG)으로 그림 SVG 를 그림
 */
export async function POST(req: NextRequest) {
  const auth = await requireEditor();
  if (!auth.ok) return auth.response;
  const body = (await req.json().catch(() => null)) as {
    action?: string;
    request?: string;
    instruction?: string;
    doc?: unknown;
    brief?: string;
    baseSvg?: string;
    figurePng?: string;
  } | null;
  const action = String(body?.action ?? "");
  const ctx = { modelIds: [] as string[], deadlineMs: 270_000, tag: "editor" };
  let prompt = "";
  let tail = "";
  const images: string[] = [];
  const docJson = (d: unknown) => {
    const x = readDoc(d, "tmp-0000-0000");
    const { id: _id, updatedAt: _u, figure, blocks, ...rest } = x;
    void _id;
    void _u;
    return JSON.stringify({ ...rest, blocks: stripMedia(blocks).blocks, figure: figure ? { widthPct: figure.widthPct, caption: figure.caption ?? "" } : null });
  };
  if (action === "draft") {
    prompt = DRAFT_PROMPT;
    tail = `\n\nREQUEST\n${String(body?.request ?? "").slice(0, 3000)}`;
  } else if (action === "revise") {
    prompt = REVISE_PROMPT;
    tail = `\n\nCURRENT ITEM\n${docJson(body?.doc)}\n\nINSTRUCTION\n${String(body?.instruction ?? "").slice(0, 3000)}`;
  } else if (action === "review") {
    prompt = REVIEW_PROMPT;
    if (typeof body?.figurePng === "string" && body.figurePng.startsWith("data:image/png;base64,") && body.figurePng.length < 8_000_000) images.push(body.figurePng);
    tail = `\n\nITEM\n${docJson(body?.doc)}`;
  } else if (action === "svg") {
    prompt = SVG_PROMPT;
    const base = typeof body?.baseSvg === "string" ? cleanSvg(body.baseSvg) : null;
    tail = `${base ? `\n\nBASE SVG\n${base.slice(0, 120_000)}` : ""}\n\nDESCRIPTION / INSTRUCTION\n${String(body?.brief ?? "").slice(0, 4000)}`;
  } else {
    return NextResponse.json({ error: "알 수 없는 작업" }, { status: 400 });
  }

  const r = await askSol(prompt, images, ctx, `문항 제작 ${action}`, { effort: EFFORT(), cacheKey: `reprint-editor-${action}`, tail });
  if (r.krw > 0) {
    await logAiCost(createAdminClient(), { userId: auth.userId, jobId: null, kind: "problem", what: `sol 문항 제작 ${action}`, krw: r.krw, tokens: solTokens(r.usage) }).catch(() => undefined);
  }
  const obj = r.text ? (parseJsonObject(r.text) as Record<string, unknown> | null) : null;
  if (!obj) return NextResponse.json({ error: r.fail || "AI 응답을 읽지 못했어요." }, { status: 502 });
  if (action === "svg") {
    const svg = typeof obj.svg === "string" ? cleanSvg(obj.svg) : null;
    if (!svg) return NextResponse.json({ error: "그림 SVG 가 올바르지 않아요. 다시 시도해 주세요." }, { status: 502 });
    return NextResponse.json({ svg, note: typeof obj.note === "string" ? obj.note : "", krw: Math.round(r.krw) });
  }
  return NextResponse.json({ result: obj, krw: Math.round(r.krw) });
}
