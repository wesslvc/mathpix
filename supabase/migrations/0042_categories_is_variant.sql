-- 변형문제 창(/variants)의 폴더 = is_variant 인 categories 행. 실모 목록·정답표 고르기에는 안 나온다.
alter table public.categories add column if not exists is_variant boolean not null default false;
update public.categories set is_variant = true, folder_id = null where source like '변형문제 · %';
