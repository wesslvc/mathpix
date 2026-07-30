-- 결제 없이 쓸 수 있는 무료 사진인식권을 5개 -> 50개로 올린다.
-- Supabase 대시보드 > SQL Editor 에서 이 파일 내용을 그대로 실행하세요.

-- 1) 앞으로 처음 인식을 시도하는 사용자는 50개로 시작한다.
create or replace function public.consume_recognition_credit()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  remaining integer;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  insert into public.entitlements (user_id, credits)
  values (uid, 50)
  on conflict (user_id) do nothing;

  update public.entitlements
    set credits = credits - 1, updated_at = now()
    where user_id = uid and credits > 0
    returning credits into remaining;

  return remaining; -- null이면 크레딧 부족
end;
$$;

-- 2) 아직 한 번도 결제하지 않은(active=false) 기존 사용자는 남은 크레딧을
--    50개로 맞춰준다. 이미 더 많이 남아있으면 건드리지 않고, 결제한 적
--    있는(active=true) 사용자의 잔액도 건드리지 않는다.
update public.entitlements
set credits = 50, updated_at = now()
where active = false and credits < 50;
