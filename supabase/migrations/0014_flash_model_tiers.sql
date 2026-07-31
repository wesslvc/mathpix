-- flash를 "한 모델 + 예산 20건"이 아니라 "세대별 티어 목록"으로 바꾼다.
-- Supabase 대시보드 > SQL Editor 에서 이 파일 내용을 그대로 실행하세요.
-- (0010 ~ 0013을 먼저 실행한 뒤 이 파일을 실행하세요.)
--
-- 왜:
--   Gemini 무료 등급의 RPD(하루 요청 수)는 "모델별"로 따로 걸린다. 그래서 위
--   세대가 하루 20건을 다 쓰면 flash를 포기할 게 아니라, 그 아래 세대로 내려가면
--   또 20건을 쓸 수 있다. 티어를 4개 두면 하루 flash 용량이 20건에서 80건이 된다.
--
-- 티어 목록을 코드가 아니라 이 테이블에 두는 이유:
--   이 프로젝트에서 모델 이름을 추측했다가 404를 여러 번 맞았다(phi-3.5,
--   kimi-k2.6, gemini-2.5-flash-lite). 이름이 틀렸을 때 재배포 없이 고칠 수
--   있어야 하고, 실제로 404가 나면 서버가 그 티어를 그날 소진 처리하고 다음
--   티어로 자동으로 내려간다(아래 exhaust_diagram_model_tier).

-- ---------------------------------------------------------------------------
-- 1) 티어 목록
-- ---------------------------------------------------------------------------
create table if not exists public.diagram_model_tiers (
  tier integer primary key,          -- 1이 가장 좋은 화질. 작은 숫자부터 쓴다.
  model_id text not null unique,     -- 실제 Gemini 모델 이름
  daily_limit integer not null default 20,  -- 이 모델의 하루 전체 사용 한도(RPD)
  enabled boolean not null default true
);

alter table public.diagram_model_tiers enable row level security;
-- 사용자 정책 없음: security definer 함수를 통해서만 읽는다.

-- 시드. 이름이 틀렸거나 더 좋은 세대가 나오면 이 표만 고치면 된다.
--   확인 방법: 무제한 계정으로 로그인해 /api/diagram/models 를 열면
--   이 API 키로 실제 부를 수 있는 모델 목록이 나온다.
insert into public.diagram_model_tiers (tier, model_id, daily_limit) values
  (1, 'gemini-flash-latest',      20),
  (2, 'gemini-3.6-flash',         20),
  (3, 'gemini-3.5-flash',         20),
  (4, 'gemini-2.5-flash',         20),
  (5, 'gemini-flash-lite-latest', 20)
on conflict (tier) do nothing;

-- ---------------------------------------------------------------------------
-- 2) 오늘 아직 예산이 남은 가장 좋은 티어를 고른다(조회 전용).
-- ---------------------------------------------------------------------------
create or replace function public.best_flash_model()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select t.model_id
    from public.diagram_model_tiers t
    left join public.diagram_daily_usage u
      on u.day = public.kst_today() and u.model = t.model_id
   where t.enabled
     and coalesce(u.used, 0) < t.daily_limit
   order by t.tier
   limit 1
$$;

-- ---------------------------------------------------------------------------
-- 3) 차감. flash면 티어를 훑어 예산이 남은 첫 모델을 잡고 그 이름을 돌려준다.
--
--   성공: {"ok": true, "model_id": "...", "credits": n, "flash_remaining": n}
--   실패: {"ok": false, "reason": "..."}
--
--   model_id는 서버가 실제로 호출할 모델이다. 사용량은 이 model_id 기준으로
--   diagram_daily_usage에 쌓이므로, 모델마다 RPD가 따로 걸리는 실제 구조와
--   집계 방식이 일치한다.
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
  v_model_id text;
  v_tier record;
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

    v_model_id := 'gemini-flash-lite-latest';

    insert into public.diagram_usage_log (user_id, model) values (uid, v_model_id);
    insert into public.diagram_daily_usage (day, model, used)
    values (v_today, v_model_id, 1)
    on conflict (day, model) do update set used = public.diagram_daily_usage.used + 1;

    return jsonb_build_object(
      'ok', true, 'model_id', v_model_id, 'credits', v_credits,
      'charged', case when v_unlimited is true or v_active is true then 0 else v_cost end
    );
  end if;

  -- ---- flash ----
  -- 예산이 남은 티어를 위에서부터 훑으며 하나를 실제로 잡는다. 잡는 것과
  -- 확인하는 것을 한 문장(UPSERT ... WHERE)으로 처리해야 동시 요청에서
  -- 같은 마지막 한 장을 둘이 나눠 갖는 일이 없다.
  for v_tier in
    select t.tier, t.model_id, t.daily_limit
      from public.diagram_model_tiers t
     where t.enabled
     order by t.tier
  loop
    insert into public.diagram_daily_usage (day, model, used)
    values (v_today, v_tier.model_id, 1)
    on conflict (day, model) do update
      set used = public.diagram_daily_usage.used + 1
      where public.diagram_daily_usage.used < v_tier.daily_limit
    returning used into v_used;

    if found then
      v_model_id := v_tier.model_id;
      exit;
    end if;
  end loop;

  if v_model_id is null then
    -- 모든 세대의 하루 예산을 다 썼다. 서버가 lite로 갈아탄다.
    return jsonb_build_object('ok', false, 'reason', 'flash_global_exhausted');
  end if;

  -- 전역 예산은 확보했다. 이제 개인 자격을 본다 — 여기서 막히면 방금 잡아둔
  -- 전역 카운트를 반드시 되돌려야 한다(아무도 안 쓴 몫이 증발하지 않도록).
  if v_unlimited is not true then
    if v_active is distinct from true then
      update public.diagram_daily_usage set used = used - 1
        where day = v_today and model = v_model_id;
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
        where day = v_today and model = v_model_id;
      return jsonb_build_object('ok', false, 'reason', 'flash_daily_exhausted');
    end if;
  end if;

  insert into public.diagram_usage_log (user_id, model) values (uid, v_model_id);

  return jsonb_build_object(
    'ok', true,
    'model_id', v_model_id,
    'credits', v_credits,
    'flash_remaining',
      case when v_unlimited is true then v_limit else v_limit - v_used end,
    'charged', 0
  );
