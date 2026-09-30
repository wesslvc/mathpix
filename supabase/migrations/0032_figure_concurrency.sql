-- AI 작업 큐의 동시 처리 (2026-09-30).
--
-- 예전에는 **한 사람당 한 번에 하나**였다(`not exists (running)`). 무제한 계정은 이제 여러 개를 동시에
-- 돌린다(사용자 — "무제한 계정은 10개씩 돌리게"). 규칙:
--   · 무제한 계정 : 한 번에 p_unlimited_cap(기본 10)개까지
--   · 그 밖의 계정 : 예전처럼 1개
--   · 전체 합계   : p_global_cap(기본 12)개까지 — OpenAI Tier 2 이미지 한도(20 IPM)를 넘지 않게 여유를 둔다.
--   · **같은 문제 행에 쓰는 작업은 동시에 안 돈다** — 그림 하나 모드가 box_range 를 읽고 통째로 다시 쓰므로
--     둘이 겹치면 한쪽 그림이 지워진다.
-- 두 일꾼이 동시에 집어 상한을 넘기지 않게 advisory lock 으로 집는 일을 한 줄로 세운다.
-- (`claim_figure_job(uuid)` 를 지우고 새로 만든다 — 남겨 두면 호출이 모호해진다.)

drop function if exists public.claim_figure_job(uuid);

create or replace function public.claim_figure_job(
  p_prefer_user uuid default null,
  p_unlimited_cap integer default 10,
  p_global_cap integer default 12
)
returns setof public.figure_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_running integer;
begin
  perform pg_advisory_xact_lock(hashtext('claim_figure_job'));
  perform public.recover_figure_jobs();

  select count(*) into v_running from public.figure_jobs where status = 'running';
  if v_running >= greatest(p_global_cap, 1) then
    return;
  end if;

  select j.id into v_id
    from public.figure_jobs j
   where j.status = 'pending'
     and (j.mode = 'figure'
          or j.problem_id is not null
          or j.created_at < now() - interval '3 minutes')
     and (
       select count(*) from public.figure_jobs r
        where r.user_id = j.user_id and r.status = 'running'
     ) < case
           when exists (
             select 1 from public.entitlements e
              where e.user_id = j.user_id and e.unlimited is true
           ) then greatest(p_unlimited_cap, 1)
           else 1
         end
     and (
       j.problem_id is null
       or not exists (
         select 1 from public.figure_jobs r
          where r.status = 'running' and r.problem_id = j.problem_id
       )
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

revoke all on function public.claim_figure_job(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_figure_job(uuid, integer, integer) to service_role;

-- pg_cron 이 1분마다 부르는 깨우기. 예전에는 "일하는 중인 사람이 없는 사람 수"만큼(최대 3) 깨웠다.
-- 이제는 집을 수 있는 작업 수만큼(사용자·전체 상한 안에서, 최대 10) 깨운다. 남는 요청은 그냥 idle 로 끝난다.
create or replace function public.kick_figure_worker()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_token text;
  v_running integer;
  v_ready integer;
  v_kicks integer;
  i integer;
begin
  perform public.recover_figure_jobs();

  select count(*) into v_running from public.figure_jobs where status = 'running';

  select count(*) into v_ready
    from public.figure_jobs j
   where j.status = 'pending'
     and (j.mode = 'figure'
          or j.problem_id is not null
          or j.created_at < now() - interval '3 minutes')
     and (
       select count(*) from public.figure_jobs r
        where r.user_id = j.user_id and r.status = 'running'
     ) < case
           when exists (
             select 1 from public.entitlements e
              where e.user_id = j.user_id and e.unlimited is true
           ) then 10
           else 1
         end;

  v_kicks := least(coalesce(v_ready, 0), greatest(12 - v_running, 0), 10);
  if v_kicks <= 0 then
    return;
  end if;

  select public.figure_worker_token() into v_token;
  if v_token is null then
    return;
  end if;

  for i in 1 .. v_kicks loop
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
