-- AI 로 그리기 전 원본(`box_range.figures[].origin`)을 일정 기간 뒤에 지운다.
--
-- **왜 필요한가**: 원본은 "원본으로 되돌리기"와 "다른 지시로 다시 그리기"를
-- 위한 보험인데, 2026-09-16 실측으로 **DB 264MB 중 123MB(그림 120장, 장당
-- 평균 1MB)** 를 차지하고 있었다. 무료 한도가 500MB 라 이대로면 문제 590개
-- 언저리에서 벽에 닿는다. 사용자가 정한 방침은 **"AI 결과가 마음에 들면
-- 버리기"** — 결과를 보고 판단할 시간(기본 14일)만 주고 그 뒤에는 지운다.
--
-- **이미지를 열 필요가 없다.** jsonb 에서 키 하나를 떼는 일이라 SQL 만으로
-- 끝난다(PNG→JPEG 변환 때처럼 Edge Function 을 띄울 이유가 없다).
--
-- 담은 때는 `originAt`(ISO 문자열, `src/lib/figureOrigin.ts` 가 적는다).
-- 그 값이 없는 옛 데이터는 **문제를 만든 날**로 친다 — 이 기능 이전에 생긴
-- 원본은 어차피 충분히 오래됐다.

create or replace function public.expire_figure_origins(p_days integer default 14)
returns table (rows_touched integer, bytes_freed bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cutoff timestamptz := now() - make_interval(days => greatest(p_days, 0));
  v_rows integer := 0;
  v_bytes bigint := 0;
begin
  with target as (
    select
      p.id,
      -- 지울 대상의 크기(보고용).
      (
        select coalesce(sum(length(f->>'origin')), 0)
        from jsonb_array_elements(p.box_range->'figures') f
        where f ? 'origin'
          and public.figure_origin_at(f, p.created_at) < v_cutoff
      )::bigint as drop_bytes,
      -- 오래된 것에서만 origin/originAt 두 키를 뗀 새 배열.
      (
        select jsonb_agg(
                 case
                   when f ? 'origin'
                    and public.figure_origin_at(f, p.created_at) < v_cutoff
                   then (f - 'origin') - 'originAt'
                   else f
                 end
                 order by ord
               )
        from jsonb_array_elements(p.box_range->'figures')
             with ordinality as t(f, ord)
      ) as new_figures
    from public.problems p
    where jsonb_typeof(p.box_range->'figures') = 'array'
      and exists (
        select 1
        from jsonb_array_elements(p.box_range->'figures') f
        where f ? 'origin'
          and public.figure_origin_at(f, p.created_at) < v_cutoff
      )
  ),
  updated as (
    update public.problems p
       set box_range = jsonb_set(p.box_range, '{figures}', t.new_figures)
      from target t
     where p.id = t.id
    returning t.drop_bytes
  )
  select count(*)::integer, coalesce(sum(drop_bytes), 0)::bigint
    into v_rows, v_bytes
    from updated;

  rows_touched := v_rows;
  bytes_freed := v_bytes;
  return next;
end;
$$;

-- `originAt` 을 안전하게 읽는다. **깨진 값 하나에 청소 전체가 멈추면 안 된다** —
-- ISO 꼴이 아니면 문제를 만든 날로 떨어진다.
create or replace function public.figure_origin_at(
  p_figure jsonb,
  p_fallback timestamptz
)
returns timestamptz
language sql
immutable
as $$
  select case
           when p_figure->>'originAt' ~ '^\d{4}-\d{2}-\d{2}T'
             then (p_figure->>'originAt')::timestamptz
           else p_fallback
         end;
$$;

revoke all on function public.expire_figure_origins(integer) from public, anon, authenticated;
