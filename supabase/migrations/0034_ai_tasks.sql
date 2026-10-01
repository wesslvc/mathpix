-- 모든 AI 작업을 서버 대기열에서 (2026-10-01).
--
-- 사용자 — "모든 ai작업은 서버에서 돌리고 사용자한테 대기열에 들어가서 진행중인걸 볼수있게할것".
-- 그림 다시 그리기·지문 인식만 이 표(figure_jobs)를 탔고, 나머지(글자 인식·번호 읽기·영역 찾기·제목 짓기·
-- 채점·답지 읽기·sol 조판·sol 대화·지문 다시 인식)는 화면이 라우트를 직접 부르고 기다렸다. 이제 그것들도
-- `mode = 'task'` 작업으로 이 표에 들어가고 일꾼이 처리한다. 결과는 `state.result` 에 둔다(화면이 받아 간다).
--
-- 바뀌는 것:
--   ① mode 에 'task' 를 더한다.
--   ② **task 는 제 줄(lane)이 따로다.** 대개 몇 초~1분짜리라 그림(분 단위) 뒤에 줄을 세우면 채점·영역 찾기 같은
--      "화면이 기다리는" 일이 한참 막힌다. 그림 작업의 동시 처리 상한(사람당·전체)에 세지 않고, task 끼리
--      사람당 4개·전체 30개까지 돈다. 집을 때도 task 를 먼저 집는다.
--   ③ 일꾼이 쓴 만큼 정산할 때 모자라는 몫을 더 받을 수 있게 서비스용 차감 함수를 둔다
--      (기존 consume_recognition_credit 은 auth.uid() 라 세션 없는 일꾼은 못 부른다).
-- 하위 호환이다 — `claim_figure_job` 은 **서명(인자 셋)을 그대로 두고 몸통만 갈아 끼운다**(task 상한은 함수 안
-- 상수). 서명을 바꾸려면 옛 것을 DROP 해야 하는데, Supabase MCP 가 DROP 을 확인 대기로 붙잡아 적용이 시간 초과로
-- 되돌려졌다 — 그래서 실제 운영에 적용한 모양 그대로 적어 둔다.

alter table public.figure_jobs drop constraint if exists figure_jobs_mode_check;
alter table public.figure_jobs
  add constraint figure_jobs_mode_check check (mode in ('figure', 'problem', 'passage', 'task'));

-- ─────────────────────────────────────────────────────────────────────
create or replace function public.consume_recognition_credit_for(
  p_user_id uuid,
  p_amount integer
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  remaining integer;
  v_unlimited boolean;
begin
  if p_amount is null or p_amount <= 0 then
    return null;
  end if;
  select unlimited into v_unlimited from public.entitlements where user_id = p_user_id;
  if v_unlimited is true then return 999999; end if;
  update public.entitlements
     set credits = credits - p_amount, updated_at = now()
   where user_id = p_user_id and credits >= p_amount
  returning credits into remaining;
  return remaining; -- null 이면 잔액 부족
end;
$$;

revoke all on function public.consume_recognition_credit_for(uuid, integer) from public, anon, authenticated;
grant execute on function public.consume_recognition_credit_for(uuid, integer) to service_role;

-- ─────────────────────────────────────────────────────────────────────
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
  c_task_cap constant integer := 4;
  c_task_global constant integer := 30;
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

-- (권한은 0032 에서 준 그대로 남는다 — create or replace 는 grant 를 안 건드린다.)

-- pg_cron 이 1분마다 부르는 깨우기. task 도 센다(따로 상한).
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
           + least(coalesce(v_ready_tasks, 0), greatest(30 - v_running_tasks, 0), 10);
  if v_kicks <= 0 then
    return;
  end if;

  select public.figure_worker_token() into v_token;
  if v_token is null then
    return;
  end if;

  for i in 1 .. least(v_kicks, 20) loop
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
