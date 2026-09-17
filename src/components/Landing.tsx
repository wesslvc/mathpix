import Link from "next/link";

/**
 * 로그아웃 상태로 `/` 에 왔을 때 보여주는 **공개 소개 화면**.
 *
 * **왜 만들었나 — 구글에 색인될 내용이 하나도 없었다.** 예전에는 미들웨어가
 * 로그아웃 사용자를 전부 `/login` 으로 보냈고, 그 화면에는 로그인 폼밖에
 * 없었다. 검색 엔진이 크롤링해도 "이 사이트가 무엇을 하는 곳인지" 알려주는
 * 글이 한 줄도 없으니 어떤 검색어로도 뜰 수가 없다. 색인될 **내용**이
 * 먼저고 robots·sitemap 은 그 다음이다.
 *
 * 그래서 이 화면의 글은 장식이 아니라 **검색어 그 자체**다. 사람들이 실제로
 * 치는 말(오답노트, 오답 정리, 모의고사, 평가원 양식, 자동채점, OMR)이
 * 제목(h1/h2)과 본문에 자연스럽게 들어가 있어야 한다 — 예쁜 표어만 늘어놓으면
 * 사람에게도 검색 엔진에도 아무 말도 안 한 것이 된다.
 *
 * **`landing-root` 클래스는 전역 내비를 감추는 표시다.** AppNav 는 앱 안쪽
 * 링크(실모·채점·성적)를 늘어놓는데, 아직 로그인하지 않은 사람에게는 전부
 * 로그인 화면으로 되돌아오는 링크라 보여줄 이유가 없다. 레이아웃에서 로그인
 * 여부를 읽으면 앱 전체가 동적 렌더로 바뀌므로(`cookies()`), 대신
 * `globals.css` 가 `body:has(.landing-root)` 로 감춘다 — 값이 0이고 못
 * 알아듣는 옛 브라우저에서는 내비가 그냥 보일 뿐이라 깨지지 않는다.
 */
