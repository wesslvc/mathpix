-- "BYOD"는 이름이 틀렸다 — "Device"가 아니라 "Key"를 가져오는 기능이라
-- 올바른 이름은 BYOK(Bring Your Own Key)다. 기능은 그대로 두고 이름만
-- 바로잡는다. Supabase 대시보드 > SQL Editor 에서 이 파일 내용을 그대로
-- 실행하세요.
--
-- 컬럼 이름은 RENAME 으로 그대로 옮기면 되지만, 함수 본문이 옛 컬럼
-- 이름을 SQL 텍스트로 그대로 담고 있어(예: `e.byod_model`) 컬럼을
-- 옮긴 뒤에는 그 함수들이 깨진다. 그래서 옛 함수를 지우고 같은 로직으로
-- 다시 만든다 — `get_byod_status()`는 반환하는 표의 컬럼 이름(`byod`)까지
-- 바뀌므로 `ALTER FUNCTION ... RENAME` 으로는 안 되고 반드시 새로 만들어야
-- 한다.

alter table public.entitlements rename column byod to byok;
alter table public.entitlements rename column byod_secret_id to byok_secret_id;
alter table public.entitlements rename column byod_model to byok_model;

comment on column public.entitlements.byok is
  'BYOK(Bring Your Own Key) 패스 구매 여부.';
comment on column public.entitlements.byok_secret_id is
  'Vault(vault.secrets)에 저장된 사용자 본인 OpenAI API 키의 secret id. BYOK 사용자가 키를 등록해야 채워진다.';
comment on column public.entitlements.byok_model is
  '사용자가 고른 이미지 생성 모델 id(그림 재구성 전용). 비어 있으면 앱 기본값을 쓴다.';

drop function if exists public.get_byod_openai_key(uuid);
drop function if exists public.get_byod_status();
drop function if exists public.clear_byod_openai_key();
drop function if exists public.set_byod_model(text);
drop function if exists public.set_byod_openai_key(text, text);
drop function if exists public.grant_byod_pass(uuid);

create function public.grant_byok_pass(p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  insert into public.entitlements (user_id, byok, active, updated_at)
    values (p_user_id, true, true, now())
    on conflict (user_id) do update
      set byok = true,
          active = true,
          updated_at = now()
    returning byok;
$$;

revoke all on function public.grant_byok_pass(uuid) from public;
grant execute on function public.grant_byok_pass(uuid) to service_role;

-- 본인 키를 등록하거나 교체한다. 이미 등록돼 있으면 vault.update_secret,
-- 처음이면 vault.create_secret으로 새로 만든다. auth.uid()만 건드릴 수
-- 있어 다른 사용자의 키를 덮어쓸 수 없다.
create function public.set_byok_openai_key(p_key text, p_model text default null)
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

  select byok_secret_id into existing from public.entitlements where user_id = uid;

  if existing is not null then
    perform vault.update_secret(existing, trim(p_key));
  else
    existing := vault.create_secret(trim(p_key), 'byok_openai_key:' || uid::text);
  end if;

  insert into public.entitlements (user_id, byok_secret_id, byok_model, updated_at)
    values (uid, existing, nullif(trim(coalesce(p_model, '')), ''), now())
    on conflict (user_id) do update
      set byok_secret_id = excluded.byok_secret_id,
          byok_model = coalesce(nullif(trim(coalesce(p_model, '')), ''), public.entitlements.byok_model),
          updated_at = now();

  return true;
end;
$$;

revoke all on function public.set_byok_openai_key(text, text) from public;
grant execute on function public.set_byok_openai_key(text, text) to authenticated;

-- 모델만 바꾼다(키는 그대로 둔다). 빈 문자열/NULL을 보내면 "앱 기본값 사용"으로
-- 되돌아간다.
create function public.set_byok_model(p_model text)
returns boolean
language sql
security definer
set search_path = public
as $$
  insert into public.entitlements (user_id, byok_model, updated_at)
    values (auth.uid(), nullif(trim(coalesce(p_model, '')), ''), now())
    on conflict (user_id) do update
      set byok_model = nullif(trim(coalesce(p_model, '')), ''),
          updated_at = now()
  returning true;
$$;

revoke all on function public.set_byok_model(text) from public;
grant execute on function public.set_byok_model(text) to authenticated;

-- 본인 키를 지운다(Vault의 비밀도 함께 지운다). 모델 선택은 남겨 둔다 —
-- 키를 다시 등록하면 그대로 이어 쓸 수 있게.
create function public.clear_byok_openai_key()
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
  select byok_secret_id into existing from public.entitlements where user_id = uid;
  if existing is not null then
    delete from vault.secrets where id = existing;
  end if;
  update public.entitlements set byok_secret_id = null, updated_at = now() where user_id = uid;
  return true;
end;
$$;

revoke all on function public.clear_byok_openai_key() from public;
grant execute on function public.clear_byok_openai_key() to authenticated;

-- 화면(설정 페이지)이 보는 자리. **키 값 자체는 절대 담지 않는다** —
-- 등록 여부(has_key)와 고른 모델만 돌려준다.
create function public.get_byok_status()
returns table(byok boolean, has_key boolean, model text)
language sql
security definer
set search_path = public
as $$
  select coalesce(e.byok, false), (e.byok_secret_id is not null), e.byok_model
  from public.entitlements e
  where e.user_id = auth.uid()
  union all
  -- entitlements 행이 아직 없는 사용자(한 번도 인식을 안 해 본 경우)도
  -- "미등록"으로 답해야 화면이 깨지지 않는다.
  select false, false, null
  where not exists (select 1 from public.entitlements where user_id = auth.uid())
  limit 1;
$$;

revoke all on function public.get_byok_status() from public;
grant execute on function public.get_byok_status() to authenticated;

-- **서버(API 라우트)가 실제 OpenAI 호출 직전에 복호화된 키를 읽는 자리.**
-- service_role로만 실행할 수 있다 — authenticated/anon에는 절대 권한을
-- 주지 않는다(줬다가는 사용자가 자기 키를 그대로 읽어 갈 뿐 아니라, 이
-- 함수가 p_user_id를 받으므로 남의 키까지 읽어 갈 수 있다).
create function public.get_byok_openai_key(p_user_id uuid)
returns table(api_key text, model text)
language sql
security definer
set search_path = public
as $$
  select ds.decrypted_secret, e.byok_model
  from public.entitlements e
  join vault.decrypted_secrets ds on ds.id = e.byok_secret_id
  where e.user_id = p_user_id and e.byok = true;
$$;

revoke all on function public.get_byok_openai_key(uuid) from public, anon, authenticated;
grant execute on function public.get_byok_openai_key(uuid) to service_role;
