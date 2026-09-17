-- BYOD 패스 결제 확인 시 부를 함수. grant_recognition_credits(0007)와 같은
-- 모양이다 — entitlements 행이 아직 없는 사용자도 upsert로 안전하게 켠다.
-- Supabase 대시보드 > SQL Editor 에서 이 파일 내용을 그대로 실행하세요.
create or replace function public.grant_byod_pass(p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  insert into public.entitlements (user_id, byod, active, updated_at)
    values (p_user_id, true, true, now())
    on conflict (user_id) do update
      set byod = true,
          active = true,
          updated_at = now()
    returning byod;
$$;

revoke all on function public.grant_byod_pass(uuid) from public;
-- 웹훅은 service_role 로 호출하므로 authenticated 에 줄 필요는 없지만,
-- grant_recognition_credits 와 같은 권한 모양을 맞춰 둔다.
grant execute on function public.grant_byod_pass(uuid) to service_role;
