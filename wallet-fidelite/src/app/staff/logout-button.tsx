"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="w-full rounded-xl border border-zinc-300 px-4 py-3 font-medium dark:border-zinc-700"
      onClick={async () => {
        await createClient().auth.signOut();
        router.replace("/staff/login");
        router.refresh();
      }}
    >
      Se déconnecter
    </button>
  );
}
