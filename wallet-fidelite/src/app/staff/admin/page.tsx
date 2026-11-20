import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { loadAdminData } from "@/lib/admin/load";
import { getStaffSession } from "@/lib/staff/session";
import { AdminPanel } from "./admin-panel";

async function Guard() {
  const session = await getStaffSession();
  if (!session) redirect("/staff/login");
  if (session.mustChangePassword) redirect("/staff/mot-de-passe");
  const data = await loadAdminData(session.userId);
  if (!data || !data.program) {
    return (
      <main className="flex flex-1 flex-col justify-center gap-4">
        <h1 className="text-2xl font-semibold">Réservé aux propriétaires</h1>
        <p className="text-zinc-600 dark:text-zinc-400">Les réglages du commerce sont accessibles au propriétaire uniquement.</p>
        <Link href="/staff" className="font-medium underline">Retour</Link>
      </main>
    );
  }
  return <AdminPanel data={data} />;
}

export default function AdminPage() {
  return (
    <Suspense fallback={<p className="text-zinc-500">Chargement…</p>}>
      <Guard />
    </Suspense>
  );
}
