// « La carte de ce client vient de changer » : prévient ses iPhone, et oublie ceux qui n'existent plus.
import type { WalletStore } from "@/lib/wallet/store";
import type { AppleConfig } from "./config";
import { sendPassUpdatePushes, type PushOptions, type PushResult } from "./push";

export type NotifyDeps = {
  store: WalletStore;
  config: Pick<AppleConfig, "passTypeId" | "certs">;
  /** Adresse d'APNs (valeur par défaut : les serveurs d'Apple). */
  host?: string;
  ca?: Buffer;
  timeoutMs?: number;
  sender?: (tokens: string[], opts: PushOptions) => Promise<PushResult[]>;
};

export type NotifySummary = { targets: number; sent: number; removed: number; failed: number };

/**
 * À appeler après chaque changement d'une carte. Ne lève jamais d'erreur à cause d'Apple : un signal raté
 * n'est pas grave (l'iPhone verra la carte à jour dès qu'il rafraîchit son Wallet) et ne doit jamais faire
 * échouer un tampon.
 */
export async function notifyCardUpdated(serial: string, deps: NotifyDeps): Promise<NotifySummary> {
  const targets = await deps.store.pushTargets(serial);
  if (targets.length === 0) return { targets: 0, sent: 0, removed: 0, failed: 0 };

  const send = deps.sender ?? sendPassUpdatePushes;
  const results = await send(
    targets.map((t) => t.pushToken),
    {
      passTypeId: deps.config.passTypeId,
      cert: deps.config.certs.signerCert,
      key: deps.config.certs.signerKey,
      passphrase: deps.config.certs.signerKeyPassphrase,
      host: deps.host,
      ca: deps.ca,
      timeoutMs: deps.timeoutMs,
    },
  );

  let removed = 0;
  for (const r of results) {
    if (r.invalid) removed += await deps.store.forgetPushToken(r.token);
  }
  const sent = results.filter((r) => r.status === 200).length;
  return { targets: targets.length, sent, removed, failed: results.length - sent - results.filter((r) => r.invalid).length };
}
