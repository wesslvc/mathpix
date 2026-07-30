-- 도형 과금 정책 변경 + 문제별 정답 유형/박스 범위 저장.
-- Supabase 대시보드 > SQL Editor 에서 이 파일 내용을 그대로 실행하세요.
-- (0010을 먼저 실행한 뒤 이 파일을 실행하세요.)
--
-- 바뀌는 정책 (0010 → 0011):
--   lite  : 예전엔 결제자 전용 + 5장 차감이었다.
--           이제 무료 사용자도 쓸 수 있고(사진인식권 5장 차감),
--           결제자는 아예 무료다(차감 없음).
--   flash : 그대로 결제자 전용, 하루 5장(플래시쿠폰), KST 자정 초기화.

-- ---------------------------------------------------------------------------
-- 1) 도형 재구성 1회분 차감
--
--   성공: {"ok": true, "credits": n, "flash_remaining": n, "charged": n}
--   실패: {"ok": false, "reason": "not_paid" | "no_credits" | "flash_daily_exhausted"}
--
--   charged = 실제로 깎인 사진인식권 수(결제자의 lite는 0). 환불할 때 이 값이
--   필요하지는 않지만(환불도 같은 규칙으로 다시 판단한다), 화면에 "무료로
--   사용됨"을 보여주는 데 쓴다.
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

  -- 무료 사용자도 lite를 쓸 수 있으므로, 행이 없으면 무료 크레딧으로 만들어준다
  -- (OCR 첫 호출 때와 같은 기본값 50).
  insert into public.entitlements (user_id, credits)
  values (uid, 50)
  on conflict (user_id) do nothing;

  select active, credits into v_active, v_credits
    from public.entitlements where user_id = uid;

  if p_model = 'lite' then
    -- 결제자는 lite 무료.
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

  -- flash는 결제자 전용.
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
    'ok', true,
    'credits', v_credits,
    'flash_remaining', v_limit - v_used,
    'charged', 0
  );
end;
$$;

revoke all on function public.consume_diagram_credit(text) from public;
grant execute on function public.consume_diagram_credit(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) 환불 — 결제자의 lite는 애초에 차감이 없었으므로 되돌릴 것도 없다.
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
  v_today date := public.kst_today();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select active into v_active from public.entitlements where user_id = uid;

  if p_model = 'lite' then
    -- 결제자는 무료로 썼으니 환불 없음.
    if v_active is true then
      return jsonb_build_object('ok', true);
    end if;
    update public.entitlements
      set credits = credits + public.lite_diagram_cost(), updated_at = now()
      where user_id = uid;
  elsif p_model = 'flash' then
    -- 날짜가 넘어간 뒤의 환불은 무시한다(쿠폰이 이미 초기화됐으므로 손해가 없고,
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
-- 3) 화면 표시용 조회. lite_free = 이 사용자에게 lite가 공짜인지.
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
    'credits', coalesce(v_credits, 50),
    'lite_free', coalesce(v_active, false),
    'flash_remaining',
      case when not coalesce(v_active, false) then 0
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
-- 4) 문제별 정답 유형과 조건 박스 범위를 저장한다.
--
--   answer_type : 'choice'(객관식) | 'short'(주관식). 객관식이면 정답표에
--                 "1" -> "①"처럼 원숫자로 바꿔 표기한다. null이면 주관식 취급.
--   box_range   : {"start": n, "end": n} 형태의 조건 박스 줄 범위(사용자가
--                 자동 감지 결과를 손본 값). null이면 자동 감지에 맡긴다.
--                 {"none": true}면 "박스 없음"을 사용자가 명시한 것이다.
-- ---------------------------------------------------------------------------
alter table public.problems
  add column if not exists answer_type text,
  add column if not exists box_range jsonb;
