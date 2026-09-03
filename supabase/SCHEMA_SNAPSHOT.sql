-- =====================================================================
-- 실제 운영 DB(bmhupmkxzvbqndxkvjmx)에서 그대로 떠 온 스키마 스냅샷
-- 뜬 날짜: 2026-08-31
-- =====================================================================
--
-- **왜 이 파일이 따로 있나**
--
-- `supabase/migrations/*.sql` 은 지금까지 **대시보드에서 손으로** 돌렸다.
-- 그래서 `supabase_migrations` 테이블이 비어 있고(= `list_migrations` 가
-- 아무것도 안 보여준다), 마이그레이션 파일과 실제 DB 가 어긋나 있어도
-- 알아챌 방법이 없다. 이 파일은 **실제로 적용돼 있는 것**을 그대로 적어
-- 둔 것이라, 새 환경을 만들거나 어긋난 곳을 찾을 때 기준이 된다.
--
-- **쓰는 법**
--   새 프로젝트를 만들 때: 이 파일을 통째로 SQL Editor 에 붙여 실행한다.
--   기존 DB 를 점검할 때: 마이그레이션 파일이 아니라 이 파일과 견준다.
--
-- **주의**
--   - 이미 있는 DB 에 그대로 돌리지 말 것(정책 이름 충돌로 멈춘다).
--     `create policy` 는 `if not exists` 를 지원하지 않는다.
--   - 데이터는 들어 있지 않다. 스키마·정책·함수·버킷만이다.
--   - `auth.users` 는 Supabase 가 만든다(여기서 만들지 않는다).
--   - 0010~0014 가 만든 diagram_* 테이블·함수는 **지금 아무도 부르지
--     않는다**(Gemini 도형 경로를 걷어냈다). 남겨 둔 것은 무해해서다.
--
-- =====================================================================

-- ── 1) 실모(카테고리) ─────────────────────────────────────────────
create table if not exists public.folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);
create index if not exists folders_user_idx on public.folders (user_id);

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source text not null,
  title text,
  created_at timestamptz not null default now(),
  is_exam boolean not null default false,
  score integer,
  exam_date date,
  -- 폴더를 지워도 안의 실모는 남는다(폴더 없음으로 돌아간다).
  folder_id uuid references public.folders (id) on delete set null
);
create index if not exists categories_user_id_idx on public.categories (user_id);
create index if not exists categories_folder_idx on public.categories (folder_id);

-- ── 2) 오답(문제) ────────────────────────────────────────────────
-- box_range(jsonb) 한 곳에 여러 값이 얹혀 있다. **새 컬럼을 만들지 않는
-- 것이 이 저장소의 관행**이다 — 마이그레이션을 안 돌린 사람에게는 없는
-- 컬럼에 쓰는 순간 저장 자체가 실패하기 때문이다.
--   { ranges, fontPt, figures, number, debt, gradeId, points }
create table if not exists public.problems (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.categories (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  image_path text not null,
  latex text,
  text_content text,
  created_at timestamptz not null default now(),
  sort_order integer,
  answer text,
  answer_type text,
  box_range jsonb
);
create index if not exists problems_category_id_idx on public.problems (category_id);
create index if not exists problems_user_id_idx on public.problems (user_id);

-- ── 3) 자동채점 기록 ──────────────────────────────────────────────
-- 탐구 1선택/2선택은 서로 다른 과목이라 **각각 독립된 행**이다.
create table if not exists public.exam_scores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- 실모를 지워도 채점 기록은 남긴다.
  category_id uuid references public.categories (id) on delete set null,
  subject text not null check (subject in ('korean', 'math', 'english', 'elective')),
  elective_slot smallint check (elective_slot in (1, 2)),
  -- 탐구 과목명이자 국어·수학의 선택과목명(자리를 넓혀 쓴다).
  elective_label text,
  total_questions integer not null check (total_questions > 0),
  correct_count integer not null check (correct_count >= 0),
  wrong_numbers integer[] not null default '{}'::integer[],
  score integer,
  taken_at date not null default current_date,
  created_at timestamptz not null default now(),
  exam_name text,
  -- 등급컷은 해마다 달라 계산할 수 없다 — 사용자가 직접 고른다.
  grade_level smallint check (grade_level between 1 and 9),
  -- GradedItemRow[]: { no, studentAnswer, correctAnswer, points? }
  items jsonb,
  -- 국어 전용 — 시험지 전체 메모.
  comment text
);
create index if not exists exam_scores_user_taken_idx on public.exam_scores (user_id, taken_at);
create index if not exists exam_scores_category_idx on public.exam_scores (category_id);

