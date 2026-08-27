-- 국어는 문항 단위 오답 업로드가 없다(지문이 여러 문항에 걸쳐 있어
-- "문제 하나 사진"이라는 단위와 안 맞는다). 대신 시험지 전체에 대한
-- 메모를 남길 수 있게 한다.
alter table public.exam_scores add column comment text;
