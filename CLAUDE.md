# 수학오답프린트 제작 — 작업 인수인계

새 세션에서 이 저장소를 열면 이 파일을 먼저 읽고 아래 "남은 작업"부터 이어서 진행하세요.

## 무엇을 만드는 앱인가

수학 오답 사진을 올리면 → 문제 영역을 자동 감지하고 → 사용자가 크롭을 보정하고 →
Mathpix OCR로 인식해서 → 나눔명조 + KaTeX로 가독성 좋게 재구성하고 →
**변환 결과 이미지만** 계정에 저장(원본 사진은 버림) → 실전모의고사(실모)별로 모아뒀다가
→ 출처가 표시된 PDF로 인쇄하는 Next.js 앱.

- 저장소: `wesslvc/mathpix`, 작업 브랜치: `main`
  (한 번 삭제된 적이 있어 커밋 해시로 복구함: `3a92fa19a72ab7b5e8f41d2a47b5a0d547268ae5`)
- **배포는 Vercel의 `mathocr` 프로젝트**를 씁니다(`mathocr-...vercel.app`).
  Vercel 프로젝트 `mathpix`도 같은 저장소에 연결돼 있지만 Production Branch가
  `main`을 따라가지 않아 실사용 배포가 아닙니다. 헷갈리지 말 것.
- Supabase 프로젝트: `bmhupmkxzvbqndxkvjmx` (URL: `https://bmhupmkxzvbqndxkvjmx.supabase.co`).
  이 세션의 Supabase MCP 커넥터는 다른 프로젝트(`seji`, ref `brgvpmpqvqhdjsnrxzhh`)에만
  접근 권한이 있어서 위 프로젝트는 MCP로 직접 조작 불가 — SQL은 사용자가 대시보드에서
  직접 실행해야 함.

## 사용자가 확정한 요구사항

- **오답추가** = 특정 카테고리(실모) 안에 문제를 추가하는 버튼. 독립된 개념이 아님.
- **실모추가** = 출처(예: "2025학년도 6월 모의평가")를 입력해 카테고리를 만드는 것.
- 로그인은 **이메일/비밀번호**. (처음엔 Google OAuth로 만들었으나 사용자가 "구글 버리고
  이메일로만 가능하게 해달라"고 해서 교체함. 다시 Google을 추가해달라고 하지 않는 이상
  이메일/비밀번호 방식 유지.)
- PDF는 **한 페이지에 문제 1개, 하단에 출처 표기**.
- 원본 사진은 저장하지 않고 변환 결과만 저장.

## 이미 끝난 것

- 업로드 → 자동 크롭 감지 → 수동 크롭 보정 → Mathpix 인식 → 결과 렌더링 → PNG 저장
- 결과 렌더링 가독성 재설계: 문단 분리, `>` 블록은 조건 박스, 첫 문단의 문제번호 굵게
- 조건 박스 자동 감지 규칙은 세 가지다(`renderMathTextWithInfo`):
  ① 문단 전체가 `>`로 시작하면 통째로 박스
  ② `(가)`/`(나)` 표지가 있으면 첫 표지부터 마지막 표지 문장의 마침표까지
  ③ `<보기>` 머리글이 있으면 머리글 줄부터 마지막 ㄱ/ㄴ/ㄷ 항목 문장의
     마침표까지 (`BOGI_HEADER` / `BOGI_ITEM`)
  ②와 ③은 한 문제에 같이 나올 수 있고 그때는 박스가 두 개 생긴다.
  ③에서 조심한 것들: **표지의 마침표는 문장의 끝이 아니다** — "ㄷ. 교점은 두
     개이다."에서 첫 마침표(표지의 것)를 문장 끝으로 보면 표지만 박스에 남고
     내용이 박스 밖으로 빠진다. `markerPrefixLength()`로 표지를 건너뛰고
     찾는다(`splitAtSentenceEnd` / `lineHasSentenceEnd` / `closeBoxAtLine`) /
     머리글만 있고 항목이 없으면 박스를 만들지 않는다(머리글만
  갇힌 박스는 박스가 아니다) / Mathpix가 머리글 다음에 빈 줄을 넣어 항목을
  다른 문단으로 보내면 다음 문단까지 이어서 본다 / 질문·선택지 줄을 만나면
  거기서 끊는다 / 마지막 항목에 마침표가 없으면 뒤에서 첫 마침표까지만
  늘리고, 못 찾으면 항목 줄에서 끝낸다(무작정 늘리면 무관한 본문을 삼킨다) /
  같은 문단에서 `(가)`가 `<보기>`보다 앞서면 ③을 적용하지 않고 ②에 맡긴다.
  (`src/lib/renderMathText.ts`, `.mmd-*` 클래스는 `src/app/globals.css`)
