-- 채점 화면에서 매번 과목·선택과목을 새로 고르지 않도록, 프로필에서 미리
-- 정해 두면 자동채점 시작 화면이 그 값으로 미리 채워진다. 사용자 하나당
-- 한 행뿐이라("이 사람이 보통 무슨 과목을 보는가") categories/problems와
-- 달리 새 테이블 하나로 충분하다.
create table if not exists public.grading_prefs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  subject text,
  math_elective text,
  korean_elective text,
  tamgu_single boolean not null default false,
  elective1_label text,
  elective2_label text,
  updated_at timestamptz not null default now()
);

alter table public.grading_prefs enable row level security;

create policy "grading_prefs_select_own" on public.grading_prefs
  for select using (auth.uid() = user_id);

create policy "grading_prefs_insert_own" on public.grading_prefs
  for insert with check (auth.uid() = user_id);

create policy "grading_prefs_update_own" on public.grading_prefs
  for update using (auth.uid() = user_id);
