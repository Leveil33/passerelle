// WalletStore branché sur la base de test (PGlite) : appelle EXACTEMENT les mêmes fonctions SQL
// que la vraie version (src/lib/wallet/store.ts), en tant que « serveur » (service_role).
import type { PGlite } from "@electric-sql/pglite";
import { StoreError, type WalletStore } from "@/lib/wallet/store";
import { normalizeTimestamp } from "@/lib/wallet/timestamps";
import { parsePassData } from "@/lib/wallet/types";
import { asServer } from "../db/helpers";

export function createPgliteWalletStore(db: PGlite): WalletStore {
  async function query<T extends object>(sql: string, params: unknown[]): Promise<T[]> {
    try {
      return (await asServer(db, () => db.query<T>(sql, params))).rows;
    } catch (e) {
      const err = e as { message: string; code?: string; detail?: string };
      throw new StoreError(err.message, err.code, err.detail);
    }
  }
  const scalar = async <T>(sql: string, params: unknown[]) => Object.values((await query<object>(sql, params))[0])[0] as T;

  return {
    rateLimit: (key, windowSeconds, max) => scalar<boolean>("select public.rate_limit_hit($1, $2, $3)", [key, windowSeconds, max]),

    async passData(serial) {
      const raw = await scalar<unknown>("select public.loyalty_pass_data($1)", [serial]);
      if (!raw) return null;
      const data = parsePassData(raw);
      return { ...data, card: { ...data.card, updated_at: normalizeTimestamp(data.card.updated_at)! } };
    },

    register: (serial, token, device, push) =>
      scalar("select public.apple_register_device($1, $2, $3, $4)", [serial, token, device, push]),
    unregister: (serial, token, device) => scalar("select public.apple_unregister_device($1, $2, $3)", [serial, token, device]),

    async updatedSerials(device, since) {
      const rows = await query<{ serial_number: string; updated_at: string }>(
        "select serial_number, updated_at::text as updated_at from public.apple_updated_serials($1, $2::timestamptz)",
        [device, since],
      );
      return rows.map((r) => ({ serialNumber: r.serial_number, updatedAt: normalizeTimestamp(r.updated_at)! }));
    },

    async pushTargets(serial) {
      const rows = await query<{ device_library_id: string; push_token: string }>("select * from public.apple_push_targets($1)", [serial]);
      return rows.map((r) => ({ deviceLibraryId: r.device_library_id, pushToken: r.push_token }));
    },

    forgetPushToken: (token) => scalar<number>("select public.apple_forget_push_token($1)", [token]),

    async createCard(input) {
      const data = await scalar<{ card_id: string; serial_number: string }>("select public.create_card($1, $2, $3, $4, $5)", [
        input.programId,
        input.firstName,
        input.email ?? null,
        input.emailConsent ?? false,
        input.marketingConsent ?? false,
      ]);
      return { cardId: data.card_id, serialNumber: data.serial_number };
    },
  };
}