- 폰트: 나눔명조 자체 호스팅(`@fontsource/nanum-myeongjo`), 수식은 KaTeX
- 보기 표지(ㄱ/ㄴ/ㄷ): Mathpix가 **조합용 자모**(U+1100~, `ᄀᄂᄃ`)로 주는 경우가
  있는데, 이건 음절 조립용 코드라 홀로 쓰면 위첨자처럼 아주 작게 그려져 눈에
  띄게 깨지고 `BOGI_ITEM`(U+3131~)에도 안 걸려 박스 감지 자체가 안 된다.
  `normalizeJamo()`가 호환용 자모로 바꾼다. **유니코드 NFKC로는 안 된다** —
  표준이 정한 방향이 반대(ㄱ→ᄀ)라서 표를 직접 들고 있다.
  (호환용 자모도 나눔명조에서는 음절보다 작게 그려져서 — 재보니 잉크 높이가
  0.696배 — 한때 1.3배로 키웠지만, 사용자가 1배가 낫다고 해서 되돌렸다.)
- 앱 이름 "수학오답프린트 제작"
- Supabase 연동 코드 전체: **이메일/비밀번호 로그인+회원가입**(`src/app/login/page.tsx`),
  이메일 확인 콜백(`src/app/auth/callback/route.ts`), 미들웨어 인증 가드,
  대시보드(실모 목록), 실모추가 폼, 카테고리 상세(오답추가 + 저장),
  PDF 내보내기(`pdf-lib`)
- DB 스키마 SQL: `supabase/migrations/0001_init.sql`
  (categories / problems 테이블 + RLS + `problem-images` 비공개 버킷)
