/** 홈 목록에서 변형문제 묶음(`categories.is_variant`)을 모아 보여 주는 **가짜 폴더**의 id.
 * 실제 `folders` 행이 아니다 — 이름 바꾸기·삭제·옮기기는 막는다. */
export const VARIANT_FOLDER_ID = "_variant";

/** 원본을 단원별로 범주화해 둔 묶음(`hide_home`)을 모아 보여 주는 가짜 폴더 "유형별". */
export const UNIT_FOLDER_ID = "_unit";
export const isVirtualFolder = (id: string | null | undefined) => id === VARIANT_FOLDER_ID || id === UNIT_FOLDER_ID;
