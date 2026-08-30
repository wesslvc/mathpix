-- 영어 과목 채점을 추가하면서 subject 체크 제약을 넓힌다.
alter table public.exam_scores drop constraint exam_scores_subject_check;
alter table public.exam_scores add constraint exam_scores_subject_check
  check (subject in ('korean', 'math', 'english', 'elective'));
