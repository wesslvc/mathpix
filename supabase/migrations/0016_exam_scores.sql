-- 자동채점 결과를 담는 표. 실모(categories)와는 느슨하게 연결한다 —
-- 사용자가 원하면 실모를 고르거나 새로 만들어 연결하고, 원치 않으면
-- category_id 를 비운 채 성적만 기록한다(성적 추세는 이 표 하나로 그린다).
create table public.exam_scores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category_id uuid references public.categories(id) on delete set null,
  -- 국어/수학/탐구. 사회탐구·과학탐구를 더 나누지 않는다 — 과목명은
  -- elective_label 에 사용자가 직접 적는다(고정 목록을 두면 새 과목이 생길
  -- 때마다 코드를 고쳐야 한다).
  subject text not null check (subject in ('korean', 'math', 'elective')),
  -- 탐구일 때만 쓴다. 1선택/2선택은 서로 다른 과목이라 각각 독립된 행이다.
  elective_slot smallint check (elective_slot in (1, 2)),
  elective_label text,
  total_questions integer not null check (total_questions > 0),
  correct_count integer not null check (correct_count >= 0),
  wrong_numbers integer[] not null default '{}',
  -- 정답표에 배점이 있으면 점수, 없으면 null(그때는 정답률로만 본다).
  score integer,
  taken_at date not null default current_date,
  created_at timestamptz not null default now()
);

alter table public.exam_scores enable row level security;

create policy exam_scores_select_own on public.exam_scores
  for select using (auth.uid() = user_id);
create policy exam_scores_insert_own on public.exam_scores
  for insert with check (auth.uid() = user_id);
create policy exam_scores_update_own on public.exam_scores
  for update using (auth.uid() = user_id);
create policy exam_scores_delete_own on public.exam_scores
  for delete using (auth.uid() = user_id);

create index exam_scores_user_taken_idx on public.exam_scores (user_id, taken_at);
create index exam_scores_category_idx on public.exam_scores (category_id);
