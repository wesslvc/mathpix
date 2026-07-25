-- 카테고리에 "실모 여부"와 "점수"를 추가한다.
-- Supabase 대시보드 > SQL Editor 에서 이 파일 내용을 그대로 실행하세요.
--
-- is_exam  : 이 카테고리가 실전모의고사(실모)인지 여부. true면 점수를 함께 표기한다.
-- score    : 실모 점수(0~100 등). is_exam이 false면 보통 비워둔다.

alter table public.categories
  add column if not exists is_exam boolean not null default false;

alter table public.categories
  add column if not exists score integer;
