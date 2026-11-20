// Client Supabase côté serveur, au nom de l'utilisateur connecté (cookies de session).
// Les règles de sécurité (RLS) s'appliquent : on ne voit que les données de son commerce.
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Appelé depuis un composant serveur : on ne peut pas écrire de cookie ici.
            // Sans conséquence, la session sera rafraîchie ailleurs (proxy, phase 4).
          }
        },
      },
    },
  );
}
