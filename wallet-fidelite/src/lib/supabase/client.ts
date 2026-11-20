// Client Supabase utilisé dans le navigateur (composants "use client").
// N'utilise que la clé publique : elle peut être visible, la sécurité repose sur la RLS.
import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
