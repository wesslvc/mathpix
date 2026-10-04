-- 짧은 AI 작업(task)의 동시 처리 상한을 올린다(2026-10-04, 사용자 — "일괄로 업로드하면 luna 가 한 번에 처리해서 자동
-- 자르기를 여러 개로 동시에 다 받고"). 사진·지면을 여러 장 고르면 장마다 luna 작업(자동 자르기·지면 자리 찾기)이 하나씩
-- 들어가는데, 사람당 4개씩만 돌면 스무 장이 다섯 바퀴를 돈다.
--   사람당 4 → 12, 전체 30 → 60. 깨우기(pg_cron)도 task 를 한 번에 12개까지.
-- 0034 의 두 함수와 몸통이 같고 숫자만 다르다(서명 그대로 — `create or replace`, DROP 없음). 그림 작업 상한은 그대로다.

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
  v_running_tasks integer;
  c_task_cap constant integer := 12;
  c_task_global constant integer := 60;
begin
  perform pg_advisory_xact_lock(hashtext('claim_figure_job'));
  perform public.recover_figure_jobs();

  select count(*) filter (where mode <> 'task'),
         count(*) filter (where mode = 'task')
    into v_running, v_running_tasks
    from public.figure_jobs where status = 'running';

  select j.id into v_id
    from public.figure_jobs j
   where j.status = 'pending'
     and (j.mode in ('figure', 'task')
          or j.problem_id is not null
          or j.created_at < now() - interval '3 minutes')
     and case
       when j.mode = 'task' then
         v_running_tasks < c_task_global
         and (
           select count(*) from public.figure_jobs r
            where r.user_id = j.user_id and r.status = 'running' and r.mode = 'task'
         ) < c_task_cap
       else
         v_running < greatest(p_global_cap, 1)
         and (
           select count(*) from public.figure_jobs r
            where r.user_id = j.user_id and r.status = 'running' and r.mode <> 'task'
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
              where r.status = 'running' and r.problem_id = j.problem_id and r.mode <> 'task'
           )
         )
     end
   order by (j.mode = 'task') desc, (j.user_id = p_prefer_user) desc nulls last, j.created_at
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

create or replace function public.kick_figure_worker()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_token text;
  v_running integer;
  v_running_tasks integer;
  v_ready integer;
  v_ready_tasks integer;
  v_kicks integer;
  i integer;
begin
  perform public.recover_figure_jobs();

  select count(*) filter (where mode <> 'task'),
         count(*) filter (where mode = 'task')
    into v_running, v_running_tasks
    from public.figure_jobs where status = 'running';

  select count(*) into v_ready
    from public.figure_jobs j
   where j.status = 'pending'
     and j.mode <> 'task'
     and (j.mode = 'figure'
          or j.problem_id is not null
          or j.created_at < now() - interval '3 minutes')
     and (
       select count(*) from public.figure_jobs r
        where r.user_id = j.user_id and r.status = 'running' and r.mode <> 'task'
     ) < case
           when exists (
             select 1 from public.entitlements e
              where e.user_id = j.user_id and e.unlimited is true
           ) then 10
           else 1
         end;

  select count(*) into v_ready_tasks
    from public.figure_jobs j
   where j.status = 'pending' and j.mode = 'task';

  v_kicks := least(coalesce(v_ready, 0), greatest(12 - v_running, 0), 10)
           + least(coalesce(v_ready_tasks, 0), greatest(60 - v_running_tasks, 0), 12);
  if v_kicks <= 0 then
    return;
  end if;

  select public.figure_worker_token() into v_token;
  if v_token is null then
    return;
  end if;

  for i in 1 .. least(v_kicks, 24) loop
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
