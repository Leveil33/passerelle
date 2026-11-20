// Appli commerçant : lire un QR code et renvoyer l'état de la carte.
import { handleScan } from "@/lib/staff/handlers";
import { withStaff } from "@/lib/staff/deps";

export async function POST(req: Request) {
  return withStaff((deps) => handleScan(req, deps));
}
