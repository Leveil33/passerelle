"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

type Merchant = { id: string; name: string; createdAt: string };
type Created = { ownerEmail: string; temporaryPassword: string | null; name: string };

export function PlatformPanel({ merchants }: { merchants: Merchant[] }) {
  const router = useRouter();
  const [f, setF] = useState({ name: "", ownerEmail: "", stampsRequired: "10", rewardLabel: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      const res = await fetch("/api/platform/merchants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: f.name, ownerEmail: f.ownerEmail, stampsRequired: Number(f.stampsRequired), ...(f.rewardLabel.trim() ? { rewardLabel: f.rewardLabel } : {}) }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; ownerEmail?: string; temporaryPassword?: string | null };
      if (res.ok) {
        setCreated({ ownerEmail: data.ownerEmail ?? f.ownerEmail, temporaryPassword: data.temporaryPassword ?? null, name: f.name });
        setF({ name: "", ownerEmail: "", stampsRequired: "10", rewardLabel: "" });
        router.refresh();
      } else setError(data.error ?? "Création impossible.");
    } catch {
      setError("Pas de connexion internet. Vérifiez votre réseau puis réessayez.");
    } finally {
      setBusy(false);
    }
  }

  const input = "w-full rounded-xl border border-zinc-300 bg-white px-3 py-3 text-base dark:border-zinc-700 dark:bg-zinc-900";
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 bg-white px-4 py-8 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
      <header>
        <p className="text-sm font-medium uppercase tracking-wide text-zinc-500">Propriétaire de la solution</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Créer un commerce</h1>
      </header>

      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm font-medium">Nom du commerce
          <input className={input} required maxLength={100} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">Adresse e-mail du propriétaire
          <input className={input} type="email" inputMode="email" required value={f.ownerEmail} onChange={(e) => setF({ ...f, ownerEmail: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">Nombre de cases (facultatif, 10 par défaut)
          <input className={input} type="number" inputMode="numeric" min={1} max={50} value={f.stampsRequired} onChange={(e) => setF({ ...f, stampsRequired: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">Récompense (facultatif)
          <input className={input} maxLength={100} placeholder="Une récompense offerte" value={f.rewardLabel} onChange={(e) => setF({ ...f, rewardLabel: e.target.value })} />
        </label>
        {error && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">{error}</p>}
        <button disabled={busy} className="rounded-xl bg-zinc-900 px-4 py-4 text-lg font-semibold text-white disabled:opacity-60 dark:bg-white dark:text-zinc-900">{busy ? "Création…" : "Créer le commerce"}</button>
      </form>

      {created && (
        <div role="status" className="rounded-xl border-2 border-amber-400 bg-amber-50 p-4 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-50">
          <p className="font-semibold">Commerce « {created.name} » créé.</p>
          {created.temporaryPassword ? (
            <>
              <p className="mt-2">Compte propriétaire : <strong>{created.ownerEmail}</strong>. Mot de passe provisoire (à transmettre, <strong>il ne sera plus jamais affiché</strong>) :</p>
              <p className="mt-1 select-all rounded bg-white px-3 py-2 font-mono text-lg tracking-wide text-black">{created.temporaryPassword}</p>
              <p className="mt-2">À sa première connexion sur <code>/staff</code>, il choisira son propre mot de passe.</p>
            </>
          ) : (
            <p className="mt-2"><strong>{created.ownerEmail}</strong> avait déjà un compte : le commerce lui a été rattaché, son mot de passe ne change pas.</p>
          )}
        </div>
      )}

      <section>
        <h2 className="text-lg font-semibold">Commerces ({merchants.length})</h2>
        <ul className="mt-3 flex flex-col gap-2">
          {merchants.map((m) => (
            <li key={m.id} className="rounded-xl bg-zinc-50 p-3 text-sm dark:bg-zinc-900">
              <strong>{m.name}</strong>
              <br /><span className="text-zinc-500">créé le {new Date(m.createdAt).toLocaleDateString("fr-FR")}</span>
            </li>
          ))}
          {merchants.length === 0 && <li className="text-sm text-zinc-500">Aucun commerce pour l&apos;instant.</li>}
        </ul>
      </section>
    </main>
  );
}