export default function Landing() {
  return (
    <div className="landing-root">
      {/* 검색 결과에 제품 카드로 뜨게 하는 구조화 데이터. 사람 눈에는 안
          보이지만 크롤러가 "이게 무슨 종류의 사이트인지" 읽는 자리다. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "WebApplication",
            name: "ReprintOCR",
            alternateName: "리프린트OCR 오답프린트 제작",
            applicationCategory: "EducationalApplication",
            operatingSystem: "Web",
            inLanguage: "ko",
            description:
              "문제 사진을 인식해 오답을 정리하고, 실제 수능·모의고사 판형 그대로 PDF로 인쇄하는 오답노트 제작 도구.",
            offers: { "@type": "Offer", price: "0", priceCurrency: "KRW" },
            publisher: { "@type": "Organization", name: "NEPICA" },
          }),
        }}
      />

      <main className="mx-auto flex w-full max-w-3xl flex-col gap-16 px-4 pb-16 pt-10">
        {/* ── 첫 화면 ─────────────────────────────────────────────── */}
        <section className="flex flex-col items-center text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/magpie-paper-512.png"
            alt="ReprintOCR 로고 — 종이를 문 물까치"
            width={96}
            height={96}
            className="h-24 w-24 select-none"
            draggable={false}
          />
          <span className="mt-2 font-display text-3xl font-semibold tracking-tight text-ink">
            Reprint<span className="text-gblue">OCR</span>
          </span>
          <p className="mt-2 font-display text-[0.7rem] font-medium uppercase tracking-[0.2em] text-slate-500">
            Print what you got wrong
          </p>

          <h1 className="mt-6 text-balance text-2xl font-semibold leading-snug text-ink sm:text-3xl">
            틀린 문제만 모아 실제 시험지처럼 인쇄하는
            <br />
            오답노트 제작 도구
          </h1>
          <p className="mt-4 max-w-xl text-pretty text-sm leading-relaxed text-slate-600 sm:text-base">
            문제 사진을 올리면 수식까지 인식해 깨끗하게 다시 그려주고,
            실전모의고사별로 오답을 모아뒀다가 평가원 문제지 판형 그대로 PDF로
            뽑아 풀 수 있습니다. 수학·국어·영어·탐구 모두 됩니다.
          </p>

          <div className="mt-7 flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row">
            <Link
              href="/login"
              className="w-full rounded-lg bg-blue-600 px-6 py-3 text-center text-sm font-medium text-white hover:bg-blue-700 sm:w-auto"
            >
              무료로 시작하기
            </Link>
            <span className="text-xs text-slate-500">
              Google 계정으로 3초면 시작합니다
            </span>
          </div>
        </section>

        {/* ── 기능 ────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-8">
          <h2 className="text-center text-lg font-semibold text-ink">
            오답 정리에 드는 시간을 사진 한 장으로 줄입니다
          </h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <Feature title="문제 사진을 그대로 인식합니다">
              분수·적분 같은 수식도 문자로 인식해 다시 조판하므로, 손으로 옮겨
              적거나 캡처를 오려 붙일 필요가 없습니다. 인쇄된 표와 도형도 함께
              살려냅니다.
            </Feature>
            <Feature title="필기 흔적은 지우고 인쇄물만 남깁니다">
              채점 표시나 손으로 그은 밑줄은 지우고, 인쇄된 밑줄·굵은 글씨처럼
              문제의 일부인 표시는 그대로 둡니다. 다시 풀기 좋은 상태로
              돌아갑니다.
            </Feature>
            <Feature title="실전모의고사별로 모아둡니다">
              &ldquo;2026학년도 6월 모의평가&rdquo;처럼 출처별로 묶어두고,
              폴더로 정리할 수 있습니다. 문제 번호는 자동으로 읽어 순서대로
              정렬됩니다.
            </Feature>
            <Feature title="평가원 판형 그대로 인쇄합니다">
              실제 수능·모의고사 문제지와 같은 판형·글꼴·단 구성으로 PDF를
              만듭니다. 맨 뒤에는 정답표가 붙고, 내가 골랐던 오답까지 함께
              표시됩니다.
            </Feature>
            <Feature title="OMR 사진으로 자동채점합니다">
              OMR 카드와 정답표를 찍어 올리면 문항별로 채점해 점수를 냅니다.
              틀린 문제는 그대로 오답 목록으로 이어집니다.
            </Feature>
            <Feature title="성적 추세를 한눈에 봅니다">
              회차별 점수와 등급을 과목별 그래프로 쌓아 보여줍니다. 채점하지
              않은 시험은 점수만 직접 적어 넣어도 같은 그래프에 올라갑니다.
            </Feature>
          </div>
        </section>

        {/* ── 이런 분께 ───────────────────────────────────────────── */}
        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-ink">이런 분들이 씁니다</h2>
          <ul className="flex flex-col gap-2 text-sm leading-relaxed text-slate-600">
            <li>
              · 모의고사를 자주 보는데 <strong>오답 정리에 시간이 너무 많이
              드는</strong> 수험생
            </li>
            <li>
              · 오답노트를 만들어도 <strong>다시 풀 수 있는 형태가 아니라</strong>{" "}
              눈으로만 훑게 되는 분
            </li>
            <li>
              · 여러 회차에서 틀린 문제를 <strong>한 권으로 묶어 인쇄</strong>하고
              싶은 분
            </li>
            <li>
              · 국어 지문과 문항을 <strong>펼침면에 나란히</strong> 놓고 풀고 싶은
              분
            </li>
          </ul>
        </section>

        {/* ── 마무리 ──────────────────────────────────────────────── */}
        <section className="flex flex-col items-center gap-4 rounded-xl border border-slate-200 bg-white px-6 py-10 text-center">
          <h2 className="text-lg font-semibold text-ink">
            오늘 틀린 문제부터 시작해보세요
          </h2>
          <p className="max-w-md text-sm leading-relaxed text-slate-600">
            사진 몇 장이면 첫 오답프린트가 나옵니다. 원본 사진은 저장하지 않고
            변환된 결과만 계정에 남습니다.
          </p>
          <Link
            href="/login"
            className="rounded-lg bg-blue-600 px-6 py-3 text-sm font-medium text-white hover:bg-blue-700"
          >
            시작하기
          </Link>
        </section>
      </main>
    </div>
  );
}

function Feature({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">{children}</p>
    </div>
  );
}
