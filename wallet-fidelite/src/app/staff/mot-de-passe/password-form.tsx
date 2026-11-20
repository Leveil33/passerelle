"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export function PasswordForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 10) return setError("Le mot de passe doit faire au moins 10 caractères.");
    if (password !== confirm) return setError("Les deux mots de passe ne sont pas identiques.");
    setBusy(true);
    try {
      const res = await fetch("/api/staff/password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
      if (res.ok) {
        router.replace("/staff");
        router.refresh();
        return;
      }
      if (res.status === 401) return router.replace("/staff/login");
      setError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Impossible de changer le mot de passe pour le moment.");
    } catch {
      setError("Pas de connexion internet. Vérifiez votre réseau puis réessayez.");
    } finally {
      setBusy(false);
    }
  }

  const field = "w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 text-lg dark:border-zinc-700 dark:bg-zinc-900";
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm font-medium">
        Nouveau mot de passe (10 caractères minimum)
        <input className={field} type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Répétez le mot de passe
        <input className={field} type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </label>
      {error && (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-red-800 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy} className="rounded-xl bg-zinc-900 px-4 py-4 text-lg font-semibold text-white disabled:opacity-60 dark:bg-white dark:text-zinc-900">
        {busy ? "Enregistrement…" : "Enregistrer mon mot de passe"}
      </button>
    </form>
  );
}
