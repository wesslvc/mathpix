# 문제 이미지 재구성기

사용자가 문제(주로 수학) 사진을 업로드하면

1. 문제 영역을 자동으로 감지하고
2. 사용자가 크롭 범위를 최종 확인/조정한 뒤
3. Mathpix OCR API로 텍스트/LaTeX를 인식하고
4. 가독성 좋은 폰트(Pretendard + KaTeX)로 다시 렌더링해
5. 최종 이미지를 PNG로 저장할 수 있게 해주는 Next.js 스캐폴드입니다.

Mathpix API 키를 아직 구매하지 않아도 전체 플로우를 그대로 개발/테스트할 수
있도록, 키가 없으면 서버가 **mock(예시) 응답**을 반환합니다.

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

## 폴더 구조 / 핵심 로직

- `src/app/page.tsx` — 업로드 → 크롭 → 결과 3단계 상태 머신
- `src/components/ImageUploader.tsx` — 드래그앤드롭/클릭 업로드
- `src/components/CropStage.tsx` — `react-image-crop` 기반 크롭 UI.
  이미지가 로드되면 `detectContentRegion`으로 자동 추천 영역을 계산해
  초기 크롭 값으로 넣어주고, 사용자가 손잡이를 끌어 자유롭게 보정할 수
  있습니다.
- `src/lib/autoDetectRegion.ts` — 배경 대비 어두운 픽셀(잉크) 밀도를
  분석해 문제 영역 bounding box를 추정하는 휴리스틱. 정교한 세그멘테이션이
  필요하면 이 함수를 서버 사이드 CV 모델이나 Mathpix의 자체 영역 인식
  결과로 교체하면 됩니다.
- `src/app/api/mathpix/route.ts` + `src/lib/mathpixClient.ts` — Mathpix
  프록시. 브라우저에 API 키를 노출하지 않기 위해 서버 라우트를 통해서만
  호출합니다.
- `src/lib/renderMathText.ts` — Mathpix의 mmd(텍스트+`$...$`/`$$...$$`)
  결과를 KaTeX로 렌더링하는 파서.
- `src/components/ResultStage.tsx` — 결과 카드 렌더링(폰트 크기 조절 포함)
  + `html-to-image`로 PNG 내보내기, LaTeX 복사.

## 가독성 관련 선택

- 본문 폰트는 한글/영문 모두 가독성이 좋은 **Pretendard Variable**을
  사용합니다.
- 수식은 **KaTeX**로 렌더링하며, 결과 화면에서 폰트 크기(보통/크게/아주
  크게)를 즉시 조절할 수 있습니다.
- 필요하면 `tailwind.config.ts`의 `fontFamily`나
  `src/app/globals.css`에서 폰트/자간/줄간격을 더 조정하세요.

## 다음 단계로 고려할 것

- 실제 Mathpix 응답의 confidence/오류 케이스에 맞춘 UX 보강
- 자동 크롭 정확도 향상(현재는 단순 명암 임계값 기반 휴리스틱)
- 결과 편집(직접 텍스트/LaTeX 수정 후 재렌더링) 기능
- 인증/사용량 제한 등 배포 전 보안 검토
