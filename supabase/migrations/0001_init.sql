-- 수학오답프린트 제작 : 초기 스키마
-- Supabase 대시보드 > SQL Editor 에서 이 파일 내용을 그대로 실행하세요.

-- 1) 실모(카테고리) : 출처(예: "2025학년도 6월 모의평가")별로 문제를 모으는 단위
create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source text not null,
  title text,
  created_at timestamptz not null default now()
);

create index if not exists categories_user_id_idx on public.categories (user_id);

alter table public.categories enable row level security;

create policy "categories_select_own" on public.categories
  for select using (auth.uid() = user_id);

create policy "categories_insert_own" on public.categories
  for insert with check (auth.uid() = user_id);

create policy "categories_update_own" on public.categories
  for update using (auth.uid() = user_id);

create policy "categories_delete_own" on public.categories
  for delete using (auth.uid() = user_id);

-- 2) 오답(문제) : Mathpix로 인식/재구성한 결과 이미지만 저장한다(원본 사진은 저장하지 않음).
create table if not exists public.problems (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.categories (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  image_path text not null,
  latex text,
  text_content text,
  created_at timestamptz not null default now()
);

create index if not exists problems_category_id_idx on public.problems (category_id);
create index if not exists problems_user_id_idx on public.problems (user_id);

alter table public.problems enable row level security;

create policy "problems_select_own" on public.problems
  for select using (auth.uid() = user_id);

create policy "problems_insert_own" on public.problems
  for insert with check (auth.uid() = user_id);

create policy "problems_update_own" on public.problems
  for update using (auth.uid() = user_id);

create policy "problems_delete_own" on public.problems
  for delete using (auth.uid() = user_id);

-- 3) 변환된 문제 이미지를 저장할 스토리지 버킷 (비공개, 사용자 폴더별 접근 제한)
insert into storage.buckets (id, name, public)
values ('problem-images', 'problem-images', false)
on conflict (id) do nothing;

create policy "problem_images_select_own" on storage.objects
  for select using (
    bucket_id = 'problem-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "problem_images_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'problem-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "problem_images_delete_own" on storage.objects
  for delete using (
    bucket_id = 'problem-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
