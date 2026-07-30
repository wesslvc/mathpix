-- 도형 재구성을 "결제자 전용"으로 바꾸고, 모델(flash/lite)별로 과금을 분리한다.
-- Supabase 대시보드 > SQL Editor 에서 이 파일 내용을 그대로 실행하세요.
--
-- 바뀌는 정책:
--   - 도형 추가인식은 이용권을 결제한 사용자(entitlements.active = true)만 쓸 수 있다.
--     (무료 사용자는 OCR 1회 = 1크레딧만 계속 쓸 수 있고, 도형은 아예 막힌다.)
--   - lite  : 1회당 사진인식권 5장 차감. 잔액이 있으면 횟수 제한 없이 쓸 수 있다.
--   - flash : 사진인식권을 쓰지 않고 "플래시쿠폰"을 쓴다. 결제자에게 하루 5장이
--             주어지며 한국시각(KST) 자정에 초기화된다(누적되지 않음).
--             flash는 품질이 좋은 대신 Gemini 무료 등급 RPD를 빨리 소진하므로
--             일일 상한으로 묶는다.
--
-- 기존 0009의 consume/refund_recognition_credit(p_amount)은 OCR용으로 그대로 둔다.

alter table public.entitlements
  add column if not exists flash_diagram_date date,
  add column if not exists flash_diagram_used integer not null default 0;

-- ---------------------------------------------------------------------------
-- 정책 상수. 서버 코드가 이 값을 그대로 읽어 쓰므로 한도를 바꾸려면 여기만 고친다.
-- (클라이언트가 보낸 값을 믿으면 안 되므로 상한은 반드시 DB 쪽에 둔다.)
-- ---------------------------------------------------------------------------

/** 하루에 주어지는 플래시쿠폰 수(결제자 한정). */
create or replace function public.flash_diagram_daily_limit()
returns integer language sql immutable as $$ select 5 $$;

/** lite 모델 도형 재구성 1회당 차감되는 사진인식권 수. */
create or replace function public.lite_diagram_cost()
returns integer language sql immutable as $$ select 5 $$;

/** 쿠폰 초기화 기준 날짜. 서버가 UTC라서 그냥 current_date를 쓰면 한국 기준
    자정과 9시간 어긋난다. */
create or replace function public.kst_today()
returns date language sql stable as $$
  select (now() at time zone 'Asia/Seoul')::date
$$;

-- ---------------------------------------------------------------------------
-- 도형 재구성 1회분을 차감한다.
--
-- 반환값은 jsonb다. 실패 사유가 여러 가지(미결제 / 크레딧 부족 / 쿠폰 소진)라
-- 기존 함수들처럼 integer(=null이면 부족)로는 구분할 수 없기 때문이다.
--   성공: {"ok": true,  "credits": n, "flash_remaining": n}
--   실패: {"ok": false, "reason": "not_paid" | "no_credits" | "flash_daily_exhausted"}
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

  select active, credits into v_active, v_credits
    from public.entitlements where user_id = uid;

  -- 행이 없으면 결제한 적이 없는 사용자다(무료 크레딧 행은 OCR 첫 호출 때 생긴다).
  if v_active is distinct from true then
    return jsonb_build_object('ok', false, 'reason', 'not_paid');
  end if;

  if p_model = 'lite' then
    update public.entitlements
      set credits = credits - v_cost, updated_at = now()
      where user_id = uid and credits >= v_cost
      returning credits into v_credits;

    if not found then
      return jsonb_build_object('ok', false, 'reason', 'no_credits');
    end if;

    return jsonb_build_object('ok', true, 'credits', v_credits);
  end if;

  -- flash: 날짜가 바뀌었으면 사용량을 1로 리셋하고, 같은 날이면 한도 안에서 증가.
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
    'ok', true,
    'credits', v_credits,
    'flash_remaining', v_limit - v_used
  );
end;
$$;

revoke all on function public.consume_diagram_credit(text) from public;
grant execute on function public.consume_diagram_credit(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 차감한 1회분을 되돌린다(API 호출이 실패했을 때). 차감과 같은 모델로 불러야 한다.
-- ---------------------------------------------------------------------------
create or replace function public.refund_diagram_credit(p_model text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  v_today date := public.kst_today();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  if p_model = 'lite' then
    update public.entitlements
      set credits = credits + public.lite_diagram_cost(), updated_at = now()
      where user_id = uid;
  elsif p_model = 'flash' then
    -- 날짜가 넘어간 뒤의 환불은 무시한다(어차피 쿠폰이 초기화됐으므로 손해가 없고,
    -- 여기서 빼주면 오늘 몫을 부당하게 늘려주게 된다).
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
-- 화면에 "쓸 수 있는지 / 얼마나 남았는지"를 보여주기 위한 조회 전용 함수.
-- 차감 없이 현재 상태만 돌려준다.
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
  v_credits integer;
  v_date date;
  v_used integer;
  v_today date := public.kst_today();
  v_limit integer := public.flash_diagram_daily_limit();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select active, credits, flash_diagram_date, flash_diagram_used
    into v_active, v_credits, v_date, v_used
    from public.entitlements where user_id = uid;

  return jsonb_build_object(
    'paid', coalesce(v_active, false),
    'credits', coalesce(v_credits, 0),
    -- 날짜가 지났으면 아직 초기화 전이라도 오늘 몫은 만땅이다.
    'flash_remaining',
      case when v_date is distinct from v_today then v_limit
           else greatest(v_limit - coalesce(v_used, 0), 0) end,
    'flash_daily_limit', v_limit,
    'lite_cost', public.lite_diagram_cost()
  );
end;
$$;

revoke all on function public.diagram_quota() from public;
grant execute on function public.diagram_quota() to authenticated;