- 키가 없으면 앱이 죽지 않고 안내 메시지만 표시하도록 처리 (Mathpix mock, Supabase 안내)
- 도형(원/삼각형 등) 재구성: Mathpix가 자동 감지한 도형 영역은 원본 사진에서
  그대로 오려낸 raster로 무료·자동 표시(기존 동작, `ResultStage.tsx`). 그와
  별개로 "도형 추가인식" 버튼(`DiagramCropModal.tsx`)을 누르면 사용자가 원본
  사진에서 도형 부분을 직접 드래그로 오려내고, 그 영역만 `/api/diagram` →
  `src/lib/diagramVector.ts`가 **Google Gemini API**
  (`generativelanguage.googleapis.com/v1beta/models/<모델>:generateContent`,
  `x-goog-api-key` 헤더, 이미지는 `inline_data`에 접두어 없는 순수 base64,
  `GEMINI_API_KEY` 환경변수)로 보내 깨끗한 SVG로 재구성해 문제 밑에 추가로
  붙인다. `GEMINI_API_KEY`가 없으면 이 버튼을 눌러도 에러 메시지만 뜨고
  차감되지 않음(자동 raster 표시는 키 없이도 그대로 동작).

  **모델은 사용자가 고른다**(`DIAGRAM_MODELS`, `ResultStage.tsx`의 선택 UI):
  - `lite` = `gemini-flash-lite-latest` (기본) — 사진인식권 5장
  - `flash` = `gemini-flash-latest` (고화질) — 플래시쿠폰 1장

  **크레딧/한도 정책** (마이그레이션 0010 → 0011 → 0012 → 0013 순서대로 적용.
  뒤 파일이 앞 파일의 함수를 통째로 덮어쓰므로 **순서를 지켜야 한다**):
  - OCR 1회 = 사진인식권 1장 (무료 사용자도 가능)
  - lite: 무료 사용자는 사진인식권 5장 차감, **결제자는 무료**
  - flash: **결제자 전용**, 사진인식권 대신 **플래시쿠폰**으로 하루 5장,
    KST 자정 초기화, 누적 안 됨
  - `entitlements.unlimited = true`인 계정은 OCR·lite·flash 차감을 전부 건너뛴다
    (0012에서 운영자 계정에 켜둠)

  **flash는 단일 모델이 아니라 세대별 티어 목록이다** (`0014`, 제일 헷갈리는 부분):
  사용자별 한도(하루 5장)와 **별개로** 모델마다 하루 예산(기본 20건)이 있다.
  Gemini 무료 등급 RPD는 사용자가 아니라 **계정 전체**에 걸리므로, 사용자별
  한도만 두면 사용자 4명이 각자 5장씩 써서 그대로 터진다.
  **RPD는 모델별로 따로 걸리기 때문에**, 위 세대가 20건을 다 쓰면 flash를
  포기하는 게 아니라 아래 세대로 내려가 또 20건을 쓴다(`diagram_model_tiers`
  테이블, tier 1이 최고 화질). 티어 5개면 하루 flash 용량이 100건이 된다.
  전부 소진되면 그때 lite로 내려간다.
  **무제한 계정도 이 예산은 못 넘는다** — 우리 지갑이 아니라 Google의 제한이다.

  티어 목록을 **코드가 아니라 DB에 둔 이유**: 모델 이름을 추측했다가 404를
  여러 번 맞았다. 이름이 틀려도 재배포 없이 표만 고치면 되고, 실제로 404/429가
  나면 `/api/diagram`이 `exhaust_diagram_model_tier()`로 그 세대를 오늘 소진
  처리하고 **다음 티어로 자동으로 내려가 재시도**한다(사용자에겐 오류가 안 보임).
  이름이 아예 틀린 티어는 하루 한 번만 헛수고하고 건너뛰어진다.

  차감 순서가 중요하다: 모델 카운트를 먼저 올리고 개인 자격을 확인하며, 개인
  쪽에서 막히면 **올려둔 카운트를 반드시 되돌린다**(안 그러면 아무도 안 쓴 몫이
  증발한다). 반대로 404/429로 세대를 갈아탈 때는 `refund_diagram_credit`에
  `p_model_id`를 **넘기지 않는다** — 소진 표시를 유지해야 하기 때문이다.

  사용 기록은 `diagram_usage_log`(누가 언제 뭘 썼는지)와
  `diagram_daily_usage`(날짜·모델별 합계)에 남는다. 운영자(unlimited 계정)는
  `/api/diagram/usage?days=7`로 사용자별 집계를 볼 수 있다.

  한도 숫자는 전부 DB 함수(`flash_diagram_daily_limit()`, `lite_diagram_cost()`)에
  있고 서버·화면이 그 값을 읽어 쓴다. **JS 쪽에 하드코딩하지 말 것** — 어긋난다.
  차감은 `consume_diagram_credit(p_model)`, 환불은 `refund_diagram_credit(p_model)`,
  화면 표시용 조회는 `diagram_quota()` → `/api/diagram/quota`.
  실패 사유가 여러 가지(미결제/크레딧 부족/쿠폰 소진)라 이 함수들은 기존
  `consume_recognition_credit`과 달리 integer가 아니라 **jsonb**를 돌려준다.
  `/api/diagram`에는 `export const maxDuration = 60`이 필요하다 — 기본
  서버리스 제한(10초대)에 걸리면 Vercel이 **JSON이 아닌** 에러 페이지를
  돌려줘서 클라이언트 `res.json()`이 깨진다(`ResultStage.tsx`에 파싱 실패
  처리 있음).

  #### 모델 선택에서 배운 것 (제일 중요)

  **모델 이름을 기억이나 웹 검색으로 고르지 말 것. 반드시 실제로 호출해보고
  고를 것.** 카탈로그/ListModels에 이름이 보여도 그 키로는 404가 날 수 있다
  (제공 여부가 키가 아니라 **계정**에 묶여 있음). 이걸 검증하려고
  `/api/diagram/models` 진단 엔드포인트를 만들어 뒀다(로그인 필요, 현재는
  Gemini ListModels 조회용). NVIDIA를 쓰던 시절엔 후보 모델마다 1×1 PNG를
  실제로 찔러보는 프로브 버전이었고, 그게 한 방에 답을 줬다.

  이름 추측으로 날린 실패들: `microsoft/phi-3.5-vision-instruct`(카탈로그에
  아예 없음), `moonshotai/kimi-k2.6`(404 `Not found for account` — 사용자가
  키를 새로 발급해도 계정 해시가 동일해서 그대로 404),
  `nvidia/nemotron-3-super-120b-a12b`(텍스트 전용, 500 "multimodal processing
  is not enabled"), `gemini-2.5-flash-lite`(ListModels 목록엔 있는데 호출하면
  "no longer available to new users").

  전체 이력: Gemini 2.0 Flash(계정에서 사라짐) → 2.5 Flash(429 연발) →
  NVIDIA `nemotron-nano-12b-v2-vl`(품질 부족) → `llama-3.2-90b-vision`(느림,
  이때 `ResultStage.tsx`에 경과시간+진행률 UI 추가) → `llama-3.2-11b-vision`
  → phi-3.5(없는 모델) → 11b → kimi-k2.6(404) → `nvidia/llama-3.1-nemotron-nano-vl-8b-v1`
  (프로브로 200 OK 확인됨 — NVIDIA로 되돌아갈 일이 있으면 이걸 쓸 것. 단
  `route.ts`의 키 검사와 `diagramVector.ts`의 요청 형식을 NVIDIA용으로 함께
  되돌려야 한다. 두 API는 요청 모양이 완전히 다름) → Gemini 2.5 Flash Lite(404)
  → **현재 `gemini-3.6-flash`**. 품질이 부족하면 상위 모델로, 429가 잦으면
  `gemini-3.5-flash-lite` / `gemini-flash-lite-latest`로 조정.

  `diagramVector.ts`의 실패 처리 원칙: HTTP 에러는 상태 코드와 API가 준
  메시지를 담아 **throw**하고(호출부가 크레딧 환불 + 그 메시지를 사용자에게
  노출), 응답은 정상인데 SVG를 못 뽑은 경우만 `null`을 반환한다. 예전엔
  전부 `return null`이라 k2.6이 왜 안 되는지 몇 번을 잘못 짚었다.

