-- AI 원가 장부에 **어느 모델이 답했는지**를 적는다 (2026-10-10, 사용자 — "앞으로 정확하게 나누고 과거 데이터도 전부").
-- 예전에는 `what`(일의 이름)만 있어 모델을 이름으로 짐작했다. 이제 줄마다 정식 모델 이름이 남는다.
-- 하위 호환: 칸만 더하고, 옛 줄은 `what` 규칙으로 채운다(지면 자리 찾기는 하이쿠가 거의 다라 하이쿠로 둔다).
alter table public.ai_cost_log add column if not exists model text;

update public.ai_cost_log set model = case
  when what like '하이쿠%' or what = '지면 자리 찾기' then 'claude-haiku-5.5'
  when what like '그림%' then 'gpt-image-2.5-sunburst'
  when what like 'sol %' or what in ('지문 읽기','서식 검수') or what like '지문 읽기(%' or what like '서식 검수(%' then 'gpt-6.1-sol'
  when what like 'luna %' or what in ('자동채점','답지 읽기','지문 제목 짓기') then 'gpt-6-luna'
  else null end
where model is null;
