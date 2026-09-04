import subsetFont from "subset-font";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument } from "pdf-lib";
import { KICE_FONT_FILES } from "./fonts";
import frames from "../../../public/kice/frames.json";

/**
 * **PC 없이 글꼴을 올린다.**
 *
 * `scripts/upload-kice-fonts.mjs`는 `pyftsubset`(Python)로 미리 잘라 둔
 * 파일을 요구한다 — 컴퓨터가 있어야 한다. 여기서는 원본 TTF를 **그대로**
 * 받아 서버(`/api/admin/kice-font`)에서 `subset-font`(harfbuzz WASM)로 직접
 * 잘라 올린다. 휴대폰 브라우저만으로 끝난다.
 *
 * **(한)신중명조는 한글을 통째로 넣는다.** 정답표의 답과 실모 제목, 이제는
 * 지문 본문까지 사용자가 자유롭게 타이핑하는 글이라 미리 셀 수 없다 — 이
 * 파일에 대해서만은 "필요한 글자만" 대신 "완성형 한글 전체"를 남긴다.
 * 나머지 넷(신그래픽체·디나루·견명조·태고딕)은 문제지 틀에 박힌 글자와
 * 우리가 갈아 끼우는 글자만 있으면 되므로 좁게 자른다 — 그러지 않으면
 * pyftsubset 쪽과 달리 파일이 다시 몇 MB로 불어난다.
 */

/**
 * **subset-font(harfbuzz WASM)가 마지막 몇 글리프를 깨뜨린다.** 완성형 한글
 * 전체(11172자)처럼 큰 연속 범위를 통째로 자르면, 원본 글꼴에서 글리프 ID가
 * 가장 큰 글자 몇 개(이 글꼴에서는 힞힟힠힡힢힣 — 한글 음절의 맨 끝 6자)의
 * `glyf`/`loca` 항목이 잘려 나간다. `hasGlyphForCodePoint`(cmap 조회)는 이걸
 * 못 잡는다 — cmap 매핑 자체는 멀쩡하고 **그 글리프의 윤곽 데이터만** 깨져
 * 있어서, PDF 에서 그 글자를 그리거나(`widthOfTextAtSize`) 문서를
 * 저장할 때(`PDFDocument.save()`)만 "Trying to access beyond buffer length"
 * 로 터진다. 실제로 이 버그 때문에 사용자의 PDF 생성이 통째로 실패했다 —
 * 이 여섯 글자가 실제로 쓰였는지와 무관하게, `(한)신중명조`가 물려 있는 PDF
 * 는 무엇을 쓰든 저장 자체가 안 됐다(subset:false 로 통째로 넣으므로
 * pdf-lib 가 저장할 때 글자 전부를 훑는다).
 *
 * **고치는 법**: 우리가 실제로 쓰는 범위 **뒤에** 이 글꼴이 확실히 갖고 있는
 * 여분의 한자를 덧붙인다. harfbuzz 의 출력 글리프 순서는 우리가 적어 보낸
 * 문자열 순서가 아니라 **원본 글꼴의 글리프 ID 순서**를 따르므로(한글 음절
 * 뒤에 라틴·자모·원문자를 적어 보내도 깨지는 건 여전히 한글 마지막 글자였다),
 * 덧붙인 한자가 원본에서 한글 음절보다 더 높은 글리프 ID를 가지면 깨지는
 * 자리가 그 한자 쪽으로 밀려나 우리가 쓰는 글자는 전부 무사해진다. 실제로
 * 재현해 확인했다 — 여유 없이 자르면 6자가 깨지고 `save()` 가 던지지만,
 * 한자 30자를 붙이면 필요한 11422자가 전부 멀쩡하고 `save()` 도 성공한다.
 * `subsetKiceFont` 의 구조 검증(아래)이 이걸 다시 놓치지 않게 잡아 준다.
 */
const HANGUL_PADDING = "一二三四五六七八九十百千萬億東西南北中上下左右大小年月日時分秒";

