# 오답프린트 제작

수학 문제(오답) 사진을 업로드하면

1. 문제 영역을 자동으로 감지하고
2. 사용자가 크롭 범위를 최종 확인/조정한 뒤
3. Mathpix OCR API로 텍스트/LaTeX를 인식하고
4. 가독성 좋은 폰트(나눔명조 + KaTeX)로 문제번호·조건 박스까지 재구성해
5. 로그인한 계정에 **변환 결과 이미지만**(원본 사진은 저장하지 않음)
   실전모의고사(실모) 단위로 계속 모아두었다가
6. 실모별로 출처가 표시된 PDF로 한 번에 내보낼 수 있는 Next.js 앱입니다.

Mathpix API 키, Supabase 프로젝트를 아직 준비하지 않아도 전체 플로우를
그대로 개발/테스트할 수 있도록, 필요한 값이 없으면 각각 **mock 응답** /
**"설정이 필요합니다" 안내**를 보여줍니다.

## 실행 방법

```bash
npm install
npm run dev
```

`http://localhost:3000` 접속.

## Mathpix API 연동

1. https://mathpix.com/ 에서 앱을 등록하고 `app_id`, `app_key`를 발급받습니다.
2. `.env.example`을 복사해 `.env.local`을 만들고 값을 채웁니다.

```bash
cp .env.example .env.local
```

```
MATHPIX_APP_ID=...
MATHPIX_APP_KEY=...
```

키가 비어 있으면 `/api/mathpix`가 예시 LaTeX/텍스트를 반환해 UI를 그대로
확인할 수 있습니다. 실제 API 응답 스키마(`text`, `latex_styled`,
`confidence` 등)는 [Mathpix v3/text 문서](https://docs.mathpix.com/)를
참고해 `src/lib/mathpixClient.ts`에서 필요에 맞게 확장하세요.

## Supabase 연동 (로그인 / 저장 / PDF)

1. https://supabase.com/dashboard 에서 프로젝트를 생성합니다.
2. 로그인은 이메일/비밀번호 방식이며, Supabase 프로젝트에는 **Email** 프로바이더가
   기본으로 켜져 있어 별도 설정이 필요 없습니다.
3. **SQL Editor**에서 `supabase/migrations/0001_init.sql`을 그대로 실행해
   `categories`(실모), `problems`(오답) 테이블과 `problem-images`
   스토리지 버킷, RLS 정책을 만듭니다.
4. **Project Settings > API**에서 URL과 anon key를 확인해 `.env.local`에
   채웁니다.
5. **Authentication > URL Configuration**의 Redirect URLs에
   `{배포 주소}/auth/callback`(로컬 테스트는 `http://localhost:3000/auth/callback`)을
   추가해야 회원가입 확인 메일의 링크가 정상 동작합니다.

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

값이 없으면 로그인/대시보드/카테고리 페이지 모두 "Supabase 설정이 필요"
안내만 표시하고 앱이 죽지 않습니다.

## 폴더 구조 / 핵심 로직

- `src/app/page.tsx` — 대시보드: 로그인한 사용자의 실모(카테고리) 목록
- `src/app/login/page.tsx` — 이메일/비밀번호 로그인·회원가입
- `src/app/auth/callback/route.ts` — Supabase OAuth 콜백(코드 → 세션 교환)
- `src/middleware.ts` — 세션 갱신 + 미로그인 시 `/login`으로 리다이렉트
- `src/app/categories/[id]/page.tsx` — 실모 상세: 저장된 오답 목록,
  오답추가, PDF 내보내기
- `src/components/AddProblemFlow.tsx` — 업로드 → 크롭 → 인식 → 저장까지
  이어지는 상태 머신(기존 단일 플로우를 카테고리에 저장하도록 확장)
- `src/components/ImageUploader.tsx` / `CropStage.tsx` — 드래그앤드롭
  업로드, `react-image-crop` 기반 크롭 UI. 이미지가 로드되면
  `detectContentRegion`으로 자동 추천 영역을 계산해 초기 크롭 값으로
  넣어주고, 손잡이를 끌어 자유롭게 보정할 수 있습니다.
- `src/lib/autoDetectRegion.ts` — 배경 대비 어두운 픽셀(잉크) 밀도를
  분석해 문제 영역 bounding box를 추정하는 휴리스틱.
- `src/lib/cropImage.ts` — 크롭 결과를 긴 변 1600px 이하 JPEG로
  압축해 큰 사진에서도 업로드가 실패하지 않게 합니다.
- `src/app/api/mathpix/route.ts` + `src/lib/mathpixClient.ts` — Mathpix
  프록시. 브라우저에 API 키를 노출하지 않기 위해 서버 라우트를 통해서만
  호출합니다.
- `src/lib/renderMathText.ts` — Mathpix의 mmd 텍스트를 KaTeX로 렌더링하는
  파서. 문단(빈 줄) 단위로 나누고, `>`로 시작하는 블록은 조건 박스로,
  첫 문단 맨 앞의 문제 번호는 굵게 강조합니다.
- `src/components/ResultStage.tsx` — 결과 카드 렌더링(폰트 크기 조절) +
  `html-to-image`로 PNG 변환, "오답으로 저장"(카테고리 저장) 버튼.
- `src/lib/supabase/` — 브라우저/서버용 Supabase 클라이언트, 환경변수
  헬퍼, 타입.
- `src/components/ExportPdfButton.tsx` — `pdf-lib`로 실모의 저장된 문제
  이미지를 한 페이지에 1개씩, 하단에 출처를 표기해 PDF로 내보냅니다
  (한글 출처 표기를 위해 `public/fonts`에 나눔명조 폰트를 자체 호스팅).

## 데이터 모델 (Supabase)

- `categories` (실모): `source`(출처), `user_id`
- `problems` (오답): `category_id`, `image_path`(Storage 경로), `latex`,
  `text_content` — **원본 사진은 저장하지 않고 변환 결과 이미지만** 저장
- `problem-images` 스토리지 버킷은 비공개이며, `${user_id}/...` 폴더
  경로 기준 RLS로 본인 데이터만 접근 가능합니다.

## 가독성 관련 선택

- 본문 폰트는 시험지/문제집 느낌의 가독성 좋은 명조체인
  **나눔명조(Nanum Myeongjo)**를 사용합니다(`@fontsource/nanum-myeongjo`로
  자체 호스팅, 외부 CDN 호출 없음).
- 수식은 **KaTeX**로 렌더링하며, 결과 화면에서 폰트 크기(보통/크게/아주
  크게)를 즉시 조절할 수 있습니다.
- 필요하면 `tailwind.config.ts`의 `fontFamily`나
  `src/app/globals.css`에서 폰트/자간/줄간격을 더 조정하세요.

## 다음 단계로 고려할 것

- 실제 Mathpix 응답의 confidence/오류 케이스에 맞춘 UX 보강
- 자동 크롭 정확도 향상(현재는 단순 명암 임계값 기반 휴리스틱)
- 결과 편집(직접 텍스트/LaTeX 수정 후 재렌더링) 기능
- 오답/카테고리 삭제, 실모 이름 수정 등 관리 기능
- PDF 여러 문제/페이지 레이아웃 옵션 추가