-- ── 4) 채점 기본 과목 설정(프로필) ───────────────────────────────
create table if not exists public.grading_prefs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  subject text,
  math_elective text,
  korean_elective text,
  tamgu_single boolean not null default false,
  elective1_label text,
  elective2_label text,
  updated_at timestamptz not null default now()
);

-- ── 5) 결제·이용권 ───────────────────────────────────────────────
create table if not exists public.entitlements (
  user_id uuid primary key references auth.users (id) on delete cascade,
  active boolean not null default false,
  plan text,
  is_recurring boolean not null default false,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  credits integer not null default 0,
  flash_diagram_date date,
  flash_diagram_used integer not null default 0,
  unlimited boolean not null default false
);

create table if not exists public.payment_refs (
  ref text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.groble_merchants (
  merchant_uid text primary key,
  seller_reference text not null,
  user_id uuid references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.groble_webhook_events (
  idempotency_key text primary key,
  event_id text,
  type text,
  received_at timestamptz not null default now()
);

-- ── 6) 인식 기록 ─────────────────────────────────────────────────
create table if not exists public.problem_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  latex text not null,
  text text not null,
  confidence numeric,
  is_mock boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists problem_history_user_id_created_at_idx
  on public.problem_history (user_id, created_at desc);

-- ── 7) (지금은 안 쓰는) 도형 모델 쿼터 ──────────────────────────
-- Gemini 도형 경로를 걷어내면서 아무도 안 부르게 됐다. 지우지 않은 것은
-- 남겨 둬도 무해하고, 되살릴 때 기준이 되기 때문이다.
create table if not exists public.diagram_daily_usage (
  day date not null,
  model text not null,
  used integer not null default 0,
  primary key (day, model)
);

create table if not exists public.diagram_model_tiers (
  tier integer primary key,
  model_id text not null unique,
  daily_limit integer not null default 20,
  enabled boolean not null default true
);

create table if not exists public.diagram_usage_log (
  id bigserial primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  model text not null,
  used_at timestamptz not null default now()
);
create index if not exists diagram_usage_log_user_idx
  on public.diagram_usage_log (user_id, used_at desc);
create index if not exists diagram_usage_log_used_at_idx
  on public.diagram_usage_log (used_at desc);

-- ── 8) RLS ───────────────────────────────────────────────────────
alter table public.folders          enable row level security;
alter table public.categories       enable row level security;
alter table public.problems         enable row level security;
alter table public.exam_scores      enable row level security;
alter table public.grading_prefs    enable row level security;
alter table public.entitlements     enable row level security;
alter table public.payment_refs     enable row level security;
alter table public.groble_merchants enable row level security;
alter table public.groble_webhook_events enable row level security;
alter table public.problem_history  enable row level security;
alter table public.diagram_daily_usage enable row level security;
alter table public.diagram_model_tiers enable row level security;
alter table public.diagram_usage_log   enable row level security;

create policy "folders_select_own" on public.folders for select using (auth.uid() = user_id);
create policy "folders_insert_own" on public.folders for insert with check (auth.uid() = user_id);
create policy "folders_update_own" on public.folders for update using (auth.uid() = user_id);
create policy "folders_delete_own" on public.folders for delete using (auth.uid() = user_id);

create policy "categories_select_own" on public.categories for select using (auth.uid() = user_id);
create policy "categories_insert_own" on public.categories for insert with check (auth.uid() = user_id);
create policy "categories_update_own" on public.categories for update using (auth.uid() = user_id);
create policy "categories_delete_own" on public.categories for delete using (auth.uid() = user_id);

create policy "problems_select_own" on public.problems for select using (auth.uid() = user_id);
create policy "problems_insert_own" on public.problems for insert with check (auth.uid() = user_id);
create policy "problems_update_own" on public.problems for update using (auth.uid() = user_id);
create policy "problems_delete_own" on public.problems for delete using (auth.uid() = user_id);

create policy "exam_scores_select_own" on public.exam_scores for select using (auth.uid() = user_id);
create policy "exam_scores_insert_own" on public.exam_scores for insert with check (auth.uid() = user_id);
create policy "exam_scores_update_own" on public.exam_scores for update using (auth.uid() = user_id);
create policy "exam_scores_delete_own" on public.exam_scores for delete using (auth.uid() = user_id);

create policy "grading_prefs_select_own" on public.grading_prefs for select using (auth.uid() = user_id);
create policy "grading_prefs_insert_own" on public.grading_prefs for insert with check (auth.uid() = user_id);
create policy "grading_prefs_update_own" on public.grading_prefs for update using (auth.uid() = user_id);

-- 아래 셋은 **읽기만** 열려 있다. 쓰기는 서버(service_role)만 한다.
create policy "entitlements_select_own" on public.entitlements for select using (auth.uid() = user_id);
create policy "groble_merchants_select_own" on public.groble_merchants for select using (auth.uid() = user_id);
create policy "diagram_usage_log_select_own" on public.diagram_usage_log for select using (auth.uid() = user_id);

