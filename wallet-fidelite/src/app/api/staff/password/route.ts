import { withPasswordChange } from "@/lib/admin/deps";
import { handleChangePassword } from "@/lib/admin/handlers";

export async function POST(req: Request) {
  return withPasswordChange((ctx) => handleChangePassword(req, ctx));
}