### 도형·자료를 본문 문단 사이에 놓기

예전에는 도형·자료가 무조건 본문 **맨 아래**에 붙었다. 문제집은 자료가 문장
사이에 오는 경우가 많아서 사용자가 위치를 고를 수 있어야 한다.

`renderMathTextWithInfo`가 `blocks: string[]`(최상위 요소 하나씩)을 함께
돌려주고, `ResultStage`가 그 사이사이에 도형 HTML을 끼워 **하나의 문자열로**
합쳐 카드에 넣는다(`cardHtml`). 위치는 `figurePos[id]` = "이 문단 앞"이고
0이 맨 위, `blocks.length`가 맨 아래(기본값)다.

**React 요소로 따로 두지 않고 문자열로 합치는 이유**: 문단마다 감싸는
`<div>`가 생기면 모든 `<p>`가 각자 `:last-child`가 되어
`.mmd-paragraph:last-child { margin-bottom: 0 }`이 전부 걸려버리고 문단 간격이
통째로 사라진다. 실제 브라우저에서 확인한 값 — 문자열로 합치면 중간 문단
22px 유지, 마지막만 0px.

도형에 붙는 클래스가 Tailwind 유틸리티가 아니라 `.problem-figure`(globals.css)인
것도 같은 이유다. HTML 문자열에는 클래스명만 적을 수 있다.

**미리보기에서 그림을 손으로 끌어 옮긴다.** 처음엔 ▲▼ 버튼으로 만들었다가
불편하다고 해서 드래그로 바꿨다. 조절 패널의 목록은 지금 어디에 놓였는지
보여주는 표시 겸 보조 수단으로만 남겼다.

구현에서 조심할 점 — **끄는 동안에는 React state를 건드리지 않는다.** 본문은
`dangerouslySetInnerHTML` 한 덩어리라, state가 바뀌어 `cardHtml` 문자열이
달라지면 React가 innerHTML을 통째로 갈아치우고 지금 잡고 있는 그 DOM 요소가
사라진다. 그러면 포인터 캡처가 끊겨 드래그가 중간에 죽는다. 끄는 동안에는
`drag.el.style.marginLeft`만 직접 바꾸고, 최종 위치는 손을 뗄 때 한 번만
state에 반영한다. 안내선 위치는 state로 두어도 되는데, `cardHtml`의 의존성이
아니라 문자열이 그대로여서 React가 DOM을 손대지 않기 때문이다.

터치가 스크롤로 먹히지 않게 `.problem-figure`에 `touch-action: none`이 필요하다.
안내선은 `cardRef` **바깥**(감싸는 relative 껍데기)에 둔다 — 안에 두면 PNG
캡처에 파란 줄이 같이 찍힌다. 자동 저장도 드래그 중에는 미룬다(끄는 중에는
DOM만 바뀐 상태라 지금 캡처하면 어중간한 위치가 이미지로 굳는다).