/** 완성형 한글 전체(U+AC00~D7A3) + 라틴/기호 + 자모·원문자. */
function fullHangulText(): string {
  const parts: string[] = [];
  for (let cp = 0xac00; cp <= 0xd7a3; cp++) parts.push(String.fromCodePoint(cp));
  for (let cp = 0x0020; cp <= 0x007e; cp++) parts.push(String.fromCodePoint(cp));
  for (let cp = 0x3131; cp <= 0x318e; cp++) parts.push(String.fromCodePoint(cp));
  for (let cp = 0x2460; cp <= 0x2473; cp++) parts.push(String.fromCodePoint(cp));
  for (let cp = 0x3260; cp <= 0x327f; cp++) parts.push(String.fromCodePoint(cp));
  return parts.join("");
}

/**
 * 나머지 네 글꼴이 실제로 그리는 글자.
 *
 * `upload-kice-fonts.mjs`의 `EXTRA` 표와 같은 값이다 — frames.json에 박힌
 * 글자 + 우리가 갈아 끼우는 영역명·과목명·정답표 머리글. 둘이 갈라지면
 * 한쪽으로 올린 글꼴만 온전하다.
 */
const FRAME_EXTRA: Record<string, string> = {
  "신그래픽체":
    "국어수학영어사회탐구과학탐구영역" +
    "생활과윤리사상한국지리세계동아시아사경제정치법문화" +
    "물리학Ⅰ화명생명과지구Ⅱ",
  "(한)신중명조": "번호정답①②③④⑤",
};

function textFromFrames(): string {
  const seen = new Set<string>();
  const walk = (frame: unknown) => {
    if (!frame || typeof frame !== "object") return;
    const items = (frame as { items?: unknown }).items;
    if (!Array.isArray(items)) return;
    for (const it of items) {
      if (it && typeof it === "object" && (it as { k?: unknown }).k === "text") {
        const t = (it as { t?: unknown }).t;
        if (typeof t === "string") for (const c of t) seen.add(c);
      }
    }
  };
  for (const set of Object.values(frames as Record<string, unknown>)) {
    if (!set || typeof set !== "object") continue;
    for (const frame of Object.values(set as Record<string, unknown>)) walk(frame);
  }
  return [...seen].join("");
}

/**
 * 완성형 한글 전체가 필요한 글꼴 — "이 자리에 어떤 글자가 올지 미리 셀 수
 * 없는" 역할을 맡은 것들이다. `(한)신중명조`는 정답표·지문 본문이 그렇고,
 * `(환)디나루`는 **표지 큰 제목**이 그렇다 — 원본 문구("2025학년도
 * 대학수학능력시험문제지")를 사용자가 지은 실모 제목(예: "국어 테스트용")
 * 으로 통째로 갈아 끼우는데(`KiceExportPanel`의 `replace` 맵), 그 제목은
 * 사용자가 무엇이든 타이핑할 수 있어 미리 글자를 셀 수 없다. 좁게 자르면
 * (frames.json에 박힌 글자만) 제목의 글자가 대부분 빠져서, PDF 뷰어가
 * `.notdef` 를 감추려고 조용히 다른 글꼴로 대신 그린다 — 네모(⊠)가 찍히지는
 * 않아 겉보기엔 "그냥 다른 서체로 보인다"뿐이라 한동안 못 알아챘다.
 */
const FULL_HANGUL_FONTS = new Set(["(한)신중명조", "(환)디나루"]);

