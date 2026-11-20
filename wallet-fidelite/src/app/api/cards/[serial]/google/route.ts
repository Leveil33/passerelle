// Ajouter la carte à Google Wallet : redirige vers le lien signé « Ajouter à Google Wallet ».
import { withGoogleDeps } from "@/lib/google/deps";
import { handleGoogleLink } from "@/lib/google/web-service";

export async function GET(req: Request, ctx: { params: Promise<{ serial: string }> }) {
  const params = await ctx.params;
  return withGoogleDeps((deps) => handleGoogleLink(req, params, deps));
}
