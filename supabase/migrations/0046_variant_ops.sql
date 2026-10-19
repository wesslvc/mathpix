-- 변형문제의 후속 단계(재검수 · 1차 수정 그림 편집 · 2차부터 sol 이 SVG 로 덮어 그리기)도 OpenAI Batch 로 돌린다(2026-10-19).
-- 문제 하나에 대한 작업 하나 = variant_ops 한 줄. step 은 "지금 batch 로 걸려야 할 단계"다:
--   check   sol 이 원본·변형·정답·해설을 견준다   draw  sunburst 가 지적 사항만 부분 편집(1차 수정)   overlay  sol 이 SVG 덮개를 설계(2차 이후)
-- 단계가 끝나면 같은 줄이 다음 step(대개 check)으로 넘어가고, 재검수가 통과하거나 오류가 남아 승인 대기로 돌아가면 done 이 된다.

create table if not exists public.variant_ops (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  problem_id uuid not null,
  step text not null default 'check' check (step in ('check', 'draw', 'overlay', 'done', 'error')),
  batch_id text,
  state jsonb not null default '{}'::jsonb,
  error text,
  cost_krw numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists variant_ops_pending_idx on public.variant_ops (step, created_at) where step in ('check', 'draw', 'overlay');
create index if not exists variant_ops_batch_idx on public.variant_ops (batch_id);
create index if not exists variant_ops_problem_idx on public.variant_ops (problem_id);
alter table public.variant_ops enable row level security;
create policy "own select" on public.variant_ops for select using (auth.uid() = user_id);

-- 걸 것이 있거나(batch_id 가 빈 줄) 확인할 때가 된 batch 가 있을 때만 poll 을 깨운다.
create or replace function public.kick_variant_batches()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_token text;
begin
  if not exists (
    select 1 from public.openai_batches
     where done_at is null
       and polled_at < now() - interval '45 seconds'
       and (created_at > now() - interval '15 minutes' or polled_at < now() - interval '4 minutes')
    union all
    select 1 from public.variant_batch_items
     where stage in ('plan', 'image', 'review') and batch_id is null and updated_at < now() - interval '1 minute'
    union all
    select 1 from public.variant_ops
     where step in ('check', 'draw', 'overlay') and batch_id is null and updated_at < now() - interval '30 seconds'
  ) then
    return;
  end if;
  select public.figure_worker_token() into v_token;
  if v_token is null then
    return;
  end if;
  perform net.http_post(
    url := 'https://reprintocr.vercel.app/api/variant-batch/poll',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-worker-token', v_token),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
end;
$$;
revoke all on function public.kick_variant_batches() from public, anon, authenticated;
