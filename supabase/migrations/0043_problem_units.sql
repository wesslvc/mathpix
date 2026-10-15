-- 문제별 단원 표지(luna 가 문제 그림을 보고 적는다). 변형문제의 "유형별 원본 가져오기"가 이걸로 검색한다.
-- 한 번 적어 두면 다시 검색할 때 모델을 안 부른다. 문제를 지우면 같이 지워진다.
create table if not exists public.problem_units (
  problem_id uuid primary key references public.problems(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  unit text not null,
  model text,
  created_at timestamptz not null default now()
);
create index if not exists problem_units_user_idx on public.problem_units (user_id);
alter table public.problem_units enable row level security;
drop policy if exists "problem_units_owner" on public.problem_units;
create policy "problem_units_owner" on public.problem_units for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
