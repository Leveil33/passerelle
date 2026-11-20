import { withOwner } from "@/lib/admin/deps";
import { handleUpdateMerchant } from "@/lib/admin/handlers";

export async function PATCH(req: Request) {
  return withOwner((deps) => handleUpdateMerchant(req, deps));
}