/**
 * **한자까지 담아야 하는 글꼴** — 지문 본문을 그리는 `(한)신중명조` 하나다.
 *
 * 왜 필요한가: 국어 지문에는 한자가 예사로 나온다(고전 제목 `赤壁歌`, 한자
 * 병기, 인용). 실제 사용자 지문을 DB에서 세어 보니 한 편에 **39자**가 들어
 * 있었다. terra 는 그걸 제대로 읽어 저장까지 하는데 — **PDF 에서 통째로
 * 사라지고 있었다.** 서브셋에 한자 글리프가 없으니 `pdf.ts` 의
 * `fontForText()` 가 "이 글꼴로도 저 글꼴로도 못 그리는 글자"로 판정하고
 * **그 글자를 지운 채** 그렸기 때문이다(오류도 네모도 안 남는다 — 글자가
 * 그냥 없어진다). 사용자가 "한자는 인식이 아예 안 되나?" 라고 물은 게
 * 이것이다. 인식은 됐고 조판에서 버려지고 있었다.
 *
 * **목록을 손으로 적지 않는다.** KS X 1001 한자 4,888자를 소스에 적어 넣는
 * 것은 이 저장소가 이미 여러 번 데인 자리다(손으로 옮겨 적은 글자·파일명이
 * 조용히 어긋난다). 대신 **원본 글꼴이 실제로 가진 한자를 그대로 가져온다** —
 * 완성형 한글을 범위로 만든 것과 같은 방식이라 옮겨 적을 게 없다. 실제로
 * 재 보니 이 글꼴은 통합한자 4,620 + 호환한자 268 = **정확히 KS X 1001의
 * 4,888자**를 갖고 있다.
 *
 * **값**: 서브셋이 1.13MB → 3.24MB 로 는다. 예전 같으면 못 낼 값이었지만
 * (`no-cache` 라 열 때마다 통째로 다시 받았다) 이제 글꼴 라우트가 ETag 를
 * 보내므로 **처음 한 번만** 받고 그 뒤로는 304 다. 부분만 넣어 아끼는 길은
 * 택하지 않았다 — 어느 한자가 나올지 미리 알 수 없는데 빠진 글자는 조용히
 * 삭제되므로, 반만 담는 것은 이 버그를 반만 고치는 것이다.
 */
const HANJA_FONTS = new Set(["(한)신중명조"]);

/** 원본 글꼴이 가진 한자(통합 + 호환)를 코드포인트 차례로. */
function hanjaOf(original: Buffer): string {
  let charset: number[];
  try {
    charset = Array.from(fontkit.create(original).characterSet ?? []);
  } catch {
    // 원본을 못 읽으면 한자 없이 간다 — 예전과 같은 결과라 회귀는 아니다.
    return "";
  }
  return charset
    .filter(
      (cp) => (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff),
    )
    .sort((a, b) => a - b)
    .map((cp) => String.fromCodePoint(cp))
    .join("");
}

/**
 * 이 글꼴 이름에 실제로 **필요한** 글자(검증도 이 값 기준으로 한다).
 *
 * `original` 은 한자를 원본에서 뽑아내는 데만 쓴다 — 없으면 예전과 같다.
 */
function textFor(fontName: string, original?: Buffer): string {
  if (FULL_HANGUL_FONTS.has(fontName)) {
    const hanja =
      original && HANJA_FONTS.has(fontName) ? hanjaOf(original) : "";
    return fullHangulText() + hanja;
  }
  return textFromFrames() + (FRAME_EXTRA[fontName] ?? "") + "0123456789";
}

/**
 * `textFor()` 에 더해 subset-font 에 **실제로 보낼** 여분의 미끼 글자.
 * 필요해서가 아니라 위 `HANGUL_PADDING` 설명대로 마지막 글리프가 깨지는
 * 자리를 밀어내려는 것이다 — 검증은 이 글자들을 보지 않는다(없어도 상관없다).
 * 이 한자들이 그 글꼴에 없으면 subset-font 가 조용히 빼놓을 뿐이라
 * 안전하다(구조 검증이 그래도 깨진 게 남았는지 다시 확인한다).
 */
function paddingFor(fontName: string): string {
  return FULL_HANGUL_FONTS.has(fontName) ? HANGUL_PADDING : "";
}

export type SubsetResult = {
  bytes: Uint8Array;
  missing: string[];
};