실제 포인터 입력(Playwright, 마우스 + 모바일 터치)으로 15가지를 확인했다.

### 과목 모드 (수학 / 사과탐)

`src/lib/subject.ts`의 `Subject = "math" | "science"`. 오답 추가 화면 맨 위에서
고르고 실모별로 **브라우저 localStorage**에 기억한다(DB 아님 — 이 값은 인쇄물이나
저장 데이터에 전혀 영향을 주지 않고 "어떤 버튼을 보여줄까"만 정한다. 서버에
두고 싶어지면 `categories`에 컬럼 하나 추가하면 된다).

**텍스트·수식 인식은 두 모드가 완전히 같다** — 둘 다 Mathpix를 그대로 쓴다.
갈라지는 건 그림 도구 하나뿐이다:
- `math` → 도형 화질 선택 + "도형 추가인식"(Gemini). 기존 동작 그대로.
- `science` → `FigurePanel`(OpenAI). 위 도형 도구는 **숨긴다.**

두 도구를 한 화면에 같이 두면 어느 걸 눌러야 하는지 헷갈리고 엉뚱한 모델에
크레딧을 쓴다. 그래서 배타적으로 보여준다. Mathpix가 자동 감지한 도형/자료
영역을 원본에서 오려 붙이는 무료 동작은 **두 모드 모두** 그대로 돈다.

### 사회탐구·과학탐구 자료 (수학 도형과 완전히 별개)

수학 도형은 Gemini, **사과탐 자료는 OpenAI**(`OPENAI_API_KEY`)를 쓴다. 두
경로는 코드가 겹치지 않는다 — 수학 쪽은 이미 안정적으로 돌아가고 있어서
건드리지 않는 게 원칙이다. 결과가 둘 다 SVG 문자열이라 문제 카드에 붙고
저장되는 뒷단(`manualDiagramSvgs`)만 공유한다.

- `src/lib/figureImageGen.ts` — OpenAI **이미지 편집** API(`/v1/images/edits`)
  호출. multipart/form-data이고 Content-Type을 직접 지정하면 안 된다(fetch가
  경계값까지 붙여준다).
- `src/app/api/figure/route.ts` — 인증·과금·모델 폴백. `maxDuration = 60`.
- `src/app/api/figure/models/route.ts` — **프로브 엔드포인트**(로그인 필요).
- `src/components/FigurePanel.tsx` — UI 전체.

**SVG가 아니라 이미지 생성을 쓴다.** 처음에는 비전 모델에게 SVG 마크업을
뱉게 했는데(`figureVector.ts`, 지금은 삭제) 사용자가 실제로 써보고 품질이
부족하다고 판단했다. 차이가 근본적이다 — SVG 방식은 모델이 그림을 "코드로
설명"해야 해서 좌표를 하나하나 지어내야 하지만, 이미지 편집은 원본 이미지를
그대로 입력으로 받아 정리한 그림을 낸다. 되돌리려면 git 이력에서
`figureVector.ts`를 찾을 것.

대신 결과가 래스터라 확대하면 흐려지고, **이미지 생성 모델은 한글 라벨을
잘못 쓰는 경우가 있다.** 글자가 중요한 자료는 "원본 그대로 붙이기"가 여전히
가장 정확하다. 완성된 그림은 원본 크롭과 똑같이 `rasterToSvg`로 감싸서
크기·위치 조절과 PNG 캡처가 두 경로에서 같은 방식으로 돌게 한다.

모델은 **`gpt-image-2` 하나뿐이다.** 2026-08 프로브에서 `gpt-image-1.5` /
`gpt-image-1` / `gpt-image-1-mini`도 이 계정에 존재함을 확인했지만 후보에서 뺐다.

**폴백 캐스케이드를 걷어낸 이유 (다시 넣으려는 다음 사람에게):** 원래는 후보를
여러 개 늘어놓고 앞의 것이 404/403/429면 다음으로 내려가게 했다. 모델 이름을
틀려도 기능이 죽지 않게 하려던 것이다. 그런데 그 대가로 **사용자가 고른 적도
없는 모델(gpt-4o-mini, gpt-4.1, gpt-5 등)에 요금이 나갔다.** SVG 시절에는
폴백 한 번이 출력 8000 토큰짜리 생성이라 특히 비쌌다. 실패했을 때 조용히 다른
모델로 갈아타는 것보다 실패했다고 알리고 멈추는 편이 낫다. 폴백이 필요하면
`OPENAI_FIGURE_IMAGE_MODELS`에 명시할 것.

