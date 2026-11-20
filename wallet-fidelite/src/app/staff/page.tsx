import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getStaffSession } from "@/lib/staff/session";
import { LogoutButton } from "./logout-button";

async function Home() {
  const session = await getStaffSession();
  if (!session) redirect("/staff/login");

  if (session.memberships.length === 0) {
    return (
      <main className="flex flex-1 flex-col justify-center gap-6">
        <h1 className="text-2xl font-semibold">Compte non rattaché à un commerce</h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          Vous êtes connecté·e{session.email ? ` (${session.email})` : ""}, mais ce compte n&apos;est lié à aucun commerce. Contactez le responsable de la solution.
        </p>
        <LogoutButton />
      </main>
    );
  }

  const names = [...new Set(session.memberships.map((m) => m.merchantName))].join(", ");
  return (
    <main className="flex flex-1 flex-col gap-8">
      <header>
        <p className="text-sm font-medium uppercase tracking-wide text-zinc-500">Espace commerçant</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{names}</h1>
      </header>
      <Link href="/staff/scan" className="rounded-2xl bg-green-600 px-6 py-8 text-center text-2xl font-bold text-white shadow active:bg-green-700">
        Scanner une carte
      </Link>
      <div className="mt-auto">
        <LogoutButton />
      </div>
    </main>
  );
}

export default function StaffHome() {
  return (
    <Suspense fallback={<p className="text-zinc-500">Chargement…</p>}>
      <Home />
    </Suspense>
  );
}
