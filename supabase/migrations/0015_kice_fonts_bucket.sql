-- 평가원 문제지 양식에 쓰는 글꼴을 담을 비공개 버킷.
--
-- 글꼴 파일은 배포권이 우리에게 없어서 **저장소에 커밋할 수 없다.** 여기에
-- 올려 두고 로그인한 사용자만 서버(`/api/kice/font/[file]`)를 거쳐 받아 간다.
-- 버킷 자체가 비공개라 URL 을 알아도 그냥은 못 받는다.
--
-- 올리는 법: node scripts/upload-kice-fonts.mjs <글꼴 폴더>

insert into storage.buckets (id, name, public)
values ('kice-fonts', 'kice-fonts', false)
on conflict (id) do nothing;

-- 읽기는 로그인한 사용자 모두에게 연다(문제지 양식은 개인 자료가 아니다).
-- 쓰기 정책은 만들지 않는다 — 올리는 일은 service_role 키를 쓰는 스크립트로만 한다.
drop policy if exists "kice_fonts_read" on storage.objects;
create policy "kice_fonts_read" on storage.objects
  for select using (bucket_id = 'kice-fonts' and auth.role() = 'authenticated');
