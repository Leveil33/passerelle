// Qui est connecté, et dans quel(s) commerce(s) ? (côté serveur, pour les pages de l'appli commerçant)
import "server-only";
import { createClient } from "@/lib/supabase/server";

export type Membership = { merchantId: string; merchantName: string; role: "owner" | "staff" };
export type StaffSession = { userId: string; email: string | null; memberships: Membership[] };

/** Renvoie null si personne n'est connecté. Une personne connectée sans commerce a une liste vide. */
export async function getStaffSession(): Promise<StaffSession | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;

  const { data: links } = await supabase.from("merchant_users").select("merchant_id, role").eq("user_id", data.user.id);
  const ids = (links ?? []).map((l) => l.merchant_id as string);
  const { data: merchants } = ids.length > 0 ? await supabase.from("merchants").select("id, name").in("id", ids) : { data: [] };
  const names = new Map((merchants ?? []).map((m) => [m.id as string, m.name as string]));

  return {
    userId: data.user.id,
    email: data.user.email ?? null,
    memberships: (links ?? []).map((l) => ({
      merchantId: l.merchant_id as string,
      merchantName: names.get(l.merchant_id as string) ?? "Commerce",
      role: l.role as "owner" | "staff",
    })),
  };
}
