-- 국어 지문 인식도 서버 큐(figure_jobs)에서 돈다(2026-09-25).
--
-- 예전에는 국어 모드가 "넣기"를 누르면 지문 인식(sol 읽기 + 서식 검수 + 지문 안
-- 그림 다시 그리기)이 끝날 때까지 화면을 붙잡았다(사용자 — "지문인식하는동안
-- 아무것도 못함"). 이제 지문 행을 사진으로 먼저 저장하고, 인식은 이 표에
-- `mode = 'passage'` 작업으로 넣는다. 일꾼이 끝나면 그 행의
-- `box_range.korean.blocks` 를 채운다(`src/lib/passageRun.ts`).
--
-- 한 번에 300초(함수 한도)를 넘길 수 있어서 **단계마다 일꾼 한 번**이다:
-- read → marks → figure(그림 하나씩). 단계가 끝나면 status 를 pending 으로 되돌려
-- 다음 일꾼이 이어서 집는다(`claim_figure_job` 은 attempts 를 제한하지 않는다).
--
-- 하위 호환이다 — 칼럼은 전부 비어도 되고 기존 두 mode 는 그대로다.

alter table public.figure_jobs drop constraint if exists figure_jobs_mode_check;
alter table public.figure_jobs
  add constraint figure_jobs_mode_check check (mode in ('figure', 'problem', 'passage'));

-- 넣을 때 브라우저가 준비해 올린 입력들(전체 사진·확대 띠·그림 사본의 경로 등).
alter table public.figure_jobs add column if not exists payload jsonb;
-- 지금 단계(read / marks / figure). 화면이 진행 문구를 고른다.
alter table public.figure_jobs add column if not exists stage text;
-- 단계 사이에 넘길 중간 결과(읽은 블록·검수 결과·그림 주소). 화면에는 안 보낸다.
alter table public.figure_jobs add column if not exists state jsonb;
-- 사람이 읽는 한 줄(예: "서식 검수 12/12문단 · 원문자 1자 고침").
alter table public.figure_jobs add column if not exists note text;

-- ─────────────────────────────────────────────────────────────────────
-- 문제 번호를 box_range.number 에 붙인다. 운영 DB 에는 오래전부터 있었는데
-- 저장소에 파일이 없었다(0022 누락) — 새 환경에서도 생기도록 여기 남긴다.
create or replace function public.set_problem_numbers(p_updates jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  uid uuid := auth.uid();
  n integer := 0;
  it jsonb;
  v_no integer;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  for it in select * from jsonb_array_elements(coalesce(p_updates, '[]'::jsonb)) loop
    v_no := nullif(it->>'number', '')::int;
    -- 번호를 못 읽은 것은 건너뛴다. null 을 써 넣으면 "번호 없음"을 굳이
    -- 덮어쓰는 셈이라 아무 이득이 없다.
    continue when v_no is null or v_no <= 0;

    update public.problems
       set box_range = coalesce(box_range, '{}'::jsonb)
                       || jsonb_build_object('number', v_no)
     where id = (it->>'id')::uuid
       and user_id = uid;

    if found then n := n + 1; end if;
  end loop;

  return n;
end;
$$;
