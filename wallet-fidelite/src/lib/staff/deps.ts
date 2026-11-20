// Branchement des adresses de l'appli commerçant sur la session de l'employé et les Wallets.
import "server-only";
import { after } from "next/server";
import { getQrSecret } from "@/lib/loyalty/qr";
import { createClient } from "@/lib/supabase/server";
import { json } from "@/lib/wallet/http";
import { notifyWallets } from "@/lib/wallet/notify-all";
import type { StaffDeps } from "./handlers";
import { createSupabaseStaffStore } from "./supabase-store";

/** Vérifie la connexion de l'employé, puis exécute le traitement avec ses droits (jamais la clé secrète). */
export async function withStaff(run: (deps: StaffDeps) => Promise<Response>): Promise<Response> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      return json({ error: "Session expirée : reconnectez-vous puis réessayez.", code: "not_authenticated" }, 401);
    }
    return await run({
      staff: createSupabaseStaffStore(supabase),
      qrSecret: getQrSecret(),
      schedule: (work) => after(work),
      notify: notifyWallets,
    });
  } catch (e) {
    console.error("Erreur inattendue (appli commerçant) :", (e as Error).message);
    return json({ error: "Une erreur est survenue. Réessayez dans un instant.", code: "unknown" }, 500);
  }
}
