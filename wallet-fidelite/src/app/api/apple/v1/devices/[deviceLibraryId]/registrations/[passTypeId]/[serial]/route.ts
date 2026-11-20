// Apple Wallet : enregistrer (POST) / désinscrire (DELETE) un iPhone pour une carte.
import { withWalletDeps } from "@/lib/apple/deps";
import { handleRegister, handleUnregister } from "@/lib/apple/web-service";

type Ctx = { params: Promise<{ deviceLibraryId: string; passTypeId: string; serial: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const params = await ctx.params;
  return withWalletDeps((deps) => handleRegister(req, params, deps));
}

export async function DELETE(req: Request, ctx: Ctx) {
  const params = await ctx.params;
  return withWalletDeps((deps) => handleUnregister(req, params, deps));
}
