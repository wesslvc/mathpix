-- AI 원가 장부에 토큰 수를 함께 적는다 (2026-10-01).
--
-- 프롬프트 캐시를 노리게 바꿨는데(`postResponses`, gradeExam.ts) 맞았는지 볼 곳이 없었다 — 장부에는 원만
-- 있고, Vercel 로그는 한 시간이면 사라진다. 입력·캐시에서 읽은 입력·출력 토큰을 남겨 캐시 적중률을 잰다.
-- 옛 줄은 비어 있다(null).
alter table public.ai_cost_log
  add column if not exists in_tokens integer,
  add column if not exists cached_tokens integer,
  add column if not exists out_tokens integer;
