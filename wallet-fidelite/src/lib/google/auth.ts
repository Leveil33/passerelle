// Authentification auprès de Google avec le compte de service (flux « JWT bearer »), et signature RS256.
// Écrit à la main (quelques lignes de crypto standard) pour pouvoir le tester contre un faux serveur Google.
import { createSign } from "node:crypto";

export const WALLET_SCOPE = "https://www.googleapis.com/auth/wallet_object.issuer";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";

export class GoogleAuthError extends Error {}

export const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

/** JWT signé en RS256 avec la clé privée du compte de service. */
export function signJwt(claims: Record<string, unknown>, privateKey: string): string {
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey);
  return `${unsigned}.${b64url(signature)}`;
}

export type TokenProvider = () => Promise<string>;

export type TokenOptions = {
  email: string;
  privateKey: string;
  fetch?: typeof fetch;
  tokenUrl?: string;
  now?: () => Date;
};

/** Fournit un jeton d'accès, réutilisé tant qu'il est valable (et partagé entre appels simultanés). */
export function createTokenProvider(opts: TokenOptions): TokenProvider {
  const doFetch = opts.fetch ?? fetch;
  const tokenUrl = opts.tokenUrl ?? TOKEN_URL;
  const now = opts.now ?? (() => new Date());
  let cached: { token: string; expiresAt: number } | null = null;
  let inFlight: Promise<string> | null = null;

  async function fetchToken(): Promise<string> {
    const iat = Math.floor(now().getTime() / 1000);
    const assertion = signJwt({ iss: opts.email, scope: WALLET_SCOPE, aud: tokenUrl, iat, exp: iat + 3600 }, opts.privateKey);
    let res: Response;
    try {
      res = await doFetch(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new GoogleAuthError(`Connexion à Google impossible : ${(e as Error).message}`);
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) {
      // On rapporte le code d'erreur de Google, jamais la clé ni l'assertion.
      throw new GoogleAuthError(`Google a refusé le compte de service (HTTP ${res.status}${body.error ? `, ${body.error}` : ""}).`);
    }
    cached = { token: body.access_token, expiresAt: now().getTime() + Math.max(60, (body.expires_in ?? 3600) - 60) * 1000 };
    return body.access_token;
  }

  return async () => {
    if (cached && now().getTime() < cached.expiresAt) return cached.token;
    inFlight ??= fetchToken().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
