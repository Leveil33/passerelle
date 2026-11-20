// Import du logo et du tampon (fichier contrôlé et refabriqué par le serveur).
import { withOwner } from "@/lib/admin/deps";
import { handleUploadAsset } from "@/lib/admin/handlers";

export async function POST(req: Request) {
  return withOwner((deps) => handleUploadAsset(req, deps));
}
