// Branchement de Google Wallet sur la vraie configuration (côté serveur uniquement).
import "server-only";
import { getWalletStore } from "@/lib/apple/deps";
import type { StoreDeps } from "@/lib/apple/web-service";
import { getQrSecret } from "@/lib/loyalty/qr";
import { json } from "@/lib/wallet/http";
import { createWalletApi } from "./api";
import { createTokenProvider, type TokenProvider } from "./auth";
import { getGoogleConfig } from "./config";
import type { GoogleDeps } from "./service";

// Un seul fournisseur de jeton par instance du serveur : le jeton est réutilisé d'une requête à l'autre.
let tokens: { key: string; provider: TokenProvider } | null = null;

export function getGoogleDeps(): GoogleDeps {
  const config = getGoogleConfig();
  const key = `${config.serviceAccountEmail}:${config.privateKey.length}`;
  if (!tokens || tokens.key !== key) {
    tokens = { key, provider: createTokenProvider({ email: config.serviceAccountEmail, privateKey: config.privateKey }) };
  }
  return {
    api: createWalletApi({ getToken: tokens.provider }),
    config,
    qrSecret: getQrSecret(),
    store: getWalletStore(),
  };
}

/** Exécute un traitement qui a besoin de Google ; une configuration incomplète donne un 503 (détail dans les journaux). */
export async function withGoogleDeps(run: (deps: StoreDeps & { google: GoogleDeps }) => Promise<Response>): Promise<Response> {
  let deps: StoreDeps & { google: GoogleDeps };
  try {
    const google = getGoogleDeps();
    deps = { store: google.store, google };
  } catch (e) {
    console.error("Configuration de Google Wallet incomplète :", (e as Error).message);
    return json({ error: "Service momentanément indisponible." }, 503);
  }
  try {
    return await run(deps);
  } catch (e) {
    console.error("Erreur inattendue :", (e as Error).message);
    return json({ error: "Une erreur est survenue." }, 500);
  }
}
