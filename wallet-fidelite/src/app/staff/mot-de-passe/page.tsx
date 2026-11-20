import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getStaffSession } from "@/lib/staff/session";
import { PasswordForm } from "./password-form";

async function Guard() {
  const session = await getStaffSession();
  if (!session) redirect("/staff/login");
  return (
    <main className="flex flex-1 flex-col justify-center gap-6">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Choisissez votre mot de passe</h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">
          {session.mustChangePassword
            ? "Votre mot de passe actuel est provisoire. Choisissez-en un qui n'est connu que de vous : vous en aurez besoin à chaque connexion."
            : "Choisissez un nouveau mot de passe."}
        </p>
      </header>
      <PasswordForm />
    </main>
  );
}

export default function PasswordPage() {
  return (
    <Suspense fallback={<p className="text-zinc-500">Chargement…</p>}>
      <Guard />
    </Suspense>
  );
}
