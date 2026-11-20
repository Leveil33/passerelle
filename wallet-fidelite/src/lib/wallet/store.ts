// Accès aux données du Wallet côté serveur : de simples appels aux fonctions SQL (réservées au
// serveur) déjà testées dans tests/db. Toute la logique est dans la base ; ici, uniquement le transport.
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeTimestamp } from "./timestamps";
import { parseClassData, parsePassData, type ClassData, type PassData } from "./types";

export type RegisterResult = "created" | "exists" | "unauthorized" | "not_found" | "invalid";
export type UnregisterResult = "ok" | "unauthorized" | "not_found";

export type CreateCardInput = {
  programId: string;
  firstName: string;
  email?: string | null;
  emailConsent?: boolean;
  marketingConsent?: boolean;
};

export interface WalletStore {
  /** true = appel autorisé, false = trop de requêtes. */
  rateLimit(key: string, windowSeconds: number, max: number): Promise<boolean>;
  passData(serial: string): Promise<PassData | null>;
  register(serial: string, authToken: string, deviceLibraryId: string, pushToken: string): Promise<RegisterResult>;
  unregister(serial: string, authToken: string, deviceLibraryId: string): Promise<UnregisterResult>;
  /** Cartes de l'appareil modifiées depuis `since` (repère de notre format), la plus ancienne d'abord. */
  updatedSerials(deviceLibraryId: string, since: string | null): Promise<{ serialNumber: string; updatedAt: string }[]>;
  pushTargets(serial: string): Promise<{ deviceLibraryId: string; pushToken: string }[]>;
  forgetPushToken(pushToken: string): Promise<number>;
  createCard(input: CreateCardInput): Promise<{ cardId: string; serialNumber: string }>;
  /** Description d'un programme pour Google, ou null s'il n'existe pas. */
  classData(programId: string): Promise<ClassData | null>;
  /** Budget de notifications Google : true = autorisée (et comptée). */
  claimNotification(serial: string, kind: "stamp" | "reward"): Promise<boolean>;
  markGoogle(serial: string, objectId: string): Promise<"ok" | "not_found" | "invalid" | "conflict">;
  /** Jetons de notification Apple de toutes les cartes d'un programme. */
  programPushTokens(programId: string, limit: number): Promise<string[]>;
  /** Numéros de série des cartes Google d'un programme. */
  programGoogleSerials(programId: string, limit: number): Promise<string[]>;
}

/** Refus renvoyé par la base (message = code lisible par le programme, ex. « program_inactive »). */
export class StoreError extends Error {
  constructor(message: string, readonly code?: string, readonly details?: string | null) {
    super(message);
  }
}

type Rpc = Pick<SupabaseClient, "rpc">;

export function createSupabaseWalletStore(client: Rpc): WalletStore {
  async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new StoreError(error.message, error.code, error.details);
    return data as T;
  }

  return {
    rateLimit: (key, windowSeconds, max) =>
      call<boolean>("rate_limit_hit", { p_key: key, p_window_seconds: windowSeconds, p_max: max }),

    async passData(serial) {
      const data = await call<unknown>("loyalty_pass_data", { p_serial: serial });
      if (data === null || data === undefined) return null;
      const parsed = parsePassData(data);
      const updatedAt = normalizeTimestamp(parsed.card.updated_at);
      if (!updatedAt) throw new Error("Date de mise à jour de la carte illisible.");
      return { ...parsed, card: { ...parsed.card, updated_at: updatedAt } };
    },

    register: (serial, authToken, deviceLibraryId, pushToken) =>
      call<RegisterResult>("apple_register_device", {
        p_serial: serial,
        p_auth_token: authToken,
        p_device_library_id: deviceLibraryId,
        p_push_token: pushToken,
      }),

    unregister: (serial, authToken, deviceLibraryId) =>
      call<UnregisterResult>("apple_unregister_device", {
        p_serial: serial,
        p_auth_token: authToken,
        p_device_library_id: deviceLibraryId,
      }),

    async updatedSerials(deviceLibraryId, since) {
      const rows = await call<{ serial_number: string; updated_at: string }[]>("apple_updated_serials", {
        p_device_library_id: deviceLibraryId,
        p_since: since,
      });
      return (rows ?? []).map((r) => {
        const updatedAt = normalizeTimestamp(r.updated_at);
        if (!updatedAt) throw new Error("Date de mise à jour de la carte illisible.");
        return { serialNumber: r.serial_number, updatedAt };
      });
    },

    async pushTargets(serial) {
      const rows = await call<{ device_library_id: string; push_token: string }[]>("apple_push_targets", { p_serial: serial });
      return (rows ?? []).map((r) => ({ deviceLibraryId: r.device_library_id, pushToken: r.push_token }));
    },

    forgetPushToken: (pushToken) => call<number>("apple_forget_push_token", { p_push_token: pushToken }),

    async createCard(input) {
      const data = await call<{ card_id: string; serial_number: string }>("create_card", {
        p_program_id: input.programId,
        p_first_name: input.firstName,
        p_email: input.email ?? null,
        p_email_consent: input.emailConsent ?? false,
        p_marketing_consent: input.marketingConsent ?? false,
      });
      return { cardId: data.card_id, serialNumber: data.serial_number };
    },

    async classData(programId) {
      const data = await call<unknown>("loyalty_class_data", { p_program_id: programId });
      return data === null || data === undefined ? null : parseClassData(data);
    },

    claimNotification: (serial, kind) => call<boolean>("google_claim_notification", { p_serial: serial, p_kind: kind }),

    markGoogle: (serial, objectId) =>
      call<"ok" | "not_found" | "invalid" | "conflict">("google_mark_card", { p_serial: serial, p_object_id: objectId }),

    async programPushTokens(programId, limit) {
      const rows = await call<{ push_token: string }[]>("program_push_targets", { p_program_id: programId, p_limit: limit });
      return (rows ?? []).map((r) => r.push_token);
    },

    async programGoogleSerials(programId, limit) {
      const rows = await call<{ serial_number: string }[]>("program_google_serials", { p_program_id: programId, p_limit: limit });
      return (rows ?? []).map((r) => r.serial_number);
    },
  };
}