방어선도 두 겹 두었다 — `figureImageModelIds()`가 `gpt-image`로 시작하지 않는
이름을 걸러내고, `generateFigureImage()`가 호출 직전에 한 번 더 확인한다.
환경변수 오타나 실수로 채팅 모델 이름이 들어가도 그쪽으로는 요청이 나가지 않는다.

`/api/figure/models` 프로브도 **지금 설정된 후보만** 찔러본다(기본값이면 1회).
예전에는 채팅 모델 6개를 매번 실제로 호출했고, 그것도 의도치 않은 사용량의
일부였다. 목록 조회(`/v1/models`)는 무료다.

**`quality`는 보내지 않는다.** 한때 시간을 아끼려고 `medium`을 넣었는데,
자료는 글자와 가는 선이 살아야 쓸모가 있어서 품질을 낮추면 안 된다.
60초 안에 끝나는 게 정상이고, 안 끝나면 품질이 아니라 자료 영역을 좁혀야 한다.
`input_fidelity: "high"`(원본을 얼마나 따라갈지)는 유지하되, 안 받는 모델이면
400이 나므로 `PARAM_VARIANTS`의 다음 조합으로 내려간다.

**프로브 이미지를 손으로 적지 말 것.** `models/route.ts`의 `TINY_PNG_BASE64`를
처음에 기억으로 적었다가 IDAT 청크 CRC가 깨진 잘린 파일을 넣었고, 그 결과
멀쩡한 네 모델이 전부 "Invalid image file or mode"로 400을 냈다. 진단 도구가
정상인 것을 불량이라고 보고한 셈이다. 바꿔야 하면 실제로 파일을 만들어
CRC까지 검사한 뒤 넣을 것.

**응답 필드를 바꿀 때 조심할 것.** 카드는 HTML 문자열을 이어붙여 만들기
때문에 마크업 자리에 `undefined`가 하나 섞이면 "undefined"라는 글자가 그대로
문제에 인쇄된다. 응답 필드를 `svg`에서 `image`로 바꿨을 때 예전 화면이 캐시된
상태에서 실제로 그 일이 났다. 지금은 두 군데서 막는다 — `FigurePanel`이
응답의 `image`가 `data:image/`로 시작하는 문자열인지 확인하고, `ResultStage`의
`figures`가 빈 마크업을 걸러낸다.

**비용 설계 (이게 이 기능의 핵심이다)**

1. **자료를 오려낸 뒤 바로 보내지 않는다.** "원본 그대로 붙이기(무료)"와
   "AI로 다시 그리기(사진인식권 5장)" 중 사용자가 고른다. 무료 쪽이 기본이자
   앞에 있다 — 사진·현미경 사진·지도는 다시 그리면 정보가 사라지므로 원본이
   정답이고, 사과탐에는 그런 자료가 아주 많다.
2. **입력 축소** — 긴 변 768px(`MODEL_INPUT_DIM`)로 줄여 보낸다.
3. **캐시** — 같은 자료는 한 번만 보낸다(`figureCache.ts`, sessionStorage).
   사과탐은 자료 하나에 문항이 2~3개 딸린 세트가 흔해서 실제로 자주 걸린다.
4. **출력 상한** — `MAX_OUTPUT_TOKENS = 8000`. 비용의 대부분이 출력 토큰이다.

**자동 판별기는 일부러 안 넣었다.** "사진형이면 호출을 막자"고 픽셀 통계로
선화/사진을 가르려 했는데 두 방법 다 실패했다: ① 국소 평탄도 → 부드러운
그라디언트 사진이 1.00으로 선화(0.90~0.95)보다 높게 나온다(그라디언트는
국소적으로 가장 평탄하다). ② 상위 N개 색 점유율 → "색칠된 지층 단면도를
어두운 조명에서 찍은 사진"이 0.59로 사진 범위(≤0.63)에 파묻힌다. 어느
임계값을 잡아도 정상 자료를 막거나 사진을 통과시킨다. 다시 시도하려면
`figureImage.ts` 주석의 수치부터 읽을 것.

