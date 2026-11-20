// Création d'une carte de fidélité (appelée par la page d'inscription du client).
import { withStoreDeps } from "@/lib/apple/deps";
import { handleCreateCard } from "@/lib/apple/web-service";

export async function POST(req: Request) {
  return withStoreDeps((deps) => handleCreateCard(req, deps));
}