end;
$$;

revoke all on function public.consume_diagram_credit(text) from public;
grant execute on function public.consume_diagram_credit(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) 이 모델을 오늘은 그만 쓴다고 표시한다.
--
--    서버가 404(없는 이름)나 429(RPD 소진)를 받으면 부른다. 같은 요청을 이
--    모델로 다시 보내봐야 소용없으므로 오늘 몫을 다 쓴 것으로 처리해서 다음
--    티어로 내려가게 한다. 이름이 아예 틀린 티어도 이렇게 하루 한 번만
--    헛수고하고 자동으로 건너뛰게 된다.
-- ---------------------------------------------------------------------------
create or replace function public.exhaust_diagram_model_tier(p_model_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := public.kst_today();
  v_limit integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select daily_limit into v_limit
    from public.diagram_model_tiers where model_id = p_model_id;
  if v_limit is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_model');
  end if;

  insert into public.diagram_daily_usage (day, model, used)
  values (v_today, p_model_id, v_limit)
  on conflict (day, model) do update set used = greatest(
    public.diagram_daily_usage.used, v_limit
  );

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.exhaust_diagram_model_tier(text) from public;
grant execute on function public.exhaust_diagram_model_tier(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) 환불 — 어느 모델로 나갔는지 알아야 그 모델의 카운트를 되돌릴 수 있다.
-- ---------------------------------------------------------------------------
create or replace function public.refund_diagram_credit(
  p_model text,
  p_model_id text default null
)
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
  if p_model = 'lite' and v_unlimited is not true and v_active is not true then
    update public.entitlements
      set credits = credits + public.lite_diagram_cost(), updated_at = now()
      where user_id = uid;
  end if;

  if p_model = 'flash' and v_unlimited is not true then
    update public.entitlements
      set flash_diagram_used = flash_diagram_used - 1, updated_at = now()
      where user_id = uid and flash_diagram_date = v_today and flash_diagram_used > 0;
  end if;

  -- 모델별 카운트를 되돌린다. 단 429/404로 그 모델을 소진 처리한 경우에는
  -- 서버가 p_model_id를 넘기지 않으므로(소진 표시를 유지해야 하므로) 건드리지 않는다.
  if p_model_id is not null then
    update public.diagram_daily_usage set used = used - 1
      where day = v_today and model = p_model_id and used > 0;

    delete from public.diagram_usage_log
     where id = (
       select id from public.diagram_usage_log
        where user_id = uid and model = p_model_id
        order by used_at desc limit 1
     );
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.refund_diagram_credit(text, text) from public;
grant execute on function public.refund_diagram_credit(text, text) to authenticated;
-- 인자 1개짜리 옛 버전은 오버로드로 남으면 "함수가 모호함" 오류가 나므로 지운다.
drop function if exists public.refund_diagram_credit(text);

-- ---------------------------------------------------------------------------
-- 6) 화면 표시용 조회 — 남은 flash 총량은 모든 티어의 잔량 합이다.
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
  v_global_remaining integer;
  v_global_limit integer;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select active, unlimited, credits, flash_diagram_date, flash_diagram_used
    into v_active, v_unlimited, v_credits, v_date, v_used
    from public.entitlements where user_id = uid;

  select coalesce(sum(greatest(t.daily_limit - coalesce(u.used, 0), 0)), 0),
         coalesce(sum(t.daily_limit), 0)
    into v_global_remaining, v_global_limit
    from public.diagram_model_tiers t
    left join public.diagram_daily_usage u
      on u.day = v_today and u.model = t.model_id
   where t.enabled;

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
    'flash_global_remaining', v_global_remaining,
    'flash_global_limit', v_global_limit,
    'current_flash_model', public.best_flash_model(),
    'lite_cost', public.lite_diagram_cost()
  );
end;
$$;

revoke all on function public.diagram_quota() from public;
grant execute on function public.diagram_quota() to authenticated;
