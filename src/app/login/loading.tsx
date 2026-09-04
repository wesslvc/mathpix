import PageSkeleton from "@/components/PageSkeleton";

/**
 * 화면 전환 즉시 보이는 뼈대. 없으면 Next 가 서버 응답을 다 받을 때까지
 * 이전 화면에 머물러 "눌렀는데 아무 일도 안 일어난다"로 보인다.
 * 자세한 이유는 `PageSkeleton` 주석 참고.
 */
export default function Loading() {
  return <PageSkeleton maxWidth="max-w-md" logo={true} rows={1} />;
}
