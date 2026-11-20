// Ajouter la carte à Google Wallet : redirige vers le lien signé « Ajouter à Google Wallet ».
import { withGoogleDeps } from "@/lib/google/deps";
import { handleGoogleLink } from "@/lib/google/web-service";

export async function GET(req: Request, ctx: { params: Promise<{ card: string }> }) {
  const { card } = await ctx.params;
  const params = { serial: card };
  return withGoogleDeps((deps) => handleGoogleLink(req, params, deps));
}
