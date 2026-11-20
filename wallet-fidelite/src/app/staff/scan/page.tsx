import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getStaffSession } from "@/lib/staff/session";
import { Scanner } from "./scanner";

async function Guard() {
  const session = await getStaffSession();
  if (!session) redirect("/staff/login");
  if (session.mustChangePassword) redirect("/staff/mot-de-passe");
  if (session.memberships.length === 0) redirect("/staff");
  return <Scanner />;
}

export default function ScanPage() {
  return (
    <Suspense fallback={<p className="text-zinc-500">Chargement…</p>}>
      <Guard />
    </Suspense>
  );
}