/**
 * 원본 TTF를 필요한 글자만 남기고 자른다.
 *
 * **자른 뒤 실제로 그 글자를 쓸 수 있는지 다시 확인한다.** 두 가지를 본다 —
 * ① 원본에 애초에 없는 글자(cmap 조회, `hasGlyphForCodePoint`), ② **cmap엔
 * 있지만 글리프 데이터가 깨진 글자**. ②를 빠뜨리면 안 된다 — 실제로 겪은
 * 사고다: `(한)신중명조`를 완성형 한글 전체로 자르자 harfbuzz 가 마지막
 * 여섯 글자(힞힟힠힡힢힣)의 `glyf`/`loca` 항목을 깨뜨렸는데, cmap 매핑은
 * 멀쩡해서 `hasGlyphForCodePoint`는 통과했다. 그 글꼴이 물린 PDF는 그
 * 여섯 글자를 실제로 쓰든 안 쓰든 **`PDFDocument.save()` 단계에서 무조건
 * "Trying to access beyond buffer length"로 죽었다**(subset:false 로 통째로
 * 넣으므로 저장할 때 pdf-lib 가 글자 전부를 훑는다). 그래서 여기서
 * pdf-lib 로 실제 embed 하고 `widthOfTextAtSize` 를 글자마다 불러 본다 —
 * 그게 저장 때 밟는 것과 같은 길이라 이 검사를 통과하면 실제로도 안전하다.
 */
export async function subsetKiceFont(
  fontName: string,
  original: Buffer,
): Promise<SubsetResult> {
  const text = textFor(fontName, original);
  const bytes = await subsetFont(original, text + paddingFor(fontName), {
    targetFormat: "sfnt",
    noHinting: true,
  });

  const missing: string[] = [];
  const need = new Set(text);
  try {
    const font = fontkit.create(bytes);
    for (const ch of need) {
      if (!ch.trim()) continue;
      if (!font.hasGlyphForCodePoint(ch.codePointAt(0)!)) missing.push(ch);
    }
  } catch {
    // 확인만 실패한 것이지 자르기 자체는 됐다 — 결과는 그대로 돌려준다.
  }

  // ② 구조 검증: cmap엔 있지만 글리프 윤곽이 깨진 글자. pdf.ts 가 실제로
  // 타는 길(embed → widthOfTextAtSize → save)을 그대로 밟아 본다.
  try {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const pdfFont = await doc.embedFont(bytes, { subset: false });
    for (const ch of need) {
      if (!ch.trim() || missing.includes(ch)) continue;
      try {
        pdfFont.widthOfTextAtSize(ch, 10);
      } catch {
        missing.push(ch);
      }
    }
    // 실제로 문서를 저장해 봐야 확신할 수 있다 — save() 는 embed 된 글꼴을
    // 통째로 훑으므로, 위 글자별 검사를 다 통과했어도 다른 곳(우리가 안 쓰는
    // 글자)이 깨져 있으면 여기서 드러난다. 그때는 "missing" 으로 못 짚어
    // 주지만("어느 글자"가 아니니) 최소한 조용히 깨진 파일을 올리지는 않는다.
    await doc.save();
  } catch (err) {
    // 이 글꼴 전체가 pdf-lib 로 저장이 안 된다 — 실제로 겪은 사고와 같은
    // 증상이므로 조용히 넘기지 않고 던진다. 원인은 파악할 수 없어도(어느
    // 글자인지 특정 못 함) 깨진 파일을 그대로 올리는 것보다 낫다.
    throw new Error(
      `자른 글꼴을 PDF 에 실제로 넣어 저장하는 데 실패했습니다(구조 검증) — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { bytes, missing };
}

/** 이 이름이 올릴 수 있는 글꼴인지(버킷 파일명도 함께). */
export function kiceFontFile(fontName: string): string | null {
  return KICE_FONT_FILES[fontName] ?? null;
}
