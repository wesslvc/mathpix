-- 채점 기록에 시험 이름·등급·문항별 상세를 더한다.
-- items: 세부오답 보기와(그 문제를 나중에 오답으로 올릴 때) 정답 자동
-- 채우기에 쓴다. 학생답이 없는(주관식 무마킹) 문항도 있을 수 있어 nullable.
alter table public.exam_scores
  add column exam_name text,
  add column grade_level smallint check (grade_level between 1 and 9),
  add column items jsonb;

-- 실모(카테고리)를 담아 정리하는 폴더. 단순 1단계 구조 — 폴더 안에 폴더는
-- 없다(파일 탐색기가 아니라 정리용 묶음이면 충분하다).
create table public.folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

alter table public.folders enable row level security;

create policy folders_select_own on public.folders
  for select using (auth.uid() = user_id);
create policy folders_insert_own on public.folders
  for insert with check (auth.uid() = user_id);
create policy folders_update_own on public.folders
  for update using (auth.uid() = user_id);
create policy folders_delete_own on public.folders
  for delete using (auth.uid() = user_id);

-- 폴더가 지워져도 그 안에 있던 실모는 지워지지 않는다 — "폴더 없음"으로
-- 돌아갈 뿐이다.
alter table public.categories
  add column folder_id uuid references public.folders(id) on delete set null;

create index folders_user_idx on public.folders (user_id);
create index categories_folder_idx on public.categories (folder_id);
