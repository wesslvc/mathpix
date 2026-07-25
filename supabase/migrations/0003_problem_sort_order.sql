-- 오답(문제)에 정렬 순서를 추가한다.
-- Supabase 대시보드 > SQL Editor 에서 이 파일 내용을 그대로 실행하세요.
--
-- sort_order : 카테고리 안에서의 표시 순서(작을수록 앞). 순서 옮기기에 사용한다.

alter table public.problems
  add column if not exists sort_order integer;

-- 기존 행은 저장된 순서(created_at)대로 sort_order를 채운다.
update public.problems p
set sort_order = sub.rn
from (
  select id,
         row_number() over (partition by category_id order by created_at) as rn
  from public.problems
) sub
where p.id = sub.id and p.sort_order is null;
