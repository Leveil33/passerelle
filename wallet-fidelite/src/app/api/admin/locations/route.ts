import { withOwner } from "@/lib/admin/deps";
import { handleAddLocation, handleDeleteLocation, handleUpdateLocation } from "@/lib/admin/handlers";

export async function POST(req: Request) {
  return withOwner((deps) => handleAddLocation(req, deps));
}
export async function PATCH(req: Request) {
  return withOwner((deps) => handleUpdateLocation(req, deps));
}
export async function DELETE(req: Request) {
  return withOwner((deps) => handleDeleteLocation(req, deps));
}
