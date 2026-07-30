-- 특정 계정(운영자 본인 등)을 한도 없이 쓰게 만든다.
-- Supabase 대시보드 > SQL Editor 에서 이 파일 내용을 그대로 실행하세요.
-- (0010, 0011을 먼저 실행한 뒤 이 파일을 실행하세요.)
--
-- 크레딧을 왕창 넣어주는 방법도 있지만, 그러면 언젠가 다시 바닥나고 플래시쿠폰
-- 일일 한도는 애초에 크레딧으로 못 푼다. 그래서 "차감 자체를 건너뛰는" 플래그를
-- 둔다. 이 플래그가 켜진 계정은 OCR·lite·flash 모두 무제한이다.

alter table public.entitlements
  add column if not exists unlimited boolean not null default false;

-- ---------------------------------------------------------------------------
-- 1) OCR 차감 — unlimited면 깎지 않고 큰 수를 돌려준다(화면은 이 값을 잔량으로
--    쓰는데, unlimited일 때는 어차피 "무제한"이라고 따로 표시한다).
-- ---------------------------------------------------------------------------
create or replace function public.consume_recognition_credit(p_amount integer default 1)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  remaining integer;
  v_unlimited boolean;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  insert into public.entitlements (user_id, credits)
  values (uid, 50)
  on conflict (user_id) do nothing;

  select unlimited into v_unlimited from public.entitlements where user_id = uid;
  if v_unlimited is true then
    return 999999;
  end if;

  update public.entitlements
    set credits = credits - p_amount, updated_at = now()
    where user_id = uid and credits >= p_amount
    returning credits into remaining;

  return remaining; -- null이면 크레딧 부족
end;
$$;

revoke all on function public.consume_recognition_credit(integer) from public;
grant execute on function public.consume_recognition_credit(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) 도형 차감 — unlimited면 결제 여부·쿠폰 잔량을 따지지 않는다.
-- ---------------------------------------------------------------------------
create or replace function public.consume_diagram_credit(p_model text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  v_active boolean;
  v_unlimited boolean;
  v_credits integer;
  v_used integer;
  v_today date := public.kst_today();
  v_limit integer := public.flash_diagram_daily_limit();
  v_cost integer := public.lite_diagram_cost();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if p_model not in ('flash', 'lite') then
    raise exception 'invalid model: %', p_model;
  end if;

  insert into public.entitlements (user_id, credits)
  values (uid, 50)
  on conflict (user_id) do nothing;

  select active, unlimited, credits
    into v_active, v_unlimited, v_credits
    from public.entitlements where user_id = uid;

  if v_unlimited is true then
    return jsonb_build_object(
      'ok', true, 'credits', v_credits, 'flash_remaining', v_limit, 'charged', 0
    );
  end if;

  if p_model = 'lite' then
    if v_active is true then
      return jsonb_build_object('ok', true, 'credits', v_credits, 'charged', 0);
    end if;

    update public.entitlements
      set credits = credits - v_cost, updated_at = now()
      where user_id = uid and credits >= v_cost
      returning credits into v_credits;

    if not found then
      return jsonb_build_object('ok', false, 'reason', 'no_credits');
    end if;

    return jsonb_build_object('ok', true, 'credits', v_credits, 'charged', v_cost);
  end if;

  if v_active is distinct from true then
    return jsonb_build_object('ok', false, 'reason', 'not_paid');
  end if;

  update public.entitlements
    set flash_diagram_date = v_today,
        flash_diagram_used =
          case when flash_diagram_date = v_today then flash_diagram_used + 1 else 1 end,
        updated_at = now()
    where user_id = uid
      and (flash_diagram_date is distinct from v_today or flash_diagram_used < v_limit)
    returning credits, flash_diagram_used into v_credits, v_used;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'flash_daily_exhausted');
  end if;

  return jsonb_build_object(
    'ok', true, 'credits', v_credits, 'flash_remaining', v_limit - v_used, 'charged', 0
  );
end;
$$;

revoke all on function public.consume_diagram_credit(text) from public;
grant execute on function public.consume_diagram_credit(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) 환불 — unlimited는 깎은 게 없으니 되돌릴 것도 없다.
-- ---------------------------------------------------------------------------
create or replace function public.refund_diagram_credit(p_model text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  v_active boolean;
  v_unlimited boolean;
  v_today date := public.kst_today();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select active, unlimited into v_active, v_unlimited
    from public.entitlements where user_id = uid;

  if v_unlimited is true then
    return jsonb_build_object('ok', true);
  end if;

  if p_model = 'lite' then
    if v_active is true then
      return jsonb_build_object('ok', true);
    end if;
    update public.entitlements
      set credits = credits + public.lite_diagram_cost(), updated_at = now()
      where user_id = uid;
  elsif p_model = 'flash' then
    update public.entitlements
      set flash_diagram_used = flash_diagram_used - 1, updated_at = now()
      where user_id = uid and flash_diagram_date = v_today and flash_diagram_used > 0;
  else
    raise exception 'invalid model: %', p_model;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.refund_diagram_credit(text) from public;
grant execute on function public.refund_diagram_credit(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) 화면 표시용 조회에 unlimited를 함께 내려준다.
-- ---------------------------------------------------------------------------
create or replace function public.diagram_quota()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  v_active boolean;
  v_unlimited boolean;
  v_credits integer;
  v_date date;
  v_used integer;
  v_today date := public.kst_today();
  v_limit integer := public.flash_diagram_daily_limit();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select active, unlimited, credits, flash_diagram_date, flash_diagram_used
    into v_active, v_unlimited, v_credits, v_date, v_used
    from public.entitlements where user_id = uid;

  return jsonb_build_object(
    'paid', coalesce(v_active, false) or coalesce(v_unlimited, false),
    'unlimited', coalesce(v_unlimited, false),
    'credits', coalesce(v_credits, 50),
    'lite_free', coalesce(v_active, false) or coalesce(v_unlimited, false),
    'flash_remaining',
      case when coalesce(v_unlimited, false) then v_limit
           when not coalesce(v_active, false) then 0
           when v_date is distinct from v_today then v_limit
           else greatest(v_limit - coalesce(v_used, 0), 0) end,
    'flash_daily_limit', v_limit,
    'lite_cost', public.lite_diagram_cost()
  );
end;
$$;

revoke all on function public.diagram_quota() from public;
grant execute on function public.diagram_quota() to authenticated;

-- ---------------------------------------------------------------------------
-- 5) 내 계정을 무제한으로 만든다.
--
--    아래 이메일을 본인 계정 이메일로 바꿔서 실행하세요.
--    (auth.users는 대시보드 SQL Editor에서 조회할 수 있습니다.)
--    되돌리려면 unlimited = false 로 다시 실행하면 됩니다.
-- ---------------------------------------------------------------------------
insert into public.entitlements (user_id, credits, active, unlimited)
select id, 999999, true, true
  from auth.users
 where email = 'wes1128slvc@gmail.com'
on conflict (user_id) do update
  set unlimited = true,
      active = true,
      updated_at = now();