**모델 이름은 여기서도 추측하지 말 것.** `figureImageGen.ts`의
`DEFAULT_IMAGE_MODEL_IDS`는 계정의 `/v1/models` 목록에서 가져왔을 뿐
**실제 호출로 검증되지 않았다.** `/api/figure/models`가 후보마다 8×8 PNG로
진짜 편집 요청을 보내보고 결과를 알려준다. 로그인 후
`/api/figure/models`를 열면 ① `/v1/models` 목록과 ② 후보마다 1×1 PNG를
**실제로 보내본** 프로브 결과가 같이 나온다. `usable`에 나온 이름을
`OPENAI_FIGURE_IMAGE_MODELS` 환경변수에 쉼표로 넣으면 **재배포 없이** 적용된다.
호출 중 404/403/429가 나면 그 자리에서 다음 후보로 자동으로 내려간다.

과금은 **새 마이그레이션 없이** 기존 `consume_recognition_credit(p_amount)`를
쓴다(사진인식권). 차감은 요청당 딱 한 번이고 — 모델을 갈아타는 건 우리
사정이지 사용자가 더 낼 이유가 아니다 — 실패하면 `refund_recognition_credit`로
되돌린다. 장수는 `FIGURE_CREDIT_COST`(기본 5), 화면은 `/api/figure/config`로
그 값을 읽어간다. **JS에 하드코딩하지 말 것.**

### 과거에 해결한 버그 (재발 시 참고)

- Mathpix가 `latex_styled`만 주거나 `\( \)` / `\[ \]` 델리미터를 쓰면 LaTeX가 그대로
  글자로 보이던 문제 → `renderMathText`에서 델리미터 정규화 + 델리미터 없는 순수
  LaTeX는 통째로 블록 수식 처리
- 아이폰 사진(수천 px)을 무압축 PNG data URL로 보내다 Safari에서
  "The string did not match the expected pattern." 발생 → `src/lib/cropImage.ts`에서
  긴 변 1600px 이하 + JPEG 품질 0.9로 압축해 전송
- HEIC/HEIF 업로드 시 안내 메시지 표시
- `main` 브랜치가 원격에서 통째로 삭제된 적이 있음(원인 불명). 커밋은 GitHub에
  GC되지 않고 SHA로 남아 있어서 `git fetch origin <sha>`로 복구 가능했음. 브랜치가
  안 보이면 먼저 Vercel 배포 메타데이터의 `githubCommitSha`로 마지막 커밋을 찾아볼 것.

## 남은 작업 (여기서부터 이어서)

1. **DB 마이그레이션 재확인** — `supabase/migrations/0001_init.sql`(categories/problems/
   problem-images 버킷)이 실제 `bmhupmkxzvbqndxkvjmx` 프로젝트에 적용됐는지 확인 필요.
   이전에 사용자에게 실수로 다른(지금은 버려진) 스키마인 `problem_history` 테이블
   SQL을 먼저 전달한 적이 있어서, `0001_init.sql`을 아직 안 돌렸을 수 있음.
   **`0009_diagram_credit_amount.sql`도 아직 실행 안 됐을 수 있음** — 이게 없으면
   "도형 추가인식" 버튼이 크레딧 차감에 실패해 500 에러가 남(RPC가 `p_amount`
   인자를 못 받는 옛 함수로 남아있기 때문).
   **`0010_diagram_model_quota.sql`은 반드시 실행해야 함** — 도형 모델 선택/
   결제자 전용/플래시쿠폰이 전부 이 파일의 함수에 의존한다. 안 돌리면
   `consume_diagram_credit` 함수가 없어서 도형 추가인식이 500으로 죽는다.
2. **이메일 확인 리디렉션 URL 등록** — Supabase 대시보드 Authentication > URL
   Configuration에 `{mathocr 배포 도메인}/auth/callback` 추가.
3. **Vercel 환경변수 확인** — `mathocr` 프로젝트(배포에 실제 쓰이는 프로젝트)에
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `MATHPIX_APP_ID`, `MATHPIX_APP_KEY`가 들어있는지 확인.
   `GEMINI_API_KEY`(도형 SVG 재구성용)는 선택 사항 — 없어도 원본 크롭
   이미지로 대체 표시되니 앱이 죽지 않음. `NVIDIA_API_KEY`는 이제 안 씀.
