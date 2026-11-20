// Données de l'écran « Réglages de mon commerce » (lues AU NOM du propriétaire : seules ses propres données sont visibles).
import "server-only";
import { createClient } from "@/lib/supabase/server";

export type AdminData = {
  merchant: { id: string; name: string; brand_color: string; logo_url: string | null };
  program: {
    id: string; name: string; stamps_required: number; reward_label: string; proximity_message: string;
    is_active: boolean; double_scan_delay_minutes: number; stamp_icon: string; stamp_icon_url: string | null;
  } | null;
  locations: { id: string; label: string; address: string; latitude: number; longitude: number }[];
  stats: { cards: number; new_cards_7_days: number; stamps_today: number; stamps_7_days: number; rewards_redeemed: number; rewards_redeemed_7_days: number } | null;
};

/** Commerce dont l'utilisateur est propriétaire (le premier s'il en a plusieurs), ou null. */
export async function loadAdminData(userId: string): Promise<AdminData | null> {
  const supabase = await createClient();
  const { data: owned } = await supabase.from("merchant_users").select("merchant_id").eq("user_id", userId).eq("role", "owner").order("created_at", { ascending: true }).limit(1);
  const merchantId = owned?.[0]?.merchant_id as string | undefined;
  if (!merchantId) return null;

  const [merchant, programs, locations, stats] = await Promise.all([
    supabase.from("merchants").select("id, name, brand_color, logo_url").eq("id", merchantId).maybeSingle(),
    supabase.from("loyalty_programs")
      .select("id, name, stamps_required, reward_label, proximity_message, is_active, double_scan_delay_minutes, stamp_icon, stamp_icon_url")
      .eq("merchant_id", merchantId).order("created_at", { ascending: true }).limit(1),
    supabase.from("locations").select("id, label, address, latitude, longitude").eq("merchant_id", merchantId).order("created_at", { ascending: true }),
    supabase.rpc("merchant_stats", { p_merchant_id: merchantId }),
  ]);
  if (!merchant.data) return null;
  return {
    merchant: merchant.data as AdminData["merchant"],
    program: (programs.data?.[0] as AdminData["program"]) ?? null,
    locations: (locations.data ?? []) as AdminData["locations"],
    stats: (stats.data as AdminData["stats"]) ?? null,
  };
}
