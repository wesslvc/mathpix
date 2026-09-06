-- 성적을 **손으로 적어 넣을 수 있게** 한다(사용자 요청 — "추세 볼 수 있게 성적
-- 수동 입력도 가능하게 해줘").
--
-- 지금까지 `exam_scores` 행은 자동채점(OMR + 답지 사진)으로만 생겼다. 그런데
-- 추세 그래프에 필요한 것은 **과목·응시일·점수(또는 등급)** 뿐이고, 이미 채점이
-- 끝난 시험이나 성적표만 들고 있는 시험은 그 넷을 그냥 적어 넣으면 된다.
--
-- 그런 기록에는 **문항 수도 맞은 개수도 없다.** 지어내면(예: 1문항 중 1개 정답)
-- 목록에 "전부 정답"처럼 사실이 아닌 말이 찍힌다. 그래서 0 을 넣을 수 있게
-- 제약을 넓히고, 화면은 `total_questions = 0` 을 "문항 정보 없음"으로 읽는다.
--
-- `correct_count` 는 이미 `>= 0` 이라 손댈 것이 없고, `score` 도 원래
-- nullable 이다(등급만 적어 두는 기록도 있다).
alter table public.exam_scores drop constraint exam_scores_total_questions_check;
alter table public.exam_scores add constraint exam_scores_total_questions_check
  check (total_questions >= 0);
