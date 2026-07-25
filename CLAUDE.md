# 수학오답프린트 제작 — 작업 인수인계

새 세션에서 이 저장소를 열면 이 파일을 먼저 읽고 아래 "남은 작업"부터 이어서 진행하세요.

## 무엇을 만드는 앱인가

수학 오답 사진을 올리면 → 문제 영역을 자동 감지하고 → 사용자가 크롭을 보정하고 →
Mathpix OCR로 인식해서 → 나눔명조 + KaTeX로 가독성 좋게 재구성하고 →
**변환 결과 이미지만** 계정에 저장(원본 사진은 버림) → 실전모의고사(실모)별로 모아뒀다가
→ 출처가 표시된 PDF로 인쇄하는 Next.js 앱.

- 저장소: `wesslvc/mathpix`, 작업 브랜치: `main`
- 배포: Vercel 프로젝트 `mathpix` (`mathpix-five.vercel.app`)

## 사용자가 확정한 요구사항

- **오답추가** = 특정 카테고리(실모) 안에 문제를 추가하는 버튼. 독립된 개념이 아님.
- **실모추가** = 출처(예: "2025학년도 6월 모의평가")를 입력해 카테고리를 만드는 것.
- 로그인은 **Google OAuth**.
- PDF는 **한 페이지에 문제 1개, 하단에 출처 표기**.
- 원본 사진은 저장하지 않고 변환 결과만 저장.

## 이미 끝난 것 (커밋 5a77547까지 푸시 완료)

- 업로드 → 자동 크롭 감지 → 수동 크롭 보정 → Mathpix 인식 → 결과 렌더링 → PNG 저장
- 결과 렌더링 가독성 재설계: 문단 분리, `>` 블록은 조건 박스, 첫 문단의 문제번호 굵게
  (`src/lib/renderMathText.ts`, `.mmd-*` 클래스는 `src/app/globals.css`)
- 폰트: 나눔명조 자체 호스팅(`@fontsource/nanum-myeongjo`), 수식은 KaTeX
- 앱 이름 "수학오답프린트 제작"으로 변경
- Supabase 연동 **코드 전체**: Google 로그인, 미들웨어 인증 가드, 대시보드(실모 목록),
  실모추가 폼, 카테고리 상세(오답추가 + 저장), PDF 내보내기(`pdf-lib`)
- DB 스키마 SQL: `supabase/migrations/0001_init.sql`
  (categories / problems 테이블 + RLS + `problem-images` 비공개 버킷)
- 키가 없으면 앱이 죽지 않고 안내 메시지만 표시하도록 처리 (Mathpix mock, Supabase 안내)

### 과거에 해결한 버그 (재발 시 참고)

- Mathpix가 `latex_styled`만 주거나 `\( \)` / `\[ \]` 델리미터를 쓰면 LaTeX가 그대로
  글자로 보이던 문제 → `renderMathText`에서 델리미터 정규화 + 델리미터 없는 순수
  LaTeX는 통째로 블록 수식 처리
- 아이폰 사진(수천 px)을 무압축 PNG data URL로 보내다 Safari에서
  "The string did not match the expected pattern." 발생 → `src/lib/cropImage.ts`에서
  긴 변 1600px 이하 + JPEG 품질 0.9로 압축해 전송
- HEIC/HEIF 업로드 시 안내 메시지 표시

## 남은 작업 (여기서부터 이어서)

1. **Supabase 프로젝트 준비** — 사용자가 "seji 프로젝트를 복사해서 만들어달라"고 요청함.
   Supabase MCP 커넥터로 프로젝트를 만들고, `supabase/migrations/0001_init.sql`을
   `apply_migration`으로 실행. Authentication > Providers에서 Google OAuth 활성화 필요
   (대시보드에서 직접 해야 할 수 있음).
2. **환경변수 설정** — Vercel 프로젝트 `mathpix`에 아래 두 개 추가 후 재배포:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   (`MATHPIX_APP_ID`, `MATHPIX_APP_KEY`는 이미 설정돼 있음)
3. **프로덕션 배포** — 아래 "주의" 참고. 커밋 5a77547이 아직 프로덕션에 안 올라가 있음.
4. **실제 동작 검증** — 로그인 → 실모추가 → 오답추가 → PDF 내보내기 전 과정.

## 주의할 점

- **Vercel의 Production Branch가 `main`을 따라가지 않음.** git push해도 프리뷰만 빌드되고
  프로덕션에 반영되지 않는다. Vercel 프로젝트 Settings > Git에서 Production Branch를
  `main`으로 바꾸는 것이 근본 해결책. 그 전까지는 `deploy_to_vercel`로 직접
  `target: "production"` 배포해야 한다.
- 이전 세션에서 중복 스캐폴드 브랜치 3개(`claude/math-problem-image-recognition-*`)가
  원격에 남아 있음. 삭제 권한이 없어 방치 중이며, 내용은 `main`에 모두 반영돼 있으니 무시해도 된다.
- 사용자가 채팅에 Mathpix API 키를 평문으로 붙여넣은 적 있음. 재발급을 권고했으나
  확인되지 않음. 키를 다룰 때 채팅에 노출하지 말 것.

## 명령어

```bash
npm install
npm run dev     # http://localhost:3000
npm run build   # 배포 전 항상 확인
```
