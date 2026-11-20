import { Suspense } from "react";
import { checkSupabase } from "@/lib/supabase/check";

async function SupabaseStatus() {
  const { ok, steps } = await checkSupabase();

  return (
    <section
      className="w-full rounded-2xl border border-black/10 bg-white p-6 shadow-sm dark:border-white/15 dark:bg-zinc-900"
      aria-live="polite"
    >
      <h2 className="text-lg font-semibold">Connexion à Supabase</h2>
      <p
        className={`mt-1 text-sm font-medium ${ok ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}
      >
        {ok ? "Tout est branché correctement." : "Il reste quelque chose à régler."}
      </p>
      <ul className="mt-4 space-y-3">
        {steps.map((step) => (
          <li key={step.id} className="flex gap-3">
            <span aria-hidden className="text-xl leading-6">
              {step.ok ? "✅" : "❌"}
            </span>
            <span>
              <span className="block font-medium">{step.label}</span>
              <span className="block text-sm text-zinc-600 dark:text-zinc-400">
                {step.message}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-8 px-5 py-12">
      <header>
        <p className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          Phase 0 · Mise en place
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Carte de fidélité Wallet
        </h1>
        <p className="mt-3 text-zinc-600 dark:text-zinc-400">
          Cartes à tampons pour Apple Wallet et Google Wallet, et appli de scan
          pour les commerçants.
        </p>
      </header>

      <Suspense
        fallback={
          <p className="text-sm text-zinc-500">Vérification de Supabase…</p>
        }
      >
        <SupabaseStatus />
      </Suspense>
    </main>
  );
}
