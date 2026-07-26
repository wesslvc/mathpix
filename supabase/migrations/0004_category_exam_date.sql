-- 실모/오답 카테고리에 시행일을 추가한다.
-- Supabase 대시보드 > SQL Editor 에서 이 파일 내용을 그대로 실행하세요.
--
-- exam_date : 이 실모(카테고리)의 시행일. PDF 표지에 표기한다. 비어 있으면 앱에서
--             오늘 날짜로 간주한다.

alter table public.categories
  add column if not exists exam_date date;
