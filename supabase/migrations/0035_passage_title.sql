-- 저장된 지문의 제목을 바꾼다(제목 짓기가 실패해 비어 있던 지문을 목록에서 다시 지을 때 쓴다).
--
-- **왜 함수인가**: 제목은 `box_range.korean.title` 에 있는데 box_range 에는 그림이 들어 있어
-- 화면에서 통째로 내려받아 다시 쓰면 무겁고, 그사이 일꾼이 쓴 blocks 를 덮을 수도 있다
-- (`set_problem_numbers`·`apply_answer_key` 와 같은 이유). 지문 행(role = passage)만 고친다.
create or replace function public.set_passage_title(p_id uuid, p_title text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  uid uuid := auth.uid();
  t text := nullif(btrim(left(coalesce(p_title, ''), 120)), '');
begin
  if uid is null then raise exception 'not authenticated'; end if;
  update public.problems
     set box_range = jsonb_set(
           box_range,
           '{korean}',
           case when t is null then (box_range->'korean') - 'title'
                else (box_range->'korean') || jsonb_build_object('title', t) end
         )
   where id = p_id
     and user_id = uid
     and box_range->'korean'->>'role' = 'passage';
  return found;
end;
$$;

grant execute on function public.set_passage_title(uuid, text) to authenticated;
