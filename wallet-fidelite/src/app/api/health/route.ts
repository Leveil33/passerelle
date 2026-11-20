// GET /api/health : état de la connexion à Supabase (aucun secret n'est renvoyé).
import { checkSupabase } from "@/lib/supabase/check";

export async function GET() {
  const result = await checkSupabase();
  return Response.json(result, { status: result.ok ? 200 : 503 });
}
