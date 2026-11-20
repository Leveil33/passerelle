// Client minimal de l'API Google Wallet (cartes de fidélité).
// Adresses et portée d'accès : voir https://developers.google.com/wallet/retail/loyalty-cards/getting-started/auth/rest

import type { TokenProvider } from "./auth";

export const WALLET_API_BASE = "https://walletobjects.googleapis.com/walletobjects/v1";

export class GoogleApiError extends Error {
  constructor(message: string, readonly status: number, readonly reason?: string) {
    super(message);
  }
}

export type Json = Record<string, unknown>;
export type InsertResult = "created" | "exists";

export type WalletApi = ReturnType<typeof createWalletApi>;

export function createWalletApi(opts: { getToken: TokenProvider; baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number }) {
  const base = opts.baseUrl ?? WALLET_API_BASE;
  const doFetch = opts.fetch ?? fetch;

  async function request(method: "POST" | "PATCH" | "GET", path: string, body?: Json): Promise<{ status: number; body: Json }> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${await opts.getToken()}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
    } catch (e) {
      if (e instanceof GoogleApiError) throw e;
      throw new GoogleApiError(`Connexion à Google Wallet impossible : ${(e as Error).message}`, 0);
    }
    const parsed = (await res.json().catch(() => ({}))) as Json & { error?: { message?: string; errors?: { reason?: string }[] } };
    if (!res.ok) {
      const reason = parsed.error?.errors?.[0]?.reason;
      throw new GoogleApiError(`Google Wallet a répondu ${res.status}${parsed.error?.message ? ` : ${parsed.error.message}` : ""}`, res.status, reason);
    }
    return { status: res.status, body: parsed };
  }

  /** Crée si absent ; « exists » si l'identifiant est déjà pris (HTTP 409). */
  async function insert(path: string, body: Json): Promise<InsertResult> {
    try {
      await request("POST", path, body);
      return "created";
    } catch (e) {
      if (e instanceof GoogleApiError && e.status === 409) return "exists";
      throw e;
    }
  }

  const enc = encodeURIComponent;
  return {
    insertClass: (body: Json) => insert("/loyaltyClass", body),
    patchClass: async (id: string, body: Json) => void (await request("PATCH", `/loyaltyClass/${enc(id)}`, body)),
    insertObject: (body: Json) => insert("/loyaltyObject", body),
    patchObject: async (id: string, body: Json) => void (await request("PATCH", `/loyaltyObject/${enc(id)}`, body)),
    addMessage: async (id: string, message: Json) => void (await request("POST", `/loyaltyObject/${enc(id)}/addMessage`, { message })),
    getObject: async (id: string) => (await request("GET", `/loyaltyObject/${enc(id)}`)).body,
  };
}
