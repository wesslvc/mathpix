-- 이용권을 "사진인식권(크레딛)" 방식으로 바꿔다.
-- Supabase 대시보드 > SQL Editor 에서 이 파일 내용을 그대로 실행하세요.
--
-- 신규 사용자는 무료 5회, 이용권을 결제(그로블 웹훅 payment.completed /
-- subscription_payment.completed)하면 1000회가 추가된다. Mathpix 인식 API를
-- 1회 호출할 때마다 1개씩 차감한다(성공 여부와 무관하게 호출 시점에 차감하고,
-- Mathpix 호출 자체가 실패하면 환불한다).

alter table public.entitlements
  add column if not exists credits integer not null default 0;

-- 기존에 이미 결제(active=true)했던 사용자는 1000개로 맞춰준다.
update public.entitlements set credits = 1000 where active = true and credits = 0;

-- 사용자 본인의 크레딛을 원자적으로 1 차감한다. 잔액이 없으면 아무 것도 갱신하지
-- 않는다(호출부에서 반환값이 없으면 "크레딛 부족"으로 판단). 첫 호출이면 무료
-- 크레딛 5개로 행을 만든 뒤 차감한다. auth.uid()만 건드릴 수 있어 다른 사용자
-- 크레딛은 조작할 수 없다.
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
  values (uid, 5)
  on conflict (user_id) do nothing;

  update public.entitlements
    set credits = credits - 1, updated_at = now()
    where user_id = uid and credits > 0
    returning credits into remaining;

  return remaining; -- null이면 크레딛 부족
end;
$$;

revoke all on function public.consume_recognition_credit() from public;
grant execute on function public.consume_recognition_credit() to authenticated;

-- 본인의 크레딛을 1 되돌려준다(Mathpix 호출 자체가 실패했을 때 환불용).
create or replace function public.refund_recognition_credit()
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
    set credits = credits + 1, updated_at = now()
    where user_id = uid
    returning credits into remaining;

  return remaining;
end;
$$;

revoke all on function public.refund_recognition_credit() from public;
grant execute on function public.refund_recognition_credit() to authenticated;

-- 지정한 사용자에게 크레딛을 더한다(결제 완료 웹훅 전용). service_role만 호출
-- 가능하도록 authenticated/anon 권한은 주지 않는다.
create or replace function public.grant_recognition_credits(
  p_user_id uuid,
  p_amount integer
)
returns integer
language sql
security definer
set search_path = public
as $$
  insert into public.entitlements (user_id, credits, active, updated_at)
  values (p_user_id, greatest(p_amount, 0), true, now())
  on conflict (user_id) do update
    set credits = public.entitlements.credits + excluded.credits,
        active = true,
        updated_at = now()
  returning credits;
$$;

revoke all on function public.grant_recognition_credits(uuid, integer) from public, anon, authenticated;
