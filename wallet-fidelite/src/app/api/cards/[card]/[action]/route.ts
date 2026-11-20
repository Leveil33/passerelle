// Appli commerçant : +1 tampon (stamp), valider la récompense (redeem), annuler le dernier tampon (undo).
import { handleAction } from "@/lib/staff/handlers";
import { withStaff } from "@/lib/staff/deps";

export async function POST(req: Request, ctx: { params: Promise<{ card: string; action: string }> }) {
  const { card: id, action } = await ctx.params;
  return withStaff((deps) => handleAction(req, { cardId: id, action }, deps));
}
