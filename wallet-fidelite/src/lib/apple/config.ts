// Réglages Apple Wallet, lus dans les variables d'environnement (voir .env.example).
// Les certificats arrivent encodés en base64 sur une seule ligne (jamais de fichier dans Git).

export class AppleConfigError extends Error {}

type Env = Record<string, string | undefined>;

/** Ce dont les adresses du service Web ont besoin (sans les certificats). */
export function getPassTypeId(env: Env = process.env): string {
  const id = env.APPLE_PASS_TYPE_ID?.trim();
  if (!id) throw new AppleConfigError("APPLE_PASS_TYPE_ID manquante (voir .env.example).");
  return id;
}

export type AppleConfig = {
  passTypeId: string;
  teamId: string;
  /** Nom de l'organisation (repli si le commerce n'a pas de nom). */
  organizationName: string;
  /** Adresse de base du service Web Apple, ex. https://fidelite.exemple.fr/api/apple */
  webServiceURL: string;
  certs: { wwdr: Buffer; signerCert: Buffer; signerKey: Buffer; signerKeyPassphrase?: string };
};

function pem(env: Env, name: string, missing: string[]): Buffer {
  const raw = env[name]?.trim();
  if (!raw) {
    missing.push(name);
    return Buffer.alloc(0);
  }
  const decoded = Buffer.from(raw, "base64");
  if (!decoded.toString("utf8").includes("-----BEGIN")) {
    throw new AppleConfigError(
      `${name} n'est pas un certificat PEM encodé en base64 (voir .env.example : « base64 -w0 fichier.pem »).`,
    );
  }
  return decoded;
}

/** Adresse publique du site : https obligatoire (Apple refuse le reste), sauf localhost en développement. */
export function getAppUrl(env: Env = process.env): string {
  const raw = env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  if (!raw) throw new AppleConfigError("NEXT_PUBLIC_APP_URL manquante (adresse publique du site, voir .env.example).");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppleConfigError("NEXT_PUBLIC_APP_URL n'est pas une adresse valide.");
  }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) {
    throw new AppleConfigError("NEXT_PUBLIC_APP_URL doit commencer par https:// (Apple l'exige pour mettre les cartes à jour).");
  }
  return url.origin;
}

export function getAppleConfig(env: Env = process.env): AppleConfig {
  const missing: string[] = [];
  const need = (name: string) => {
    const v = env[name]?.trim();
    if (!v) missing.push(name);
    return v ?? "";
  };

  const passTypeId = need("APPLE_PASS_TYPE_ID");
  const teamId = need("APPLE_TEAM_ID");
  const organizationName = need("APPLE_ORGANIZATION_NAME");
  const signerCert = pem(env, "APPLE_SIGNER_CERT_BASE64", missing);
  const signerKey = pem(env, "APPLE_SIGNER_KEY_BASE64", missing);
  const wwdr = pem(env, "APPLE_WWDR_CERT_BASE64", missing);
  let appUrl = "";
  try {
    appUrl = getAppUrl(env);
  } catch (e) {
    if (e instanceof AppleConfigError && env.NEXT_PUBLIC_APP_URL?.trim()) throw e;
    missing.push("NEXT_PUBLIC_APP_URL");
  }

  if (missing.length > 0) {
    throw new AppleConfigError(`Réglages Apple Wallet incomplets, variables manquantes : ${missing.join(", ")} (voir .env.example).`);
  }

  return {
    passTypeId,
    teamId,
    organizationName,
    webServiceURL: `${appUrl}/api/apple`,
    certs: { wwdr, signerCert, signerKey, signerKeyPassphrase: env.APPLE_SIGNER_KEY_PASSPHRASE || undefined },
  };
}
