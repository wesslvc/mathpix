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
  (`src/lib/renderMathText.ts`, `.mmd-*` 클래스는 `src/app/globals.css`)
- 폰트: 나눔명조 자체 호스팅(`@fontsource/nanum-myeongjo`), 수식은 KaTeX
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
  `src/lib/diagramVector.ts`가 **NVIDIA API 카탈로그**(build.nvidia.com)의
  `microsoft/phi-3.5-vision-instruct` 모델(OpenAI 호환 chat/completions 형식,
  `NVIDIA_API_KEY` 환경변수)로 보내 깨끗한 SVG로 재구성해 문제 밑에 추가로
  붙인다. **크레딧 정책**: OCR 1회 = 1개, 도형 추가인식 1회(클릭당) = 30개
  (NVIDIA API 호출 비용이 커서 비싸게 책정)
  — 둘 다 하면 문제 하나에 총 31개 차감(`supabase/migrations/0009_diagram_credit_amount.sql`에서
  `consume_recognition_credit`/`refund_recognition_credit`이 `p_amount`를
  받도록 바뀜). `NVIDIA_API_KEY`가 없으면 이 버튼을 눌러도 에러 메시지만
  뜨고 크레딧은 차감되지 않음(자동 raster 표시는 키 없이도 그대로 동작).
  (Gemini API를 먼저 써봤으나 계정에 `gemini-2.0-flash`가 사라져 있고
  `gemini-2.5-flash`도 첫 시도부터 429가 계속 나서, 분당 40회 무료 한도가
  있는 NVIDIA API 카탈로그로 교체함 — `GEMINI_API_KEY` 관련 코드는 이제
  안 씀. 처음엔 가벼운 `nvidia/nemotron-nano-12b-v2-vl`을 썼으나 도형
  재구성 품질이 너무 떨어져 `meta/llama-3.2-90b-vision-instruct`로 올렸다가,
  90b는 응답이 몇십 초~1분 넘게 걸릴 만큼 느려서(그 대기 시간을 보여주려고
  `ResultStage.tsx`에 경과시간+진행률 UI 추가함) 같은 Llama 3.2 Vision 계열의
  더 작은 `meta/llama-3.2-11b-vision-instruct`로 내렸는데, 그마저 여전히
  느려 Vercel 함수 타임아웃(비JSON 에러 응답, `handleDiagramCropConfirm`에서
  파싱 실패 처리 추가함)으로 이어져서 아예 다른 계열인 Microsoft
  `microsoft/phi-3.5-vision-instruct`(4.2B, 가벼운 모델)로 교체함 — 같은
  계정/키로 쓰는 무료 엔드포인트라 비용 차이는 없음.)

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
2. **이메일 확인 리디렉션 URL 등록** — Supabase 대시보드 Authentication > URL
   Configuration에 `{mathocr 배포 도메인}/auth/callback` 추가.
3. **Vercel 환경변수 확인** — `mathocr` 프로젝트(배포에 실제 쓰이는 프로젝트)에
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `MATHPIX_APP_ID`, `MATHPIX_APP_KEY`가 들어있는지 확인.
   `NVIDIA_API_KEY`(도형 SVG 재구성용, build.nvidia.com에서 무료 발급, 분당
   40회 한도)는 선택 사항 — 없어도 원본 크롭 이미지로 대체 표시되니 앱이
   죽지 않음.
4. **실제 동작 검증** — 회원가입 → 이메일 확인 → 로그인 → 실모추가 → 오답추가 →
   PDF 내보내기 전 과정.

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
  민감정보를 다루을 때 채팅에 노출하지 말 것.

## 명령어

```bash
npm install
npm run dev     # http://localhost:3000
npm run build   # 배포 전 항상 확인
```
