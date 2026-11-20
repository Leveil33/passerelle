// Apple Wallet : liste des cartes d'un iPhone modifiées depuis le repère `passesUpdatedSince`.
import { withWalletDeps } from "@/lib/apple/deps";
import { handleListUpdates } from "@/lib/apple/web-service";

export async function GET(req: Request, ctx: { params: Promise<{ deviceLibraryId: string; passTypeId: string }> }) {
  const params = await ctx.params;
  return withWalletDeps((deps) => handleListUpdates(req, params, deps));
}
