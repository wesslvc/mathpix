"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LogoutButton() {
  const router = useRouter();

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      className="rounded-lg border border-slate-300 dark:border-[#4a4d51] px-3 py-1.5 text-sm text-slate-600 dark:text-[#bdc1c6] hover:bg-slate-100 dark:hover:bg-[#303134]"
    >
      로그아웃
    </button>
  );
}
