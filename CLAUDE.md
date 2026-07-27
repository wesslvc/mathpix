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
  `meta/llama-3.2-90b-vision-instruct` 모델(OpenAI 호환 chat/completions 형식,
  `NVIDIA_API_KEY` 환경변수)로 보내 깨끗한 SVG로 재구성해 문제 밑에 추가로
  붙인다. **크레딧 정책**: OCR 1회 = 1개, 도형 추가인식 1회(클릭당) = 2개
  — 둘 다 하면 문제 하나에 총 3개 차감(`supabase/migrations/0009_diagram_credit_amount.sql`에서
  `consume_recognition_credit`/`refund_recognition_credit`이 `p_amount`를
  받도록 바뀌). `NVIDIA_API_KEY`가 없으면 이 버튼을 눌러도 에러 메시지만
  뜨고 크레딧은 차감되지 않음(자동 raster 표시는 키 없이도 그대로 동작).
  (Gemini API를 먼저 써봤으나 계정에 `gemini-2.0-flash`가 사라져 있고
  `gemini-2.5-flash`도 첫 시도부터 429가 계속 나서, 분당 40회 무료 한도가
  있는 NVIDIA API 카탈로그로 교체함 — `GEMINI_API_KEY` 관련 코드는 이제
  안 쓴. 처음엔 가보운 `nvidia/nemotron-nano-12b-v2-vl`을 써다 도형
  재구성 품질이 너무 떨어져 `meta/llama-3.2-90b-vision-instruct`로 올림
  — 같은 계정/키로 쓰는 무료 엔드포인트라 비용 차이는 없음.)