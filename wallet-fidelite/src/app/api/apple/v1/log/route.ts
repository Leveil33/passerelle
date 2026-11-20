// Apple Wallet : journaux envoyés par l'iPhone.
import { withStoreDeps } from "@/lib/apple/deps";
import { handleLog } from "@/lib/apple/web-service";

export async function POST(req: Request) {
  return withStoreDeps((deps) => handleLog(req, deps));
}
