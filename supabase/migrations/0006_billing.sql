-- 결제/이용권 (그로블 웹훅 연동) 스키마
-- Supabase 대시보드 > SQL Editor 에서 이 파일 내용을 그대로 실행하세요.
--
-- 무료 체험(오답 5개)을 넘으면 이용권을 결제해야 계속 쓸 수 있는 구조.
-- 결제 상태는 그로블 웹훅이 service_role 키로 기록한다(아래 테이블들은 사용자가
-- 직접 못 쓰고 읽기만 가능, 쓰기는 서버 전용).

-- 1) 이용권 : 사용자별 결제 상태
create table if not exists public.entitlements (
  user_id uuid primary key references auth.users (id) on delete cascade,
  active boolean not null default false,
  plan text,
  is_recurring boolean not null default false,
  expires_at timestamptz,          -- null이면 무기한(일반결제), 정기결제는 다음 갱신 시각
  updated_at timestamptz not null default now()
);

alter table public.entitlements enable row level security;

create policy "entitlements_select_own" on public.entitlements
  for select using (auth.uid() = user_id);
-- insert/update는 서버(service_role)만. 사용자 쓰기 정책 없음.

-- 2) 결제 참조값(?ref= 토큰) ↔ 사용자 매핑
create table if not exists public.payment_refs (
  ref text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.payment_refs enable row level security;

create policy "payment_refs_select_own" on public.payment_refs
  for select using (auth.uid() = user_id);

create policy "payment_refs_insert_own" on public.payment_refs
  for insert with check (auth.uid() = user_id);

-- 3) merchantUid ↔ sellerReference 매핑 (취소·환불 이벤트 연결용, 서버가 기록)
create table if not exists public.groble_merchants (
  merchant_uid text primary key,
  seller_reference text not null,
  user_id uuid references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.groble_merchants enable row level security;

create policy "groble_merchants_select_own" on public.groble_merchants
  for select using (auth.uid() = user_id);

-- 4) 웹훅 먱등 처리 (같은 이벤트 두 번 처리 방지, 서버 전용)
create table if not exists public.groble_webhook_events (
  idempotency_key text primary key,
  event_id text,
  type text,
  received_at timestamptz not null default now()
);

alter table public.groble_webhook_events enable row level security;
-- 사용자 정책 없음(서버 service_role만 접근).
