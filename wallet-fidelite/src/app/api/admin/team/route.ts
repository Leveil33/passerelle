import { withOwner } from "@/lib/admin/deps";
import { handleAddMember, handleListTeam, handleRemoveMember } from "@/lib/admin/handlers";

export async function GET(req: Request) {
  return withOwner((deps) => handleListTeam(req, deps));
}
export async function POST(req: Request) {
  return withOwner((deps) => handleAddMember(req, deps));
}
export async function DELETE(req: Request) {
  return withOwner((deps) => handleRemoveMember(req, deps));
}
