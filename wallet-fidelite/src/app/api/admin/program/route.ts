import { withOwner } from "@/lib/admin/deps";
import { handleUpdateProgram } from "@/lib/admin/handlers";

export async function PATCH(req: Request) {
  return withOwner((deps) => handleUpdateProgram(req, deps));
}
