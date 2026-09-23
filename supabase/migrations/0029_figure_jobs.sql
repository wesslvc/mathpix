-- AI 그림 작업 큐를 브라우저에서 서버로 옮긴다.
--
-- 예전에는 큐가 브라우저 안(FigureJobsProvider)에서 돌아서, 탭을 닫거나
-- 새로고침하면 대기 중이던 작업이 통째로 사라졌다(사용자 신고 — "나가면 다
-- 초기화돼서 너무 귀찮아"). 이제 작업은 이 표에 들어가고, 서버 일꾼
-- (`/api/figure-jobs/run`)이 하나씩 집어 가 처리한다. 브라우저는 넣고 지켜볼 뿐이다.
--
-- 일꾼을 깨우는 길은 셋이다:
--   ① 작업을 넣은 직후 라우트가 한 번 깨운다(가장 빠르다).
--   ② 일꾼이 하나를 끝내면 스스로 다음 일꾼을 부른다.
--   ③ 그래도 멈추면 pg_cron 이 1분마다 pg_net 으로 깨운다(아래 kick).
-- ③이 있어서 브라우저가 하나도 안 열려 있어도 줄이 끝까지 간다.

create table if not exists public.figure_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- 화면이 그림을 가리키는 id(= box_range.figures[].id). 화면 쪽 작업 id 와 같다.
  figure_id text not null,
  problem_key text not null default '',
  problem_id uuid references public.problems(id) on delete cascade,
  label text not null default '',
  mode text not null default 'figure' check (mode in ('figure', 'problem')),
  korean boolean not null default false,
  instruction text,
  -- 모델에 보낼 그림(이미 줄여 둔 JPEG). R2 또는 problem-images 버킷의 경로.
  input_path text not null,
  width integer,
  height integer,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'done', 'error')),
  attempts integer not null default 0,
  -- 넣을 때 보증금을 걸었는가, 얼마를 걸었는가. 실패하면 이만큼 돌려준다.
  charged boolean not null default false,
  charged_tokens integer not null default 0,
  usage jsonb,
  model text,
  -- 완성된 그림의 경로. 문제 전체 모드에서는 곧 그 문제의 image_path 다.
  result_path text,
  -- 합쳐진 카드 PNG(image_path)까지 반영됐는가. 그림 하나 모드는 카드를 다시
  -- 그려야 해서 브라우저가 반영하고 이 칸을 채운다.
  applied_at timestamptz,
  -- 목록에서 치운 것. 도는 중인 작업은 멈출 수 없어 숨기기만 한다.
  dismissed boolean not null default false,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

-- 같은 그림을 두 번 넣지 않는다 — 작업 하나가 곧 유료 호출 한 번이다.
create unique index if not exists figure_jobs_active_figure
  on public.figure_jobs (user_id, figure_id)
  where status in ('pending', 'running') and not dismissed;

create index if not exists figure_jobs_pending
  on public.figure_jobs (created_at) where status = 'pending';
create index if not exists figure_jobs_user_created
  on public.figure_jobs (user_id, created_at desc);

alter table public.figure_jobs enable row level security;

