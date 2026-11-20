// Apple Wallet : la carte à jour (exige « Authorization: ApplePass <secret de la carte> »).
import { withWalletDeps } from "@/lib/apple/deps";
import { handleGetPass } from "@/lib/apple/web-service";

export async function GET(req: Request, ctx: { params: Promise<{ passTypeId: string; serial: string }> }) {
  const params = await ctx.params;
  return withWalletDeps((deps) => handleGetPass(req, params, deps));
}
