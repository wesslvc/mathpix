-- 변형 수정 전에 sol 이 먼저 그림·정답을 맞춰 보고 선지 재배치 지시를 만드는 단계(align)를 더한다. overlay 는 폐지.
alter table public.variant_ops drop constraint if exists variant_ops_step_check;
alter table public.variant_ops add constraint variant_ops_step_check check (step in ('check', 'draw', 'align', 'done', 'error'));
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
     where step in ('check', 'draw', 'align') and batch_id is null and updated_at < now() - interval '30 seconds'
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