4. **실제 동작 검증** — 회원가입 → 이메일 확인 → 로그인 → 실모추가 → 오답추가 →
   PDF 내보내기 전 과정.

### 문제 카드는 축소해서 보여준다 (ScaledCard)

카드 너비(`PROBLEM_CARD_WIDTH`)는 어떤 기기에서든 같아야 한다 — 그래야 결과물이
같다. 그런데 휴대폰 화면은 그보다 좁아서 예전에는 가로로 밀어 봐야 했다.
`ScaledCard`가 **바깥 껍데기에만** `transform: scale()`을 걸어 통째로 줄인다.

- **축소를 카드 자체에 걸면 안 된다.** 캡처 대상(`cardRef`)에 transform이 걸리면
  저장되는 PNG가 같이 줄거나 잘릴 수 있다. 껍데기에만 걸어 캡처는 원래 크기를
  유지한다. 실제 브라우저에서 확인 — 390 / 700 / 1200px 폭 전부에서 캡처가
  1520×880으로 동일했고 카드는 화면에 정확히 들어맞았다.
- transform은 레이아웃 크기를 바꾸지 않아서(줄여도 원래 자리를 차지한다) 바깥
  높이를 직접 계산해 준다. 안 그러면 카드 아래에 빈 공간이 잔뜩 남는다.
- **드래그 계산은 배율로 나눠야 한다.** 손가락이 움직인 화면 거리와 카드 안의
  거리가 다르다(`scaleRef`). 안내선 위치도 화면 좌표를 배율로 나눠 카드
  좌표계로 되돌린다.

`ResultStage`(인식 결과)와 `ProblemGallery`(수정 모달) 두 곳에서 쓴다.

### 이미지 생성 결과의 빈 여백

이미지 생성 모델은 자료가 가로로 길든 세로로 길든 자기 비율(대개 정사각형)에
맞춰 그려서 둘레에 흰 여백을 잔뜩 붙여 돌려준다. 그대로 끼우면 그림보다 여백이
더 커져 문단 사이가 휑하게 벌어진다. `trimBlankBorder()`가 내용이 있는 부분만
남기고 잘라낸다(1024×1024 정사각형에 든 가로형 도식 기준 세로 여백 66% 제거).
이미 꽉 찬 그림이나 완전히 빈 이미지는 원본을 그대로 돌려준다(불필요한 재인코딩 방지).

## 주의할 점

- **Vercel 프로젝트 `mathpix`의 Production Branch는 `main`을 따라가지 않는다.**
  실제 서비스 중인 배포는 `mathocr` 프로젝트 쪽이며, 그쪽은 Production Branch가
  `main`으로 정상 연결되어 있어 보통 `main`에 push하면 자동으로 재배포된다.
- **2026-07-27 세션에서 GitHub→Vercel 웹훅이 멈춘 적 있음** — 커밋 3개(`3d19299`,
  `16e4825`, `7127b54`)를 연달아 `main`에 push했는데 `mathocr` 프로젝트에 배포가
  하나도 안 생김(재배포조차 안 됨, 30분+ 대기해도 동일). `list_deployments`로
  최신 배포의 `githubCommitSha`가 push한 커밋과 같은지 꼭 확인할 것 — 다를 경우
  Vercel 대시보드 Settings→Git 연결 상태나 GitHub Settings→Webhooks 배송 로그를
  사용자에게 확인받아야 함(API로는 재연결 불가). 이 문제 때문에 도형 재구성
  모델을 90b로 올린 커밋이 한동안 실제 서비스에 반영되지 않았었다.
- `main`에 직접 push하는 것이 이 저장소의 관행이었음(PR 없이). 다만 세션 지침에서
  특정 작업 브랜치를 지정한 경우 그 브랜치에서 작업하고, `main`에 반영할 때는
  사용자에게 확인받을 것.
- 이전 세션에서 중복 스캐폴드 브랜치 1개(`claude/math-problem-image-recognition-64hjax`)가
  원격에 남아 있음. 내용은 `main`에 모두 반영돼 있으니 무시해도 된다.
- 사용자가 채팅에 API 키를 평문으로 붙여넣은 적 있음(Mathpix, Supabase anon key 등).
  민감정보를 다룰 때 채팅에 노출하지 말 것.

## 명령어

```bash
npm install
npm run dev     # http://localhost:3000
npm run build   # 배포 전 항상 확인
```
