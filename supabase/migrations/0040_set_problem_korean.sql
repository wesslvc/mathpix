-- 이미 저장된 문제를 국어 지문 세트에 묶거나(p_set_id 지정) 묶음을 푼다(p_set_id null).
--
-- **왜 함수인가**: 묶는 값은 `box_range.korean` 에 있는데 box_range 에는 그림이 들어 있어 화면에서 통째로
-- 내려받아 다시 쓰면 무겁다(`set_passage_title`·`set_problem_numbers` 와 같은 이유).
-- 문제 행(role = question 이거나 국어 메타가 아직 없는 행)만 고친다 — 지문 행은 건드리지 않는다.
-- 묶을 세트는 같은 사용자의 지문 행이 실제로 갖고 있는 setId 여야 한다.
create or replace function public.set_problem_korean(p_id uuid, p_set_id text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  uid uuid := auth.uid();
  sid text := nullif(btrim(coalesce(p_set_id, '')), '');
begin
  if uid is null then raise exception 'not authenticated'; end if;

  if sid is null then
    update public.problems
       set box_range = box_range - 'korean'
     where id = p_id
       and user_id = uid
       and box_range ? 'korean'
       and coalesce(box_range->'korean'->>'role', 'question') = 'question';
    return found;
  end if;

  if not exists (
    select 1 from public.problems
     where user_id = uid
       and box_range->'korean'->>'setId' = sid
       and box_range->'korean'->>'role' = 'passage'
  ) then
    raise exception 'passage not found';
  end if;

  update public.problems
     set box_range = coalesce(case when jsonb_typeof(box_range) = 'object' then box_range end, '{}'::jsonb)
                     || jsonb_build_object('korean', jsonb_build_object('setId', sid, 'role', 'question'))
   where id = p_id
     and user_id = uid
     and coalesce(box_range->'korean'->>'role', 'question') = 'question';
  return found;
end;
$$;

grant execute on function public.set_problem_korean(uuid, text) to authenticated;
