# NEPICA — 브랜드 사이트

<https://nepica.vercel.app>

NEPICA 가 만든 세 사이트(지오글 · 리프린트OCR · VDIC)와 브랜드 가치를 소개하는
한 쪽짜리 정적 사이트다. 빌드 도구가 없다 — `index.html` · `style.css` ·
`img/` 셋뿐이라 그대로 올리면 그게 곧 배포다.

## 값은 지오글에서 가져온다

색·글꼴·모서리·그림자는 지오글(`wesslvc/seji`)의 `css/main.css` 와 **같은
값**을 쓴다. 브랜드 사이트가 제품과 다른 값을 쓰면 "같은 곳에서 만들었다"는
말이 그 자리에서 무너지기 때문이다. 제품 쪽 값을 고치면 여기도 함께 고칠 것.

- 어두운 화면이 기본, 밝은 화면은 `prefers-color-scheme` 으로 지오글의
  라이트 모드 팔레트를 그대로 내준다.
- 본문 Pretendard · 표시용 Space Grotesk.

## 마크

물까치(*Cyanopica cyanus*) 한 마리를 세 제품이 나눠 쓴다. 새를 다시 그리지
않고 **무엇을 물고 있느냐**만 바꾼다.

| 파일 | 쓰는 곳 |
| --- | --- |
| `img/magpie-512.png` | NEPICA — 아무것도 물지 않음 |
| `img/magpie-globe-512.png` | 지오글 — 지구본 |
| `img/magpie-paper-512.png` | 리프린트OCR — 종이 |
| `img/magpie-book-512.png` | VDIC — 책 |

원본 그림은 검은 바탕 위에 그려져 있다. 밝기만 보고 배경을 지우면 **새의
검은 두건까지 함께 잘려 나가므로**, 가장자리에서 시작하는 채우기(flood
fill)로 바깥의 검정만 지워 투명 PNG 로 만들었다. 마크를 다시 만들 일이
있으면 이 점을 먼저 볼 것.
