// StaffStore branché sur Supabase, avec la session de l'employé (jamais la clé secrète).
import type { SupabaseClient } from "@supabase/supabase-js";
import { StoreError } from "@/lib/wallet/store";
import { normalizeTimestamp } from "@/lib/wallet/timestamps";
import type { CardAction } from "./types";
import type { CardRow, LastEvent, ProgramRow, StaffStore } from "./handlers";

const RPC: Record<CardAction, string> = { stamp: "stamp_card", redeem: "redeem_reward", undo: "undo_last_stamp" };
const CARD_COLUMNS = "id, serial_number, customer_id, program_id, stamps, rewards_earned";

export function createSupabaseStaffStore(client: Pick<SupabaseClient, "from" | "rpc">): StaffStore {
  // Lectures simples, une table à la fois (pas de jointure : plus facile à vérifier et à tester).
  async function one<T>(query: PromiseLike<{ data: T | null; error: { message: string; code?: string; details?: string } | null }>): Promise<T | null> {
    const { data, error } = await query;
    if (error) throw new Error(`Lecture impossible : ${error.message}`);
    return data;
  }

  return {
    cardBySerial: (serial) => one<CardRow>(client.from("cards").select(CARD_COLUMNS).eq("serial_number", serial).maybeSingle()),
    cardById: (cardId) => one<CardRow>(client.from("cards").select(CARD_COLUMNS).eq("id", cardId).maybeSingle()),

    async customerName(customerId) {
      return (await one<{ first_name: string }>(client.from("customers").select("first_name").eq("id", customerId).maybeSingle()))?.first_name ?? null;
    },

    program: (programId) =>
      one<ProgramRow>(
        client.from("loyalty_programs").select("name, stamps_required, reward_label, is_active, double_scan_delay_minutes").eq("id", programId).maybeSingle(),
      ),

    async lastEvent(cardId) {
      const row = await one<{ type: LastEvent["type"]; created_at: string }>(
        client.from("stamp_events").select("type, created_at").eq("card_id", cardId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      );
      const createdAt = row ? normalizeTimestamp(row.created_at) : null;
      return row && createdAt ? { type: row.type, createdAt } : null;
    },

    async perform(action, cardId) {
      const { error } = await client.rpc(RPC[action], { p_card_id: cardId });
      if (error) throw new StoreError(error.message, error.code, error.details);
    },
  };
}
