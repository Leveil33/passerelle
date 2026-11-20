// Télécharger la carte pour l'ajouter à Apple Wallet.
import { withWalletDeps } from "@/lib/apple/deps";
import { handleDownloadPass } from "@/lib/apple/web-service";

export async function GET(req: Request, ctx: { params: Promise<{ card: string }> }) {
  const { card } = await ctx.params;
  const params = { serial: card };
  return withWalletDeps((deps) => handleDownloadPass(req, params, deps));
}
