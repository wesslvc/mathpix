-- apply_answer_key: 1~5 한 자리만 객관식(choice), 두 자리 이상·0·6~9 는 주관식(short).
-- 예전에는 숫자면 전부 choice 라 수학 주관식 답(81·193 등)이 ①~⑤ 객관식처럼 다뤄졌다.
create or replace function public.apply_answer_key(p_updates jsonb)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
  n integer := 0;
  it jsonb;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  for it in select * from jsonb_array_elements(coalesce(p_updates, '[]'::jsonb)) loop
    update public.problems
       set answer = coalesce(nullif(it->>'answer', ''), answer),
           answer_type = case
             when (it->>'answer') ~ '^[1-5]$' then 'choice'
             when (it->>'answer') ~ '^[0-9]+$' then 'short'
             else answer_type
           end,
           box_range = case
             when it ? 'points' and (it->>'points') is not null
               then coalesce(box_range, '{}'::jsonb)
                    || jsonb_build_object('points', (it->>'points')::int)
             else box_range
           end
     where id = (it->>'id')::uuid
       and user_id = uid;

    if found then n := n + 1; end if;
  end loop;

  return n;
end;
$function$;