create policy "payment_refs_select_own" on public.payment_refs for select using (auth.uid() = user_id);
create policy "payment_refs_insert_own" on public.payment_refs for insert with check (auth.uid() = user_id);

create policy "Users can view own history"   on public.problem_history for select using (auth.uid() = user_id);
create policy "Users can insert own history" on public.problem_history for insert with check (auth.uid() = user_id);
create policy "Users can delete own history" on public.problem_history for delete using (auth.uid() = user_id);

-- groble_webhook_events / diagram_daily_usage / diagram_model_tiers 는
-- 사용자 정책이 없다(= service_role 만 접근).

-- ── 9) 스토리지 ──────────────────────────────────────────────────
insert into storage.buckets (id, name, public) values ('problem-images', 'problem-images', false)
  on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('kice-fonts', 'kice-fonts', false)
  on conflict (id) do nothing;

-- **경로의 첫 조각이 곧 사용자 id 다**(`{uid}/{categoryId}/{uuid}.png`).
-- 이 규칙 때문에 서비스 키 없이도 본인 것만 올리고 읽을 수 있다.
create policy "problem_images_select_own" on storage.objects for select
  using (bucket_id = 'problem-images' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "problem_images_insert_own" on storage.objects for insert
  with check (bucket_id = 'problem-images' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "problem_images_delete_own" on storage.objects for delete
  using (bucket_id = 'problem-images' and auth.uid()::text = (storage.foldername(name))[1]);
-- UPDATE 정책은 **일부러 없다** — 그래서 덮어쓰기(upsert)를 쓸 수 없고,
-- 이미지를 고칠 때는 새 경로에 올리고 옛것을 지운다(cardThumb.ts 주석 참고).

-- 평가원 글꼴은 배포권이 없어 저장소에 두지 않는다. 로그인한 사람만 받는다.
create policy "kice_fonts_read" on storage.objects for select
  using (bucket_id = 'kice-fonts' and auth.role() = 'authenticated');

-- ── 10) 함수 ─────────────────────────────────────────────────────
-- 토큰 차감·환불. **금액을 인자로 받는다**(그림 생성은 50, 채점은 5처럼
-- 기능마다 다르다). 무제한 계정은 차감 없이 통과시킨다 — 예전에 이
-- 검사가 없어서 무제한인데 잔액 0이면 402로 막히는 일이 있었다.
create or replace function public.consume_recognition_credit(p_amount integer default 1)
returns integer language plpgsql security definer set search_path to 'public' as $$
declare
  uid uuid := auth.uid();
  remaining integer;
  v_unlimited boolean;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  insert into public.entitlements (user_id, credits) values (uid, 50)
    on conflict (user_id) do nothing;

  select unlimited into v_unlimited from public.entitlements where user_id = uid;
  if v_unlimited is true then return 999999; end if;

  update public.entitlements
     set credits = credits - p_amount, updated_at = now()
   where user_id = uid and credits >= p_amount
   returning credits into remaining;

  return remaining; -- null 이면 크레딧 부족
end;
$$;

create or replace function public.refund_recognition_credit(p_amount integer default 1)
returns integer language plpgsql security definer set search_path to 'public' as $$
declare
  uid uuid := auth.uid();
  remaining integer;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  update public.entitlements
     set credits = credits + p_amount, updated_at = now()
   where user_id = uid
   returning credits into remaining;
  return remaining;
end;
$$;

-- 결제 웹훅이 부른다(service_role).
create or replace function public.grant_recognition_credits(p_user_id uuid, p_amount integer)
returns integer language sql security definer set search_path to 'public' as $$
  insert into public.entitlements (user_id, credits, active, updated_at)
  values (p_user_id, greatest(p_amount, 0), true, now())
  on conflict (user_id) do update
    set credits = public.entitlements.credits + excluded.credits,
        active = true,
        updated_at = now()
  returning credits;
$$;

create or replace function public.kst_today()
returns date language sql stable as $$
  select (now() at time zone 'Asia/Seoul')::date
$$;

-- 아래 도형 쿼터 함수들은 지금 아무도 부르지 않는다(위 7 참고).
-- 되살릴 일이 있으면 `supabase/migrations/0010~0014` 를 볼 것.
create or replace function public.flash_diagram_daily_limit()
returns integer language sql immutable as $$ select 5 $$;
create or replace function public.flash_global_daily_limit()
returns integer language sql immutable as $$ select 20 $$;
create or replace function public.lite_diagram_cost()
returns integer language sql immutable as $$ select 5 $$;
