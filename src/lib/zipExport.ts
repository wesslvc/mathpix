/**
 * 문제 이미지 ZIP 내보내기의 **계획**(파일 이름·폴더·정답 CSV). 네트워크도 DOM 도 안 건드리는 순수 함수라
 * 화면(`ZipExportPanel`)이 이미지를 받아 묶기 전에 무엇이 어디에 들어갈지를 여기서 정한다.
 */

export type ZipItem = {
  id: string;
  imageUrl: string;
  /** 출처(실모 이름). */
  source: string;
  /** 문제 번호. 모르면 null — 그때는 실모 안에서의 차례를 쓴다. */
  number: number | null;
  /** 정답(객관식이면 ①~⑤). 안 적어 둔 문제는 빈 글. */
  answer: string;
  /** 내가 잘못 쓴 답. 틀렸을 때만 있다. */
  picked: string;
  /** 국어 지문이면 true — 번호도 정답도 없다. */
  passage: boolean;
  /** 국어 지문 제목. */
  passageTitle?: string;
  /** 변형문제와 함께 내보내는 **원본** 문제면 true. */
  original?: boolean;
};

export type ZipEntry = {
  /** ZIP 안 경로(폴더/파일). */
  path: string;
  item: ZipItem;
  /** CSV 에 적을 문제 번호(없으면 빈 글). */
  numberText: string;
};

/** 파일·폴더 이름에 못 쓰는 글자를 바꾼다(윈도우 기준으로 가장 엄격하게). */
export function safeName(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    // 윈도우는 이름 끝의 점·공백을 지운다.
    .replace(/[. ]+$/, "")
    .slice(0, 60);
  return cleaned || fallback;
}

/**
 * 출력 차례(`items` 순서)대로 파일 이름을 정한다.
 *
 * - `byFolder` 가 켜져 있으면 출처마다 폴더를 만든다(같은 이름의 출처는 `(2)` 를 붙여 가른다).
 * - 파일 이름은 `실모 안 차례_번호번.png` — 차례가 앞에 있어 파일 탐색기에서 정렬해도 인쇄 순서가 유지된다.
 * - 국어 지문은 `차례_지문_제목.png`.
 */
export function planZip(items: ZipItem[], byFolder: boolean): ZipEntry[] {
  // 출처 → 폴더 이름. 이름이 겹치면(서로 다른 폴더의 같은 이름 실모) 가른다.
  const folderOf = new Map<string, string>();
  const used = new Set<string>();
  if (byFolder) {
    for (const it of items) {
      if (folderOf.has(it.source)) continue;
      const base = safeName(it.source, "출처");
      let name = base;
      for (let n = 2; used.has(name); n++) name = `${base} (${n})`;
      used.add(name);
      folderOf.set(it.source, name);
    }
  }

  const perSource = new Map<string, number>();
  const total = new Map<string, number>();
  for (const it of items) total.set(it.source, (total.get(it.source) ?? 0) + 1);

  return items.map((item) => {
    const seq = (perSource.get(item.source) ?? 0) + 1;
    perSource.set(item.source, seq);
    // 한 폴더에 몇 개가 들어가는지에 맞춰 0 을 채운다(최소 두 자리).
    const width = Math.max(2, String(byFolder ? total.get(item.source) : items.length).length);
    const prefix = String(byFolder ? seq : items.indexOf(item) + 1).padStart(width, "0");
    const body = item.passage
      ? `지문${item.passageTitle?.trim() ? `_${safeName(item.passageTitle, "")}` : ""}`
      : item.number != null
        ? `${item.number}번`
        : "번호없음";
    const tagged = item.original ? `원본_${body}` : body;
    const file = `${prefix}_${tagged}.png`;
    const folder = byFolder ? folderOf.get(item.source) : null;
    return {
      path: folder ? `${folder}/${file}` : file,
      item,
      numberText: item.passage || item.number == null ? "" : String(item.number),
    };
  });
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * 정답 CSV. 엑셀이 한글을 깨뜨리지 않게 **BOM** 을 앞에 붙이고 줄 끝은 CRLF 로 쓴다.
 * 정답을 안 적어 둔 문제도 줄은 남긴다(어느 문제에 답이 없는지 보여야 한다).
 */
export function answersCsv(entries: ZipEntry[]): string {
  const head = ["파일", "실모", "구분", "문제번호", "정답", "내가 고른 답"];
  const rows = entries.map(({ path, item, numberText }) => [
    path,
    item.source,
    item.passage ? "지문" : item.original ? "원본" : "문제",
    numberText,
    item.passage ? "" : item.answer,
    item.passage ? "" : item.picked,
  ]);
  const body = [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
  return `﻿${body}\r\n`;
}
