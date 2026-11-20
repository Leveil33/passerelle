// StaffStore branché sur la base de test (PGlite), AU NOM d'un employé : mêmes requêtes que la vraie version
// (src/lib/staff/supabase-store.ts), exécutées avec le rôle « authenticated » → les vraies règles de sécurité s'appliquent.
import type { PGlite } from "@electric-sql/pglite";
import type { CardRow, LastEvent, ProgramRow, StaffStore } from "@/lib/staff/handlers";
import { StoreError } from "@/lib/wallet/store";
import { normalizeTimestamp } from "@/lib/wallet/timestamps";
import { asUser } from "../db/helpers";

const FN = { stamp: "stamp_card", redeem: "redeem_reward", undo: "undo_last_stamp" } as const;
const CARD = "id, serial_number, customer_id, program_id, stamps, rewards_earned";

export function createPgliteStaffStore(db: PGlite, userId: string): StaffStore {
  const rows = async <T extends object>(sql: string, params: unknown[]) => (await asUser(db, userId, () => db.query<T>(sql, params))).rows;
  const first = async <T extends object>(sql: string, params: unknown[]) => (await rows<T>(sql, params))[0] ?? null;

  return {
    cardBySerial: (serial) => first<CardRow>(`select ${CARD} from public.cards where serial_number = $1`, [serial]),
    cardById: (id) => first<CardRow>(`select ${CARD} from public.cards where id = $1`, [id]),
    async customerName(id) {
      return (await first<{ first_name: string }>("select first_name from public.customers where id = $1", [id]))?.first_name ?? null;
    },
    program: (id) =>
      first<ProgramRow>("select name, stamps_required, reward_label, is_active, double_scan_delay_minutes from public.loyalty_programs where id = $1", [id]),
    async lastEvent(cardId) {
      const row = await first<{ type: LastEvent["type"]; created_at: string }>(
        "select type, created_at::text as created_at from public.stamp_events where card_id = $1 order by created_at desc, id desc limit 1",
        [cardId],
      );
      return row ? { type: row.type, createdAt: normalizeTimestamp(row.created_at)! } : null;
    },
    async perform(action, cardId) {
      try {
        await asUser(db, userId, () => db.query(`select * from public.${FN[action]}($1)`, [cardId]));
      } catch (e) {
        const err = e as { message: string; code?: string; detail?: string };
        throw new StoreError(err.message, err.code, err.detail);
      }
    },
  };
}
