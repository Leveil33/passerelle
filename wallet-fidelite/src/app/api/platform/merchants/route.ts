// Réservé à la propriétaire de la solution : liste et création des commerces.
import { withPlatform } from "@/lib/admin/deps";
import { handleCreateMerchant, handleListMerchants } from "@/lib/admin/handlers";

export async function GET() {
  return withPlatform((deps) => handleListMerchants(deps));
}
export async function POST(req: Request) {
  return withPlatform((deps) => handleCreateMerchant(req, deps));
}
