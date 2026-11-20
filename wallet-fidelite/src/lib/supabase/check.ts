// Vérifie que l'application arrive bien à parler à Supabase.
// Utilisé par la page d'accueil (contrôle visuel) et par /api/health.
import "server-only";
import { createAdminClient } from "./admin";

export type CheckStep = {
  id: "env" | "public" | "admin";
  label: string;
  ok: boolean;
  message: string;
};

export type SupabaseCheck = { ok: boolean; steps: CheckStep[] };

const REQUIRED_VARS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

export async function checkSupabase(): Promise<SupabaseCheck> {
  const steps: CheckStep[] = [];

  // 1. Variables d'environnement présentes ?
  const missing = REQUIRED_VARS.filter((name) => !process.env[name]);
  steps.push({
    id: "env",
    label: "Variables d'environnement",
    ok: missing.length === 0,
    message:
      missing.length === 0
        ? "Les 3 variables Supabase sont renseignées."
        : `Manquantes : ${missing.join(", ")} (copie .env.example vers .env.local).`,
  });
  if (missing.length > 0) return { ok: false, steps };

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  let reachable = true;

  // 2. Adresse du projet + clé publique valides ?
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/auth/v1/health`, {
      headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    steps.push({
      id: "public",
      label: "Projet Supabase et clé publique",
      ok: res.ok,
      message: res.ok
        ? "Le projet répond et la clé publique est acceptée."
        : res.status === 401 || res.status === 403
          ? "Le projet répond mais la clé publique est refusée (vérifie NEXT_PUBLIC_SUPABASE_ANON_KEY)."
          : `Le projet a répondu avec le code ${res.status}.`,
    });
  } catch {
    reachable = false;
    steps.push({
      id: "public",
      label: "Projet Supabase et clé publique",
      ok: false,
      message:
        "Impossible de joindre le projet (vérifie NEXT_PUBLIC_SUPABASE_URL et ta connexion).",
    });
  }

  // 3. Clé secrète (service_role) valide ?
  if (!reachable) {
    steps.push({
      id: "admin",
      label: "Clé secrète (serveur)",
      ok: false,
      message: "Non vérifiée : le projet est injoignable.",
    });
    return { ok: false, steps };
  }

  try {
    const { error } = await createAdminClient().auth.admin.listUsers({
      page: 1,
      perPage: 1,
    });
    const refused = error?.status === 401 || error?.status === 403;
    steps.push({
      id: "admin",
      label: "Clé secrète (serveur)",
      ok: !error,
      message: !error
        ? "La clé secrète est acceptée."
        : refused
          ? "La clé secrète est refusée (vérifie SUPABASE_SERVICE_ROLE_KEY)."
          : "Impossible de vérifier la clé secrète (réponse inattendue de Supabase).",
    });
  } catch {
    steps.push({
      id: "admin",
      label: "Clé secrète (serveur)",
      ok: false,
      message: "Impossible de vérifier la clé secrète (projet injoignable ?).",
    });
  }

  return { ok: steps.every((s) => s.ok), steps };
}
