-- BYOD 패스 실기능: 사용자 본인 OpenAI API 키를 Supabase Vault에 암호화해
-- 저장하고, 서버(API 라우트)가 그 키로 OpenAI를 부르게 한다.
-- Supabase 대시보드 > SQL Editor 에서 이 파일 내용을 그대로 실행하세요.
--
-- **키 자체는 이 테이블에 평문으로 두지 않는다.** `vault.secrets`에 넣고
-- 그 secret id만 entitlements에 둔다(`byod_secret_id`). 실제 값을 되읽는
-- 함수(`get_byod_openai_key`)는 service_role에게만 열어 준다 — 사용자
-- 세션(authenticated)으로는 자기 키조차 평문으로 못 읽는다. 서버 라우트가
-- (사용자 대신) OpenAI를 부를 때만 관리자 클라이언트로 이 함수를 부른다.
--
-- `byod_model`은 사용자가 고른 이미지 생성 모델 id다("같은 범주 안에서
-- 고르게 해달라"는 요청 — 있는 후보 중에서만 고른다, 자유 입력이 아니다).
-- 비어 있으면 앱 기본 모델을 그대로 쓴다.

alter table public.entitlements
  add column if not exists byod_secret_id uuid references vault.secrets(id) on delete set null,
  add column if not exists byod_model text;

comment on column public.entitlements.byod_secret_id is
  'Vault(vault.secrets)에 저장된 사용자 본인 OpenAI API 키의 secret id. BYOD 사용자가 키를 등록해야 채워진다.';
comment on column public.entitlements.byod_model is
  '사용자가 고른 이미지 생성 모델 id(그림 재구성 전용). 비어 있으면 앱 기본값을 쓴다.';

-- 본인 키를 등록하거나 교체한다. 이미 등록돼 있으면 vault.update_secret,
-- 처음이면 vault.create_secret으로 새로 만든다. auth.uid()만 건드릴 수
-- 있어 다른 사용자의 키를 덮어쓸 수 없다.
create or replace function public.set_byod_openai_key(p_key text, p_model text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  existing uuid;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if p_key is null or length(trim(p_key)) = 0 then
    raise exception 'key required';
  end if;

  select byod_secret_id into existing from public.entitlements where user_id = uid;

  if existing is not null then
    perform vault.update_secret(existing, trim(p_key));
  else
    existing := vault.create_secret(trim(p_key), 'byod_openai_key:' || uid::text);
  end if;

  insert into public.entitlements (user_id, byod_secret_id, byod_model, updated_at)
    values (uid, existing, nullif(trim(coalesce(p_model, '')), ''), now())
    on conflict (user_id) do update
      set byod_secret_id = excluded.byod_secret_id,
          byod_model = coalesce(nullif(trim(coalesce(p_model, '')), ''), public.entitlements.byod_model),
          updated_at = now();

  return true;
end;
$$;

revoke all on function public.set_byod_openai_key(text, text) from public;
grant execute on function public.set_byod_openai_key(text, text) to authenticated;

-- 모델만 바꾼다(키는 그대로 둔다). 빈 문자열/NULL을 보내면 "앱 기본값 사용"으로
-- 되돌아간다.
create or replace function public.set_byod_model(p_model text)
returns boolean
language sql
security definer
set search_path = public
as $$
  insert into public.entitlements (user_id, byod_model, updated_at)
    values (auth.uid(), nullif(trim(coalesce(p_model, '')), ''), now())
    on conflict (user_id) do update
      set byod_model = nullif(trim(coalesce(p_model, '')), ''),
          updated_at = now()
  returning true;
$$;

revoke all on function public.set_byod_model(text) from public;
grant execute on function public.set_byod_model(text) to authenticated;

-- 본인 키를 지운다(Vault의 비밀도 함께 지운다). 모델 선택은 남겨 둔다 —
-- 키를 다시 등록하면 그대로 이어 쓸 수 있게.
create or replace function public.clear_byod_openai_key()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  existing uuid;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  select byod_secret_id into existing from public.entitlements where user_id = uid;
  if existing is not null then
    delete from vault.secrets where id = existing;
  end if;
  update public.entitlements set byod_secret_id = null, updated_at = now() where user_id = uid;
  return true;
end;
$$;

revoke all on function public.clear_byod_openai_key() from public;
grant execute on function public.clear_byod_openai_key() to authenticated;

-- 화면(설정 페이지)이 보는 자리. **키 값 자체는 절대 담지 않는다** —
-- 등록 여부(has_key)와 고른 모델만 돌려준다.
create or replace function public.get_byod_status()
returns table(byod boolean, has_key boolean, model text)
language sql
security definer
set search_path = public
as $$
  select coalesce(e.byod, false), (e.byod_secret_id is not null), e.byod_model
  from public.entitlements e
  where e.user_id = auth.uid()
  union all
  -- entitlements 행이 아직 없는 사용자(한 번도 인식을 안 해 본 경우)도
  -- "미등록"으로 답해야 화면이 깨지지 않는다.
  select false, false, null
  where not exists (select 1 from public.entitlements where user_id = auth.uid())
  limit 1;
$$;

revoke all on function public.get_byod_status() from public;
grant execute on function public.get_byod_status() to authenticated;

-- **서버(API 라우트)가 실제 OpenAI 호출 직전에 복호화된 키를 읽는 자리.**
-- service_role로만 실행할 수 있다 — authenticated/anon에는 절대 권한을
-- 주지 않는다(줬다가는 사용자가 자기 키를 그대로 읽어 갈 뿐 아니라, 이
-- 함수가 p_user_id를 받으므로 **남의 키까지 읽어 갈 수 있다**).
create or replace function public.get_byod_openai_key(p_user_id uuid)
returns table(api_key text, model text)
language sql
security definer
set search_path = public
as $$
  select ds.decrypted_secret, e.byod_model
  from public.entitlements e
  join vault.decrypted_secrets ds on ds.id = e.byod_secret_id
  where e.user_id = p_user_id and e.byod = true;
$$;

revoke all on function public.get_byod_openai_key(uuid) from public, anon, authenticated;
grant execute on function public.get_byod_openai_key(uuid) to service_role;
