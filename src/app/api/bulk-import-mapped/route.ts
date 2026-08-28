import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { matchFiles, parseCsv } from "@/lib/bulkImportMatch";
import { toStoredFigures } from "@/lib/storedFigures";
import type { CardFigure } from "@/lib/cardHtml";
import { DEFAULT_FONT_PT } from "@/lib/fontSize";
import type { DiagramLayout } from "@/lib/diagramLayout";

export const runtime = "nodejs";
// 파일 수십~백 장을 순서대로 올리다 보니(장당 스토리지 업로드 1번 + DB
// insert 1번) 60초를 넘길 수 있다 — /api/figure와 같은 이유로 넉넉히 둔다.
export const maxDuration = 300;

/** 통째로 넣는 이미지의 배치(AddProblemFlow·BatchSplitPanel과 같은 값). */
const WHOLE_LAYOUT: DiagramLayout = { scale: 100, offsetX: 0, offsetY: 0 };

/** PNG 헤더에서 가로/세로만 읽는다(외부 이미지 라이브러리 없이). */
function pngSize(buffer: Buffer): { width: number; height: number } | null {
  if (
    buffer.length < 24 ||
    buffer[0] !== 0x89 ||
    buffer[1] !== 0x50 ||
    buffer[2] !== 0x4e ||
    buffer[3] !== 0x47
  ) {
    return null;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** rasterToSvg(figureImage.ts)와 정확히 같은 형태 — 다르면 readStoredFigures가 버린다. */
function rasterToSvgDataUrl(buffer: Buffer, width: number, height: number): string {
  const dataUrl = `data:image/png;base64,${buffer.toString("base64")}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${width} ${height}">` +
    `<image href="${dataUrl}" xlink:href="${dataUrl}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet"/>` +
    `</svg>`
  );
}

/**
 * 이미 깔끔하게 잘려 있는 사진(학원가 "연계교재 선별" 스크린샷 등) 여러 장을
 * 정답 CSV와 매칭해서 사용자 본인 계정의 실모에 그대로 저장한다.
 *
 * **왜 서버 라우트인가**: 처음엔 브라우저에서 카드를 다시 그려(캔버스) 나머지
 * 문제들과 같은 모양으로 만들려 했는데, 사용자가 터미널도 못 쓰는 모바일이라
 * 그 복잡한 캔버스 경로를 실기기에서 검증하기 어려웠다. 이 자료는 애초에
 * 크롭할 것도 인식할 것도 없어서(그림 한 장이 곧 카드) 서버가 PNG 헤더만
 * 읽어 그대로 저장하는 편이 훨씬 단순하고 견고하다.
 *
 * **서비스 키가 필요 없다.** 이 요청은 사용자 본인의 로그인 세션(쿠키)으로
 * 인증하므로 RLS를 그대로 지킨다 — 스토리지 경로도 `auth.uid()`가 첫 조각이어야
 * 하는 정책을 그대로 만족한다. 관리자 권한을 쓰지 않아도 되는 일에 서비스
 * 키를 꺼낼 이유가 없다.
 *
 * **한 번에 다 안 보낸다.** Vercel Serverless Function은 요청 본문이
 * 4.5MB로 제한돼 있다(문제 영역 자동 찾기와 같은 제약). 화면이 파일을
 * 여러 묶음으로 나눠 보내므로, 이 라우트는 "지금 이 묶음"만 처리하고
 * 그때그때 sort_order 최댓값을 다시 읽는다.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const formData = await request.formData();
  const categoryId = formData.get("categoryId");
  const csvFile = formData.get("csv");
  const imageFiles = formData.getAll("images").filter((f): f is File => f instanceof File);

  if (typeof categoryId !== "string" || !categoryId) {
    return NextResponse.json({ error: "categoryId가 없습니다." }, { status: 400 });
  }
  if (!(csvFile instanceof File)) {
    return NextResponse.json({ error: "정답 CSV가 없습니다." }, { status: 400 });
  }
  if (imageFiles.length === 0) {
    return NextResponse.json({ error: "이미지 파일이 없습니다." }, { status: 400 });
  }

  // 이 실모가 정말 이 사용자 것인지 먼저 확인한다 — RLS가 어차피 막지만,
  // 여기서 확인해야 "권한 없음"을 분명한 오류로 돌려줄 수 있다.
  const { data: category, error: categoryError } = await supabase
    .from("categories")
    .select("id")
    .eq("id", categoryId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (categoryError || !category) {
    return NextResponse.json({ error: "실모를 찾을 수 없습니다." }, { status: 404 });
  }

  const csvText = await csvFile.text();
  const rows = parseCsv(csvText);
  const { plan, skipped } = matchFiles(
    imageFiles.map((f) => f.name),
    rows,
  );
  const fileByName = new Map(imageFiles.map((f) => [f.name, f]));

  const { data: maxRow } = await supabase
    .from("problems")
    .select("sort_order")
    .eq("category_id", categoryId)
    .order("sort_order", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  let nextOrder = (maxRow?.sort_order ?? 0) + 1;

  const failed: string[] = [];
  let ok = 0;

  for (const item of plan) {
    const file = fileByName.get(item.name);
    if (!file) continue;

    const buffer = Buffer.from(await file.arrayBuffer());
    const size = pngSize(buffer);
    if (!size) {
      failed.push(`${item.name} — PNG 파일이 아닙니다`);
      continue;
    }

    const path = `${user.id}/${categoryId}/${randomUUID()}.png`;
    const { error: uploadError } = await supabase.storage
      .from("problem-images")
      .upload(path, buffer, { contentType: "image/png" });
    if (uploadError) {
      failed.push(`${item.name} — 업로드 실패: ${uploadError.message}`);
      continue;
    }

    const figure: CardFigure = {
      id: randomUUID(),
      markup: rasterToSvgDataUrl(buffer, size.width, size.height),
      layout: WHOLE_LAYOUT,
      position: 0,
    };

    const { error: insertError } = await supabase.from("problems").insert({
      category_id: categoryId,
      user_id: user.id,
      image_path: path,
      latex: null,
      text_content: null,
      answer: item.answer || null,
      answer_type: /^\d+$/.test(item.answer.trim()) ? "choice" : "short",
      sort_order: nextOrder,
      box_range: {
        ranges: null,
        fontPt: DEFAULT_FONT_PT,
        figures: toStoredFigures([figure]),
      },
    });
    if (insertError) {
      await supabase.storage.from("problem-images").remove([path]);
      failed.push(`${item.name} — 저장 실패: ${insertError.message}`);
      continue;
    }

    nextOrder++;
    ok++;
  }

  return NextResponse.json({ ok, failed, skipped });
}
