// Prévient les Wallets (Apple et Google) qu'une carte a changé. À exécuter APRÈS avoir répondu au commerçant.
import "server-only";
import { AppleConfigError, getAppleConfig } from "@/lib/apple/config";
import { getWalletStore } from "@/lib/apple/deps";
import { notifyCardUpdated } from "@/lib/apple/notify";
import { GoogleConfigError } from "@/lib/google/config";
import { getGoogleDeps } from "@/lib/google/deps";
import { notifyGoogleCardUpdated } from "@/lib/google/service";
import type { CardAction } from "@/lib/staff/types";

/** Ne lève jamais d'erreur : un Wallet en panne ou non configuré ne doit jamais faire échouer un tampon. */
export async function notifyWallets(serial: string, action: CardAction): Promise<void> {
  try {
    await notifyCardUpdated(serial, {
      store: getWalletStore(),
      config: getAppleConfig(),
      host: process.env.APPLE_APNS_HOST || undefined,
    });
  } catch (e) {
    if (!(e instanceof AppleConfigError)) console.error("Apple Wallet : mise à jour impossible :", (e as Error).message);
  }

  try {
    const summary = await notifyGoogleCardUpdated(serial, action, getGoogleDeps());
    if (summary.reason === "error" || summary.reason === "quota") console.error("Google Wallet :", summary.reason, summary.error ?? "");
  } catch (e) {
    if (!(e instanceof GoogleConfigError)) console.error("Google Wallet : mise à jour impossible :", (e as Error).message);
  }
}
