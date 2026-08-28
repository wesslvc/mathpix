/**
 * "이미지 여러 장 + 정답 CSV로 한 번에 올리기" 매칭 로직.
 *
 * 화면의 미리보기(BulkMappedImportPanel)와 서버 라우트
 * (/api/bulk-import-mapped)가 같은 판정을 써야 한다 — 다르면 화면엔
 * "매칭 95개"라고 나오는데 서버는 다르게 세는 일이 생긴다. 그래서 이 파일에는
 * 네트워크 호출도 환경변수도 없다(problemBoxes.ts·gradeSummary.ts와 같은
 * 이유 — 브라우저에도, 서버(Node)에도 그대로 실려야 한다).
 */

export type MatchedItem = { name: string; answer: string };
export type SkippedItem = { name: string; reason: string };

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

/** "수능 2점 테스트"/"수능 3점 테스트" 같은 표기를 파일명의 "2점"/"3점"과 맞춘다. */
function normGubun(g: string): string {
  const t = g.trim();
  if (t === "수능 2점 테스트") return "2점";
  if (t === "수능 3점 테스트") return "3점";
  return t;
}

/**
 * CSV를 읽는다. BOM 유무·따옴표 없는 단순 CSV만 다룬다(새 의존성을 넣을
 * 정도의 일이 아니다).
 */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",").map((c) => c.trim());
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

/**
 * 파일명에서 매칭 키를 뽑는다(예: `수능특강_08강_3점_05번.png`,
 * `수능완성_실전모의고사3회_07번.png`). 형태가 다르면 null.
 */
export function keyFromFilename(filename: string): string | null {
  const name = filename.replace(IMAGE_EXT, "");
  const parts = name.split("_");
  if (parts.length === 4) {
    const [textbook, unitRaw, gubun, noRaw] = parts;
    const unitNum = unitRaw.match(/^0*(\d+)강$/);
    const noNum = noRaw.match(/^0*(\d+)번$/);
    if (!unitNum || !noNum) return null;
    return `${textbook}|${unitNum[1]}강|${gubun}|${noNum[1]}`;
  }
  if (parts.length === 3) {
    const [textbook, unitRaw, noRaw] = parts;
    const m = unitRaw.match(/^실전모의고사(\d+)회$/);
    const noNum = noRaw.match(/^0*(\d+)번$/);
    if (!m || !noNum) return null;
    return `${textbook}|실전 모의고사 ${m[1]}회||${noNum[1]}`;
  }
  return null;
}

function buildAnswerMap(rows: Record<string, string>[]): {
  byKey: Map<string, string>;
  byFilename: Map<string, string>;
} {
  const byKey = new Map<string, string>();
  const byFilename = new Map<string, string>();
  for (const row of rows) {
    if (row["교재"] && row["단원"] && row["문항번호"] && row["정답"]) {
      const key = `${row["교재"]}|${row["단원"]}|${normGubun(row["구분"] ?? "")}|${row["문항번호"]}`;
      byKey.set(key, row["정답"]);
    }
    // 파일명 규칙이 안 맞는 자료도 받을 수 있게 "파일명,정답" 두 컬럼짜리
    // CSV도 함께 지원한다.
    const filenameCol = row["파일명"] ?? row["filename"];
    if (filenameCol && row["정답"]) {
      byFilename.set(filenameCol.replace(IMAGE_EXT, ""), row["정답"]);
    }
  }
  return { byKey, byFilename };
}

/** 하나라도 안 맞으면 그 파일만 건너뛴다(전체를 막지 않는다). */
export function matchFiles(
  filenames: string[],
  csvRows: Record<string, string>[],
): { plan: MatchedItem[]; skipped: SkippedItem[] } {
  const { byKey, byFilename } = buildAnswerMap(csvRows);
  const plan: MatchedItem[] = [];
  const skipped: SkippedItem[] = [];
  for (const name of filenames) {
    const stem = name.replace(IMAGE_EXT, "");
    const byName = byFilename.get(stem);
    if (byName) {
      plan.push({ name, answer: byName });
      continue;
    }
    const key = keyFromFilename(name);
    const byMapped = key ? byKey.get(key) : undefined;
    if (byMapped) {
      plan.push({ name, answer: byMapped });
      continue;
    }
    skipped.push({ name, reason: key ? "CSV에 없는 조합" : "파일명 규칙을 못 읽음" });
  }
  return { plan, skipped };
}
