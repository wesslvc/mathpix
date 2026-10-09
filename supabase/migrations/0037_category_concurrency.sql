-- 범주가 다른 작업은 서로 기다리지 않는다 — 무제한 계정 한정(2026-10-09, 사용자 — "서로 다른 범주의 것들은 무제한
-- 계정 한정으로 최대한으로 돌려").
--
-- 예전(0032·0036)에는 그림 하나(figure)·문제 통째로(problem)·국어 지문(passage)이 **한 상한을 나눠 썼다**(무제한
-- 사람당 10, 전체 12). 문제를 열 개 넣어 두면 지문 인식이 그 뒤에 줄을 섰다 — 지문은 sol 이 글자를 읽는 일이라 그림
-- 상한과 상관이 없는데도.
--
-- 이제 **범주마다 따로** 센다:
--   무제한 계정: 범주마다 사람당 p_unlimited_cap(10), 짧은 작업(task) 사람당 30.
--   그 밖의 계정: 예전 그대로(task 를 뺀 것 통틀어 1, task 12).
--   전체 상한도 범주마다 p_global_cap(12) — 그림·문제·지문이 각자 12. task 전체는 60 → 90.
-- 같은 문제 행에 쓰는 작업은 여전히 동시에 안 돈다(그림 하나 모드가 box_range 를 통째로 다시 쓴다).
-- 서명은 그대로(`create or replace`, DROP 없음).

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
  c_task_cap constant integer := 12;
  c_task_cap_unlimited constant integer := 30;
  c_task_global constant integer := 90;
begin
  perform pg_advisory_xact_lock(hashtext('claim_figure_job'));
  perform public.recover_figure_jobs();

  select j.id into v_id
    from public.figure_jobs j
    cross join lateral (
      select exists (
        select 1 from public.entitlements e
         where e.user_id = j.user_id and e.unlimited is true
      ) as unl
    ) u
   where j.status = 'pending'
     and (j.mode in ('figure', 'task')
          or j.problem_id is not null
          or j.created_at < now() - interval '3 minutes')
     and case
       when j.mode = 'task' then
         (select count(*) from public.figure_jobs r
           where r.status = 'running' and r.mode = 'task') < c_task_global
         and (
           select count(*) from public.figure_jobs r
            where r.user_id = j.user_id and r.status = 'running' and r.mode = 'task'
         ) < case when u.unl then c_task_cap_unlimited else c_task_cap end
       else
         (select count(*) from public.figure_jobs r
           where r.status = 'running' and r.mode = j.mode) < greatest(p_global_cap, 1)
         and case
           when u.unl then
             (select count(*) from public.figure_jobs r
               where r.user_id = j.user_id and r.status = 'running' and r.mode = j.mode)
               < greatest(p_unlimited_cap, 1)
           else
             (select count(*) from public.figure_jobs r
               where r.user_id = j.user_id and r.status = 'running' and r.mode <> 'task') < 1
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
   for update of j skip locked;

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
  v_kicks integer := 0;
  v_running_tasks integer;
  v_ready_tasks integer;
  r record;
  i integer;
begin
  perform public.recover_figure_jobs();

  -- 범주마다: 집을 수 있는 것 수와 전체 상한(12)에서 남은 자리 중 작은 것.
  for r in
    select m.mode,
           (select count(*) from public.figure_jobs x where x.status = 'running' and x.mode = m.mode) as running,
           (select count(*)
              from public.figure_jobs j
             where j.status = 'pending'
               and j.mode = m.mode
               and (j.mode = 'figure'
                    or j.problem_id is not null
                    or j.created_at < now() - interval '3 minutes')
               and (
                 select count(*) from public.figure_jobs q
                  where q.user_id = j.user_id and q.status = 'running'
                    and case when exists (
                          select 1 from public.entitlements e
                           where e.user_id = j.user_id and e.unlimited is true
                        ) then q.mode = j.mode else q.mode <> 'task' end
               ) < case when exists (
                     select 1 from public.entitlements e
                      where e.user_id = j.user_id and e.unlimited is true
                   ) then 10 else 1 end
           ) as ready
      from (values ('figure'), ('problem'), ('passage')) as m(mode)
  loop
    v_kicks := v_kicks + least(coalesce(r.ready, 0), greatest(12 - r.running, 0), 10);
  end loop;

  select count(*) into v_running_tasks
    from public.figure_jobs where status = 'running' and mode = 'task';
  select count(*) into v_ready_tasks
    from public.figure_jobs where status = 'pending' and mode = 'task';
  v_kicks := v_kicks + least(coalesce(v_ready_tasks, 0), greatest(90 - v_running_tasks, 0), 30);

  if v_kicks <= 0 then
    return;
  end if;

  select public.figure_worker_token() into v_token;
  if v_token is null then
    return;
  end if;

  for i in 1 .. least(v_kicks, 60) loop
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
