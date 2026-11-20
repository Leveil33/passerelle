// Réglages Google Wallet, lus dans les variables d'environnement (voir .env.example).
import { getAppUrl } from "@/lib/apple/config";

export class GoogleConfigError extends Error {}

type Env = Record<string, string | undefined>;

export type GoogleConfig = {
  /** Identifiant de l'émetteur (Google Pay & Wallet Console) : un long nombre. */
  issuerId: string;
  /** Adresse e-mail du compte de service Google Cloud. */
  serviceAccountEmail: string;
  /** Clé privée du compte de service (PEM). */
  privateKey: string;
  /** Adresse publique du site (https), utilisée dans le lien et pour les images. */
  appUrl: string;
};

export function getGoogleConfig(env: Env = process.env): GoogleConfig {
  const missing: string[] = [];
  const need = (name: string) => {
    const v = env[name]?.trim();
    if (!v) missing.push(name);
    return v ?? "";
  };

  const issuerId = need("GOOGLE_WALLET_ISSUER_ID");
  const serviceAccountEmail = need("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  // Dans un fichier .env ou un réglage Vercel, les retours à la ligne s'écrivent souvent « \n » : on les rétablit.
  const privateKey = need("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY").replace(/\\n/g, "\n");
  let appUrl = "";
  try {
    appUrl = getAppUrl(env);
  } catch (e) {
    if (env.NEXT_PUBLIC_APP_URL?.trim()) throw new GoogleConfigError((e as Error).message);
    missing.push("NEXT_PUBLIC_APP_URL");
  }
  if (missing.length > 0) {
    throw new GoogleConfigError(`Réglages Google Wallet incomplets, variables manquantes : ${missing.join(", ")} (voir .env.example).`);
  }

  if (!/^\d+$/.test(issuerId)) throw new GoogleConfigError("GOOGLE_WALLET_ISSUER_ID doit être un nombre (ID émetteur de la console Google).");
  if (!serviceAccountEmail.includes("@")) throw new GoogleConfigError("GOOGLE_SERVICE_ACCOUNT_EMAIL n'est pas une adresse e-mail.");
  if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(privateKey)) {
    throw new GoogleConfigError("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY n'est pas une clé privée PEM (champ « private_key » du fichier JSON).");
  }
  return { issuerId, serviceAccountEmail, privateKey, appUrl };
}
