-- flash 사용을 전역(전체 사용자 합계)으로 집계하고, 하루 예산을 넘으면 막는다.
-- Supabase 대시보드 > SQL Editor 에서 이 파일 내용을 그대로 실행하세요.
-- (0010 ~ 0012를 먼저 실행한 뒤 이 파일을 실행하세요.)
--
-- 왜 필요한가:
--   지금까지의 한도는 "사용자 1명당 하루 5장"이었다. 그런데 Gemini 무료 등급의
--   RPD(하루 요청 수)는 계정 전체에 걸린 값이라, 사용자가 4명만 돼도 각자 5장씩
--   쓰면 그대로 한도를 넘긴다. 그래서 사용자별 한도와 별개로 "전체 합계" 예산을
--   두고, 그 예산이 바닥나면 flash를 거절한다. 서버는 이때 자동으로 lite로
--   내려서 처리하므로 사용자 입장에서는 화질만 낮아지고 기능은 계속 동작한다.

-- ---------------------------------------------------------------------------
-- 1) 집계 테이블
-- ---------------------------------------------------------------------------

/** 날짜·모델별 전체 사용량(빠른 예산 확인용). */
create table if not exists public.diagram_daily_usage (
  day date not null,
  model text not null,
  used integer not null default 0,
  primary key (day, model)
);

alter table public.diagram_daily_usage enable row level security;
-- 사용자 정책 없음: 아래 security definer 함수를 통해서만 읽고 쓴다.

/** 누가 언제 무엇을 썼는지 남기는 기록(사용자별 집계·정산용). */
create table if not exists public.diagram_usage_log (
  id bigserial primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  model text not null,
  used_at timestamptz not null default now()
);

create index if not exists diagram_usage_log_used_at_idx
  on public.diagram_usage_log (used_at desc);
create index if not exists diagram_usage_log_user_idx
  on public.diagram_usage_log (user_id, used_at desc);

alter table public.diagram_usage_log enable row level security;

-- 본인 기록만 읽을 수 있다(쓰기는 함수 전용).
create policy "diagram_usage_log_select_own" on public.diagram_usage_log
  for select using (auth.uid() = user_id);

/**
 * 하루에 전체 사용자가 쓸 수 있는 flash 총량. Gemini 무료 등급 RPD에 맞춘 값이라
 * 요금제를 올리면 이 숫자만 바꾸면 된다.
 * 실제 RPD보다 약간 낮게 잡아 여유를 두는 편이 안전하다(진단 호출 등도 RPD를 쓴다).
 */
create or replace function public.flash_global_daily_limit()
returns integer language sql immutable as $$ select 20 $$;

-- ---------------------------------------------------------------------------
-- 2) 차감 — flash는 전역 예산까지 확인한다.
--
--   실패 사유에 flash_global_exhausted가 추가된다. 서버는 이 사유를 받으면
--   사용자에게 오류를 보이지 않고 lite로 갈아타 다시 시도한다.
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
  v_global integer := public.flash_global_daily_limit();
  v_global_used integer;
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

  -- ---- lite ----
  if p_model = 'lite' then
    if v_unlimited is not true and v_active is not true then
      update public.entitlements
        set credits = credits - v_cost, updated_at = now()
        where user_id = uid and credits >= v_cost
        returning credits into v_credits;
      if not found then
        return jsonb_build_object('ok', false, 'reason', 'no_credits');
      end if;
    end if;

    insert into public.diagram_usage_log (user_id, model) values (uid, 'lite');
    insert into public.diagram_daily_usage (day, model, used)
    values (v_today, 'lite', 1)
    on conflict (day, model) do update set used = public.diagram_daily_usage.used + 1;

    return jsonb_build_object('ok', true, 'credits', v_credits, 'charged',
      case when v_unlimited is true or v_active is true then 0 else v_cost end);
  end if;

  -- ---- flash ----
  -- 무제한 계정도 전역 예산은 지켜야 한다. 예산은 우리 지갑이 아니라 Gemini의
  -- 하루 요청 수 제한이라, 운영자라고 넘길 수 있는 게 아니다.
  insert into public.diagram_daily_usage (day, model, used)
  values (v_today, 'flash', 1)
  on conflict (day, model) do update
    set used = public.diagram_daily_usage.used + 1
    where public.diagram_daily_usage.used < v_global
  returning used into v_global_used;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'flash_global_exhausted');
  end if;

  -- 전역 예산은 확보했다. 이제 개인 자격을 본다 — 여기서 실패하면 방금 잡아둔
  -- 전역 카운트를 반드시 되돌려야 한다(안 그러면 아무도 안 쓴 몫이 날아간다).
  if v_unlimited is not true then
    if v_active is distinct from true then
      update public.diagram_daily_usage set used = used - 1
        where day = v_today and model = 'flash';
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
      update public.diagram_daily_usage set used = used - 1
        where day = v_today and model = 'flash';
      return jsonb_build_object('ok', false, 'reason', 'flash_daily_exhausted');
    end if;
  end if;

  insert into public.diagram_usage_log (user_id, model) values (uid, 'flash');

  return jsonb_build_object(
    'ok', true,
    'credits', v_credits,
    'flash_remaining',
      case when v_unlimited is true then v_limit else v_limit - v_used end,
    'flash_global_remaining', v_global - v_global_used,
    'charged', 0
  );
