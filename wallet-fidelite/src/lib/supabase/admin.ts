// Client Supabase "administrateur" : contourne la RLS. RÉSERVÉ AU SERVEUR.
// À utiliser uniquement pour les opérations internes (Wallet Apple/Google, push, scan signé…),
// toujours après avoir vérifié les droits de l'appelant.
import "server-only";
import { createClient } from "@supabase/supabase-js";

export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquante (voir .env.example).",
    );
  }

  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
