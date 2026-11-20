import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getServerAdmin } from "@/lib/admin/deps";
import { createClient } from "@/lib/supabase/server";
import { PlatformPanel } from "./platform-panel";

export const metadata = { title: "Administration — Fidélité", robots: { index: false, follow: false } };

async function Guard() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const server = getServerAdmin();
  // Cette page n'existe que pour la propriétaire de la solution : pour toute autre personne, c'est une page inexistante.
  if (!data.user || !(await server.isPlatformAdmin(data.user.id))) notFound();
  return <PlatformPanel merchants={await server.listMerchants()} />;
}

export default function PlatformPage() {
  return (
    <Suspense fallback={<p className="p-6 text-zinc-500">Chargement…</p>}>
      <Guard />
    </Suspense>
  );
}
