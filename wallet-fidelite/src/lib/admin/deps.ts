// Branchement de l'administration sur la session de l'utilisateur, la clé secrète (serveur) et les Wallets.
import "server-only";
import { after } from "next/server";
import { getAppleConfig } from "@/lib/apple/config";
import { getWalletStore } from "@/lib/apple/deps";
import { getGoogleDeps } from "@/lib/google/deps";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { json } from "@/lib/wallet/http";
import type { AdminDeps } from "./handlers";
import { propagatePrograms, type PropagateDeps } from "./propagate";
import { createSupabaseOwnerStore, createSupabaseServerAdmin } from "./supabase-stores";

export const PASSWORD_CHANGE_REQUIRED = { error: "Vous devez d'abord choisir votre propre mot de passe.", code: "password_change_required" };

/** Apple et Google s'ils sont configurés ; sinon ils sont simplement ignorés. */
function propagationDeps(): PropagateDeps {
  const deps: PropagateDeps = { store: getWalletStore() };
  try {
    deps.apple = { config: getAppleConfig(), host: process.env.APPLE_APNS_HOST || undefined };
  } catch {
    /* Apple non configuré */
  }
  try {
    deps.google = getGoogleDeps();
  } catch {
    /* Google non configuré */
  }
  return deps;
}

type Identity = { ok: false; response: Response } | { ok: true; supabase: SupabaseClient; user: User };

async function identify(allowPasswordChange: boolean): Promise<Identity> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return { ok: false, response: json({ error: "Session expirée : reconnectez-vous puis réessayez.", code: "not_authenticated" }, 401) };
  if (!allowPasswordChange && data.user.app_metadata?.must_change_password === true) return { ok: false, response: json(PASSWORD_CHANGE_REQUIRED, 403) };
  return { ok: true, supabase, user: data.user };
}

/** Réglages du propriétaire : exécutés AU NOM de l'employé connecté. */
export async function withOwner(run: (deps: AdminDeps) => Promise<Response>): Promise<Response> {
  try {
    const who = await identify(false);
    if (!who.ok) return who.response;
    return await run({
      owner: createSupabaseOwnerStore(who.supabase, who.user.id),
      server: createSupabaseServerAdmin(createAdminClient()),
      propagate: async (ids) => void (await propagatePrograms(ids, propagationDeps())),
      schedule: (work) => after(work),
    });
  } catch (e) {
    console.error("Erreur inattendue (administration) :", (e as Error).message);
    return json({ error: "Une erreur est survenue. Réessayez dans un instant.", code: "unknown" }, 500);
  }
}

/** Page et adresses de la propriétaire de la solution. */
export async function withPlatform(run: (deps: AdminDeps & { adminUserId: string }) => Promise<Response>): Promise<Response> {
  try {
    const who = await identify(false);
    if (!who.ok) return who.response;
    const server = createSupabaseServerAdmin(createAdminClient());
    return await run({
      owner: createSupabaseOwnerStore(who.supabase, who.user.id),
      server,
      propagate: async () => {},
      adminUserId: who.user.id,
    });
  } catch (e) {
    console.error("Erreur inattendue (plateforme) :", (e as Error).message);
    return json({ error: "Une erreur est survenue. Réessayez dans un instant.", code: "unknown" }, 500);
  }
}

/** Changement de mot de passe : autorisé même quand le changement est obligatoire. */
export async function withPasswordChange(run: (ctx: { server: ReturnType<typeof createSupabaseServerAdmin>; userId: string }) => Promise<Response>): Promise<Response> {
  try {
    const who = await identify(true);
    if (!who.ok) return who.response;
    return await run({ server: createSupabaseServerAdmin(createAdminClient()), userId: who.user.id });
  } catch (e) {
    console.error("Erreur inattendue (mot de passe) :", (e as Error).message);
    return json({ error: "Une erreur est survenue. Réessayez dans un instant.", code: "unknown" }, 500);
  }
}

export const getServerAdmin = () => createSupabaseServerAdmin(createAdminClient());
