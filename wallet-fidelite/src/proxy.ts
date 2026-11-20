// Rafraîchit la session de l'employé à chaque visite de l'appli commerçant (exigé par Supabase : les pages
// serveur ne peuvent pas toutes écrire les cookies). Ne décide d'aucun droit : chaque page et chaque adresse
// vérifie elle-même la connexion.
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        // Empêche qu'un cache intermédiaire ne garde une réponse qui pose des cookies de session.
        Object.entries(headers ?? {}).forEach(([k, v]) => response.headers.set(k, v));
      },
    },
  });

  try {
    await supabase.auth.getUser();
  } catch {
    // Supabase injoignable : on laisse passer ; la page affichera la connexion ou une erreur.
  }
  return response;
}

export const config = { matcher: ["/staff/:path*"] };
