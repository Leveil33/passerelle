// Logo dessiné d'un programme (utilisé par Google quand le commerçant n'a pas importé de logo).
import { withStoreDeps } from "@/lib/apple/deps";
import { handleLogoImage } from "@/lib/google/web-service";

export async function GET(req: Request, ctx: { params: Promise<{ programId: string }> }) {
  const params = await ctx.params;
  return withStoreDeps((deps) => handleLogoImage(req, params, deps));
}
