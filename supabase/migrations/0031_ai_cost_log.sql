-- AI 원가 장부 (2026-09-30).
--
-- 사용자 — "비용합산을 보고 싶은데 실수로 지우기를 누르면 지워지니까 시간대별로 얼마
-- 들었는지 누적해서 알고 싶음, 무제한 계정에게만 뜨게". 작업(figure_jobs)은 사용자가 치우면
-- 사라지고 원가(usage)도 같이 사라진다. 그래서 **작업과 떼어 놓은 추가 전용 장부**를 둔다.
-- 일꾼이 단계마다(그리기·sol 검수·지문 읽기·서식 검수·그림) 쓴 원가를 한 줄씩 적는다.
-- job_id 에는 외래키를 걸지 않는다 — 작업이 지워져도 장부는 남아야 한다.
--
-- 서비스 키(일꾼)만 쓰고 읽는다: RLS 만 켜고 정책을 안 둔다. 화면은 무제한 계정 전용
-- `/api/admin/ai-cost` 가 읽는다.

create table if not exists public.ai_cost_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid,
  job_id uuid,
  -- problem(문제 통째로) · figure(그림 하나) · passage(국어 지문)
  kind text not null,
  -- 그림 · sol 검수 · 지문 읽기 · 서식 검수 같은 사람이 읽는 이름
  what text not null default '',
  est_krw numeric not null default 0,
  est_usd numeric not null default 0
);

create index if not exists ai_cost_log_created on public.ai_cost_log (created_at desc);

alter table public.ai_cost_log enable row level security;

-- 시간대(한국 시간)별 합계. 서비스 키 전용.
create or replace function public.ai_cost_summary(p_since timestamptz, p_bucket text)
returns table (bucket timestamptz, krw numeric, usd numeric, calls bigint)
language sql
security definer
set search_path = public
as $$
  select
    (date_trunc(case when p_bucket = 'hour' then 'hour' else 'day' end,
                created_at at time zone 'Asia/Seoul') at time zone 'Asia/Seoul') as bucket,
    sum(est_krw), sum(est_usd), count(*)
  from public.ai_cost_log
  where created_at >= p_since
  group by 1
  order by 1 desc;
$$;

revoke all on function public.ai_cost_summary(timestamptz, text) from public, anon, authenticated;
grant execute on function public.ai_cost_summary(timestamptz, text) to service_role;
