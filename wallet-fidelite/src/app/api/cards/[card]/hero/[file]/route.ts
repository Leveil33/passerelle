// Grand visuel de la carte Google (tampons), téléchargé par Google.
import { withStoreDeps } from "@/lib/apple/deps";
import { handleHeroImage } from "@/lib/google/web-service";

export async function GET(req: Request, ctx: { params: Promise<{ card: string; file: string }> }) {
  const { card, file } = await ctx.params;
  const params = { serial: card, file };
  return withStoreDeps((deps) => handleHeroImage(req, params, deps));
}
