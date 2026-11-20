// Télécharger la carte pour l'ajouter à Apple Wallet.
import { withWalletDeps } from "@/lib/apple/deps";
import { handleDownloadPass } from "@/lib/apple/web-service";

export async function GET(req: Request, ctx: { params: Promise<{ serial: string }> }) {
  const params = await ctx.params;
  return withWalletDeps((deps) => handleDownloadPass(req, params, deps));
}
