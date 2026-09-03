-- 답지(정답표)를 사진에서 읽어 **데이터로 남긴다.** 지금까지 정답은 문제마다
-- 손으로 적거나 채점 기록에서 딸려 왔을 뿐, 답지 자체는 어디에도 남지 않았다.
-- 한 번 읽어 두면 문제를 나중에 더 넣어도 번호로 다시 연결할 수 있다.
create table if not exists public.answer_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- 실모가 지워져도 읽어 둔 답지는 남긴다(다시 읽으려면 또 돈이 든다).
  category_id uuid references public.categories (id) on delete set null,
  name text,
  -- [{ "no": 3, "answer": "4", "points": 3 }, ...]
  items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists answer_keys_user_idx on public.answer_keys (user_id, created_at desc);
create index if not exists answer_keys_category_idx on public.answer_keys (category_id);

alter table public.answer_keys enable row level security;

create policy "answer_keys_select_own" on public.answer_keys
  for select using (auth.uid() = user_id);
create policy "answer_keys_insert_own" on public.answer_keys
  for insert with check (auth.uid() = user_id);
create policy "answer_keys_update_own" on public.answer_keys
  for update using (auth.uid() = user_id);
create policy "answer_keys_delete_own" on public.answer_keys
  for delete using (auth.uid() = user_id);

-- 읽어 둔 답지를 문제들에 한 번에 붙인다.
--
-- **왜 함수인가**: 배점은 `box_range` jsonb 안에 있어서(새 컬럼을 만들지
-- 않는 이 저장소의 관행) 고치려면 기존 값과 합쳐야 하는데, 그걸 화면에서
-- 하려면 box_range 를 통째로 내려받아야 한다 — 거기엔 그림이 base64 로
-- 들어 있어 문제 하나가 수백 KB~4MB 다. 서버에서 합치면 그 전송이 아예
-- 없어진다.
--
-- 문제를 **번호가 아니라 id 로** 받는 이유: 번호는 box_range.number 에
-- 있을 수도(통째로 넣은 문제) 본문 맨 앞에서 뽑아야 할 수도(인식한 문제)
-- 있다. 그 판단은 이미 화면이 하고 있으므로(readProblemNumber ??
-- parseProblemNumber) 결과만 받는 편이 어긋날 일이 없다.
create or replace function public.apply_answer_key(p_updates jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  uid uuid := auth.uid();
  n integer := 0;
  it jsonb;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  for it in select * from jsonb_array_elements(coalesce(p_updates, '[]'::jsonb)) loop
    update public.problems
       set answer = coalesce(nullif(it->>'answer', ''), answer),
           -- 숫자 하나뿐이면 객관식으로 본다(AnswerInput 의 짐작과 같은 규칙).
           answer_type = case
             when (it->>'answer') ~ '^[0-9]+$' then 'choice'
             else answer_type
           end,
           box_range = case
             when it ? 'points' and (it->>'points') is not null
               then coalesce(box_range, '{}'::jsonb)
                    || jsonb_build_object('points', (it->>'points')::int)
             else box_range
           end
     where id = (it->>'id')::uuid
       and user_id = uid;

    if found then n := n + 1; end if;
  end loop;

  return n;
end;
$$;
