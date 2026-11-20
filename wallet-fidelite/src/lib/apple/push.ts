// Signal « ta carte a changé » envoyé aux iPhone via APNs (service de notifications d'Apple).
//
// Règles d'Apple pour les cartes Wallet : message VIDE `{}`, même certificat que pour signer la carte,
// serveurs de production uniquement (il n'existe pas de « bac à sable » pour les cartes). Ce signal ne
// crée aucune notification visible : il dit seulement à l'iPhone de venir chercher la carte à jour ; c'est
// le texte « changeMessage » de la carte qui s'affiche ensuite.
import http2 from "node:http2";

export const APNS_HOST = "https://api.push.apple.com";

export type PushOptions = {
  passTypeId: string;
  cert: Buffer;
  key: Buffer;
  passphrase?: string;
  host?: string;
  timeoutMs?: number;
  /** Autorité de certification à utiliser pour joindre le serveur (tests seulement). */
  ca?: Buffer;
};

export type PushResult = {
  token: string;
  /** Code HTTP d'APNs, ou 0 si la requête n'a pas pu aboutir. */
  status: number;
  reason?: string;
  /** true = cet appareil n'existe plus (carte retirée du Wallet) : il faut l'oublier. */
  invalid: boolean;
  error?: string;
};

const HEX_TOKEN = /^[0-9a-fA-F]{16,200}$/;
const INVALID_REASONS = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);

export async function sendPassUpdatePushes(tokens: string[], opts: PushOptions): Promise<PushResult[]> {
  const results: PushResult[] = [];
  const valid: string[] = [];
  for (const token of tokens) {
    if (HEX_TOKEN.test(token)) valid.push(token);
    else results.push({ token, status: 0, invalid: true, error: "jeton illisible" });
  }
  if (valid.length === 0) return results;

  const timeoutMs = opts.timeoutMs ?? 10_000;
  let session: http2.ClientHttp2Session;
  try {
    session = http2.connect(opts.host ?? APNS_HOST, { cert: opts.cert, key: opts.key, passphrase: opts.passphrase, ca: opts.ca });
  } catch (e) {
    return [...results, ...valid.map((token) => ({ token, status: 0, invalid: false, error: (e as Error).message }))];
  }
  let sessionError: string | null = null;
  session.on("error", (e) => {
    sessionError = e.message;
  });

  const sendOne = (token: string) =>
    new Promise<PushResult>((resolve) => {
      const done = (r: Omit<PushResult, "token">) => resolve({ token, ...r });
      if (sessionError) return done({ status: 0, invalid: false, error: sessionError });
      let status = 0;
      let body = "";
      let finished = false;
      const finish = (r: Omit<PushResult, "token">) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        done(r);
      };
      const timer = setTimeout(() => {
        req.close(http2.constants.NGHTTP2_CANCEL);
        finish({ status: 0, invalid: false, error: "délai dépassé" });
      }, timeoutMs);

      const req = session.request({
        ":method": "POST",
        ":path": `/3/device/${token}`,
        "apns-topic": opts.passTypeId,
        "content-type": "application/json",
      });
      req.setEncoding("utf8");
      req.on("response", (headers) => {
        status = Number(headers[":status"] ?? 0);
      });
      req.on("data", (chunk: string) => {
        if (body.length < 4096) body += chunk;
      });
      req.on("end", () => {
        let reason: string | undefined;
        try {
          reason = body ? (JSON.parse(body).reason as string | undefined) : undefined;
        } catch {
          /* corps non JSON : on ignore */
        }
        finish({ status, reason, invalid: status === 410 || (reason !== undefined && INVALID_REASONS.has(reason)) });
      });
      req.on("error", (e) => finish({ status: 0, invalid: false, error: sessionError ?? e.message }));
      req.end("{}");
    });

  try {
    const sent = await Promise.all(valid.map(sendOne));
    return [...results, ...sent];
  } finally {
    session.close();
    setTimeout(() => session.destroy(), 1000).unref();
  }
}
