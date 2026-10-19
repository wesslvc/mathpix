-- 변형문제 최초 생성을 OpenAI Batch API(반값, 최대 24시간)로 돌린다(2026-10-19).
-- 변형 하나 = variant_batch_items 한 줄. 단계(plan → image → review → done)마다 OpenAI batch 하나에 여러 줄을 모아 건다.
-- openai_batches 는 걸어 둔 batch 들이고, pg_cron 이 1분마다 /api/variant-batch/poll 을 깨워 끝난 것을 다음 단계로 넘긴다.

create table if not exists public.variant_batch_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  group_id uuid not null,
  category_id uuid not null references public.categories(id) on delete cascade,
  src_path text not null,
  params jsonb not null default '{}'::jsonb,
  stage text not null default 'plan' check (stage in ('plan', 'image', 'review', 'done', 'error')),
  batch_id text,
  plan jsonb,
  draft_path text,
  problem_id uuid,
  error text,
  cost_krw numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists variant_batch_items_user_idx on public.variant_batch_items (user_id, created_at desc);
create index if not exists variant_batch_items_batch_idx on public.variant_batch_items (batch_id);
alter table public.variant_batch_items enable row level security;
create policy "own select" on public.variant_batch_items for select using (auth.uid() = user_id);
create policy "own delete" on public.variant_batch_items for delete using (auth.uid() = user_id);

create table if not exists public.openai_batches (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  stage text not null,
  status text not null default 'submitted',
  item_count integer not null default 0,
  created_at timestamptz not null default now(),
  polled_at timestamptz not null default now(),
  done_at timestamptz
);
create index if not exists openai_batches_open_idx on public.openai_batches (status) where done_at is null;
alter table public.openai_batches enable row level security;
create policy "own select" on public.openai_batches for select using (auth.uid() = user_id);

-- 걸어 둔 batch 가 있을 때만 poll 을 깨운다(없으면 요청 자체를 안 보낸다).
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
    select 1 from public.openai_batches where done_at is null
    union all
    select 1 from public.variant_batch_items
     where stage in ('plan', 'image', 'review') and batch_id is null and updated_at < now() - interval '1 minute'
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

select cron.schedule('kick-variant-batches', '* * * * *', 'select public.kick_variant_batches()');

-- (같은 날 고침) 확인할 때가 된 batch 가 있을 때만 깨운다: 걸린 지 15분 안은 1분마다, 그 뒤는 4분마다. 운영에는 variant_batches_cadence 로 적용됨.
