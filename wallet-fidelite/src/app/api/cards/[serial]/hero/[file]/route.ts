// Grand visuel de la carte Google (tampons), téléchargé par Google.
import { withStoreDeps } from "@/lib/apple/deps";
import { handleHeroImage } from "@/lib/google/web-service";

export async function GET(req: Request, ctx: { params: Promise<{ serial: string; file: string }> }) {
  const params = await ctx.params;
  return withStoreDeps((deps) => handleHeroImage(req, params, deps));
}
