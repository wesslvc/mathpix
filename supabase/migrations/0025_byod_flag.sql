-- BYOD(Bring Your Own [OpenAI] Key) 패스를 위한 준비 단계.
-- Supabase 대시보드 > SQL Editor 에서 이 파일 내용을 그대로 실행하세요.
--
-- **이 마이그레이션은 플래그 하나만 추가한다.** 실제로 사용자가 자기 키를
-- 등록하고, 그 키로 OpenAI 를 부르고, 토큰 차감을 건너뛰는 기능은 아직
-- 별도로 구현해야 한다(Vault 에 키를 암호화해 두는 테이블·RPC, 각 API
-- 라우트가 이 플래그를 보고 갈라지는 로직 등). 지금은 그로블 결제 웹훅이
-- "BYOD 패스를 샀다"는 사실을 기록할 자리만 만든다 — 그래야 실제 기능이
-- 완성되는 즉시 이 플래그를 보고 켤 수 있다.
--
-- **BYOD 패스는 아직 판매를 시작하지 않는다.** 이 플래그를 세워도 앱 어디서도
-- 안 읽으므로, 지금 결제해도 아무 효과가 없다 — 실제 기능이 붙기 전까지는
-- 상품을 "작성중" 상태로만 둔다.
alter table public.entitlements
  add column if not exists byod boolean not null default false;

comment on column public.entitlements.byod is
  'BYOD 패스 구매 여부. 아직 앱에서 읽는 곳이 없다 — 실제 기능(본인 OpenAI 키 등록·사용, 토큰 차감 면제)이 붙기 전까지는 켜져 있어도 아무 효과가 없다.';