-- 읽기만 본인 것. 쓰기는 전부 서버 라우트가 service_role 로 한다
-- (과금과 얽혀 있어 화면이 직접 고치게 두면 안 된다).
drop policy if exists "figure_jobs own read" on public.figure_jobs;
create policy "figure_jobs own read" on public.figure_jobs
  for select using (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────
-- 서비스용 환불. 기존 refund_recognition_credit 은 auth.uid() 를 쓰므로
-- 사용자 세션이 없는 일꾼은 부를 수 없다.
create or replace function public.refund_recognition_credit_for(
  p_user_id uuid,
  p_amount integer
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  remaining integer;
begin
  if p_amount is null or p_amount <= 0 then
    return null;
  end if;
  update public.entitlements
     set credits = credits + p_amount, updated_at = now()
   where user_id = p_user_id
  returning credits into remaining;
  return remaining;
end;
$$;

revoke all on function public.refund_recognition_credit_for(uuid, integer) from public, anon, authenticated;
grant execute on function public.refund_recognition_credit_for(uuid, integer) to service_role;

-- ─────────────────────────────────────────────────────────────────────
-- 오래 멈춘 작업을 정리한다.
--
-- 일꾼 함수의 한도가 300초라, 시작한 지 7분이 넘도록 running 이면 그 일꾼은
-- 이미 죽었다(Vercel 이 끊었거나 배포가 바뀌었다). 보증금을 돌려주고 오류로
-- 둔다 — 사용자가 "다시 시도"를 누를 수 있다.
create or replace function public.recover_figure_jobs()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n integer := 0;
begin
  for r in
    with stale as (
      select id, user_id, charged, charged_tokens
        from public.figure_jobs
       where status = 'running'
         and started_at < now() - interval '7 minutes'
       for update skip locked
    )
    update public.figure_jobs j
       set status = 'error',
           error = '서버 작업이 중간에 끊겼어요. 토큰은 돌려드렸어요. 다시 시도해주세요.',
           finished_at = now(),
           charged = false,
           charged_tokens = 0
      from stale
     where j.id = stale.id
    returning stale.user_id, stale.charged_tokens, stale.charged as had_charge
  loop
    if r.had_charge then
      perform public.refund_recognition_credit_for(r.user_id, r.charged_tokens);
    end if;
    n := n + 1;
  end loop;

  -- 끝난 지 오래된 기록은 지운다(목록이 끝없이 길어지지 않게).
  delete from public.figure_jobs
   where status in ('done', 'error')
     and coalesce(finished_at, created_at) < now() - interval '14 days';

  return n;
end;
$$;

revoke all on function public.recover_figure_jobs() from public, anon, authenticated;
grant execute on function public.recover_figure_jobs() to service_role;

-- ─────────────────────────────────────────────────────────────────────
-- 다음 작업 하나를 집는다.
--
-- - **사람마다 한 번에 하나.** 그 사람의 작업이 이미 돌고 있으면 건너뛴다 —
--   브라우저 큐가 순서대로 돌던 것과 같은 모양이고, 한 사람이 스무 개를 넣어도
--   다른 사람의 작업이 그 뒤에 줄 서지 않는다(사람끼리는 동시에 돈다).
-- - 문제 전체 모드는 **저장된 행을 알아야** 결과를 그 행에 바로 저장할 수 있다.
--   화면이 넣자마자 저장을 걸어 두므로 곧 채워진다 — 3분이 지나도 안 채워지면
--   그냥 돌린다(결과는 화면이 살아 있으면 화면이 반영한다).
-- - `skip locked` 라 일꾼 여럿이 동시에 불러도 같은 작업을 둘이 집지 않는다.
create or replace function public.claim_figure_job(p_prefer_user uuid default null)
returns setof public.figure_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform public.recover_figure_jobs();

  select j.id into v_id
    from public.figure_jobs j
   where j.status = 'pending'
     and (j.mode = 'figure'
          or j.problem_id is not null
          or j.created_at < now() - interval '3 minutes')
     and not exists (
       select 1 from public.figure_jobs r
        where r.user_id = j.user_id and r.status = 'running'
     )
   order by (j.user_id = p_prefer_user) desc nulls last, j.created_at
   limit 1
   for update skip locked;

  if v_id is null then
    return;
  end if;

  return query
    update public.figure_jobs
       set status = 'running',
           started_at = now(),
           attempts = attempts + 1,
           error = null
     where id = v_id
    returning *;
end;
$$;

revoke all on function public.claim_figure_job(uuid) from public, anon, authenticated;
grant execute on function public.claim_figure_job(uuid) to service_role;

-- ─────────────────────────────────────────────────────────────────────
-- 일꾼 라우트를 부를 때 쓰는 비밀값.
--
-- **DB 안에서 만들어 Vault 에만 둔다** — 값이 대화에도 커밋에도 나오지 않는다.
-- 라우트는 service_role 로 figure_worker_token() 을 불러 같은 값을 받아 대조한다.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'figure_worker_token') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      'figure_worker_token',
      'pg_cron -> /api/figure-jobs/run 호출 인증'
    );
  end if;
end;
$$;

create or replace function public.figure_worker_token()
returns text
language sql
security definer
set search_path = public
as $$
  select decrypted_secret from vault.decrypted_secrets
   where name = 'figure_worker_token' limit 1;
$$;

revoke all on function public.figure_worker_token() from public, anon, authenticated;
grant execute on function public.figure_worker_token() to service_role;

-- ─────────────────────────────────────────────────────────────────────
-- 1분마다 일꾼을 깨운다.
--
-- 평소에는 ①②로 충분해서 이건 아무 일도 안 한다(집을 게 없으면 요청을 안
-- 보낸다). 일꾼이 죽었거나 자기 호출이 유실됐을 때 줄을 다시 굴리는 안전망이다.
-- 기다리는 사람 수만큼(최대 3) 부른다 — 사람끼리는 동시에 돌 수 있다.
create extension if not exists pg_net with schema extensions;

create or replace function public.kick_figure_worker()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_token text;
  v_users integer;
  i integer;
begin
  perform public.recover_figure_jobs();

  select count(distinct j.user_id) into v_users
    from public.figure_jobs j
   where j.status = 'pending'
     and (j.mode = 'figure'
          or j.problem_id is not null
          or j.created_at < now() - interval '3 minutes')
     and not exists (
       select 1 from public.figure_jobs r
        where r.user_id = j.user_id and r.status = 'running'
     );
  if coalesce(v_users, 0) = 0 then
    return;
  end if;

  select public.figure_worker_token() into v_token;
  if v_token is null then
    return;
  end if;

  for i in 1 .. least(v_users, 3) loop
    perform net.http_post(
      url := 'https://reprintocr.vercel.app/api/figure-jobs/run',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-worker-token', v_token
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 5000
    );
  end loop;
end;
$$;

revoke all on function public.kick_figure_worker() from public, anon, authenticated;

select cron.unschedule('figure-worker-kick')
 where exists (select 1 from cron.job where jobname = 'figure-worker-kick');
select cron.schedule('figure-worker-kick', '* * * * *', 'select public.kick_figure_worker()');