end;
$$;

revoke all on function public.consume_diagram_credit(text) from public;
grant execute on function public.consume_diagram_credit(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) 환불 — 전역 카운트와 기록도 함께 되돌린다.
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
  if p_model not in ('flash', 'lite') then
    raise exception 'invalid model: %', p_model;
  end if;

  select active, unlimited into v_active, v_unlimited
    from public.entitlements where user_id = uid;

  -- 실제로 깎였던 경우에만 되돌린다(무제한 계정과 결제자의 lite는 차감이 없었다).
  if p_model = 'lite'
     and v_unlimited is not true and v_active is not true then
    update public.entitlements
      set credits = credits + public.lite_diagram_cost(), updated_at = now()
      where user_id = uid;
  end if;

  if p_model = 'flash' and v_unlimited is not true then
    -- 날짜가 넘어간 뒤의 환불은 무시한다(쿠폰이 이미 초기화됐으므로 손해가 없고,
    -- 여기서 빼주면 오늘 몫을 부당하게 늘려주게 된다).
    update public.entitlements
      set flash_diagram_used = flash_diagram_used - 1, updated_at = now()
      where user_id = uid and flash_diagram_date = v_today and flash_diagram_used > 0;
  end if;

  -- 전역 카운트는 호출이 실패했으니 되돌린다(요청이 실제로 나갔더라도, 실패한
  -- 호출까지 예산으로 세면 남은 몫을 실제보다 적게 잡게 된다).
  update public.diagram_daily_usage set used = used - 1
    where day = v_today and model = p_model and used > 0;

  -- 기록에서도 방금 남긴 한 줄을 지운다.
  delete from public.diagram_usage_log
   where id = (
     select id from public.diagram_usage_log
      where user_id = uid and model = p_model
      order by used_at desc limit 1
   );

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.refund_diagram_credit(text) from public;
grant execute on function public.refund_diagram_credit(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) 화면 표시용 조회에 전역 잔량을 추가한다.
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
  v_global integer := public.flash_global_daily_limit();
  v_global_used integer;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select active, unlimited, credits, flash_diagram_date, flash_diagram_used
    into v_active, v_unlimited, v_credits, v_date, v_used
    from public.entitlements where user_id = uid;

  select used into v_global_used
    from public.diagram_daily_usage where day = v_today and model = 'flash';

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
    'flash_global_remaining', greatest(v_global - coalesce(v_global_used, 0), 0),
    'flash_global_limit', v_global,
    'lite_cost', public.lite_diagram_cost()
  );
end;
$$;

revoke all on function public.diagram_quota() from public;
grant execute on function public.diagram_quota() to authenticated;

-- ---------------------------------------------------------------------------
-- 5) 운영자용 사용량 보고 — 무제한 계정만 볼 수 있다.
--    최근 N일간 누가 flash/lite를 몇 번 썼는지 사용자별로 집계한다.
-- ---------------------------------------------------------------------------
create or replace function public.diagram_usage_report(p_days integer default 7)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  v_unlimited boolean;
  v_since timestamptz := now() - make_interval(days => greatest(p_days, 1));
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select unlimited into v_unlimited from public.entitlements where user_id = uid;
  if v_unlimited is not true then
    raise exception 'forbidden';
  end if;

  return jsonb_build_object(
    'today', (
      select coalesce(jsonb_object_agg(model, used), '{}'::jsonb)
        from public.diagram_daily_usage where day = public.kst_today()
    ),
    'flash_global_limit', public.flash_global_daily_limit(),
    'daily', (
      select coalesce(jsonb_agg(t order by t.day desc), '[]'::jsonb)
        from (
          select day, model, used from public.diagram_daily_usage
           where day >= (public.kst_today() - greatest(p_days, 1))
        ) t
    ),
    'by_user', (
      select coalesce(jsonb_agg(t order by t.flash desc, t.lite desc), '[]'::jsonb)
        from (
          select u.email,
                 count(*) filter (where l.model = 'flash') as flash,
                 count(*) filter (where l.model = 'lite') as lite
            from public.diagram_usage_log l
            join auth.users u on u.id = l.user_id
           where l.used_at >= v_since
           group by u.email
        ) t
    )
  );
end;
$$;

revoke all on function public.diagram_usage_report(integer) from public;
grant execute on function public.diagram_usage_report(integer) to authenticated;
