-- 도형(원/삼각형 등) 재구성은 OCR과 별도로 크레딧을 차감한다.
-- OCR 1회 = 1크레딧(기존과 동일), 도형 추가인식 1회 = 30크레딧(API 호출 비용이 커서 비싸게 책정).
-- 문제 하나에 OCR + 도형 재구성까지 하면 총 31크레딧이 차감된다.
-- (차감량 자체는 src/app/api/diagram/route.ts의 DIAGRAM_CREDIT_COST 상수가 정하며,
-- 이 파일의 함수는 p_amount를 받는 범용 함수라 값이 바뀌어도 재실행할 필요 없다.)
-- Supabase 대시보드 > SQL Editor 에서 이 파일 내용을 그대로 실행하세요.

-- 기존 0-인자 함수를 지우고 차감량을 받는 버전으로 교체한다(인자 개수가
-- 달라 create or replace만으로는 기존 함수를 대체하지 못하고 오버로드가
-- 생겨 "함수가 모호함" 오류가 나므로 먼저 drop한다).
drop function if exists public.consume_recognition_credit();
drop function if exists public.refund_recognition_credit();

create or replace function public.consume_recognition_credit(p_amount integer default 1)
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
    set credits = credits - p_amount, updated_at = now()
    where user_id = uid and credits >= p_amount
    returning credits into remaining;

  return remaining; -- null이면 크레딧 부족
end;
$$;

revoke all on function public.consume_recognition_credit(integer) from public;
grant execute on function public.consume_recognition_credit(integer) to authenticated;

create or replace function public.refund_recognition_credit(p_amount integer default 1)
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

  update public.entitlements
    set credits = credits + p_amount, updated_at = now()
    where user_id = uid
    returning credits into remaining;

  return remaining;
end;
$$;

revoke all on function public.refund_recognition_credit(integer) from public;
grant execute on function public.refund_recognition_credit(integer) to authenticated;
