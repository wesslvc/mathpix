-- 오답(problems)에 정답을 저장한다.
-- Supabase 대시보드 > SQL Editor 에서 이 파일 내용을 그대로 실행하세요.
--
-- answer : 이 문제의 정답(예: "③", "5", "12"). PDF 맨 마지막 정답표에 표기한다.
--          비어 있으면 정답표에서 제외한다.

alter table public.problems
  add column if not exists answer text;
