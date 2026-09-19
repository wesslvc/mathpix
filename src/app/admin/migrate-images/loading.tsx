import PageSkeleton from "@/components/PageSkeleton";

/** `admin/kice-fonts/loading.tsx`와 같은 이유로 둔다. */
export default function Loading() {
  return <PageSkeleton maxWidth="max-w-lg" logo={false} rows={2} />;
}
