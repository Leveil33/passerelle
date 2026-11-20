// Service Web d'Apple Wallet (PassKit) + adresses publiques des cartes.
// Chaque fonction reçoit la requête et renvoie la réponse : aucune dépendance à Next.js, donc testable.
//
// Contrat d'Apple (chemins imposés) :
//   POST   …/v1/devices/{appareil}/registrations/{passTypeId}/{série}   enregistrer un iPhone (secret requis)
//   DELETE …/v1/devices/{appareil}/registrations/{passTypeId}/{série}   le désinscrire
//   GET    …/v1/devices/{appareil}/registrations/{passTypeId}?passesUpdatedSince=…   cartes modifiées
//   GET    …/v1/passes/{passTypeId}/{série}                              la carte à jour (secret requis)
//   POST   …/v1/log                                                      journaux envoyés par l'iPhone
import { isNotModified, lastModifiedFor } from "@/lib/wallet/http-dates";
import { applePassToken, clientIp, json, readJson, safeEqual } from "@/lib/wallet/http";
import { StoreError, type WalletStore } from "@/lib/wallet/store";
import { parseTag } from "@/lib/wallet/timestamps";
import type { PassData } from "@/lib/wallet/types";

export type RateLimits = {
  /** Appels par minute et par appareil iPhone. */
  device: number;
  /** Appels par minute et par carte. */
  pass: number;
  /** Appels par minute et par adresse IP pour les journaux. */
  log: number;
  /** Créations de carte par minute et par adresse IP. */
  createCard: number;
};

export const DEFAULT_LIMITS: RateLimits = { device: 60, pass: 60, log: 30, createCard: 10 };

/** Ce dont a besoin une adresse qui ne touche pas à Apple (création de carte, journaux). */
export type StoreDeps = {
  store: WalletStore;
  limits?: Partial<RateLimits>;
  log?: (message: string, meta?: unknown) => void;
};

export type WebServiceDeps = StoreDeps & {
  passTypeId: string;
  buildPass: (data: PassData) => Promise<Buffer>;
  now?: () => Date;
};

const SERIAL = /^[0-9a-f]{32}$/;
const DEVICE = /^[A-Za-z0-9._-]{1,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PKPASS = "application/vnd.apple.pkpass";

const limit = (deps: StoreDeps) => ({ ...DEFAULT_LIMITS, ...deps.limits });
const logger = (deps: StoreDeps) => deps.log ?? ((m: string, meta?: unknown) => console.error(m, meta ?? ""));
const notFound = () => json({ error: "Introuvable." }, 404);
const unauthorized = () => json({ error: "Non autorisé." }, 401);

/**
 * Compte un appel. Renvoie une réponse 429 s'il y en a trop. En cas de panne du compteur : on laisse passer
 * (failOpen, pour ne jamais bloquer les cartes à cause d'une panne) ou on refuse (création de carte).
 */
async function tooMany(deps: StoreDeps, key: string, max: number, failOpen: boolean): Promise<Response | null> {
  try {
    if (await deps.store.rateLimit(key, 60, max)) return null;
    return json({ error: "Trop de requêtes, réessaie dans une minute." }, 429, { "retry-after": "60" });
  } catch (e) {
    logger(deps)("Compteur de requêtes indisponible", (e as Error).message);
    return failOpen ? null : json({ error: "Service momentanément indisponible." }, 503);
  }
}

type RegistrationParams = { deviceLibraryId: string; passTypeId: string; serial: string };

/** POST : l'iPhone s'enregistre pour suivre une carte. */
export async function handleRegister(req: Request, p: RegistrationParams, deps: WebServiceDeps): Promise<Response> {
  if (p.passTypeId !== deps.passTypeId || !SERIAL.test(p.serial)) return notFound();
  if (!DEVICE.test(p.deviceLibraryId)) return json({ error: "Appareil invalide." }, 400);
  const token = applePassToken(req);
  if (!token) return unauthorized();

  const limited = await tooMany(deps, `apple:device:${p.deviceLibraryId}`, limit(deps).device, true);
  if (limited) return limited;

  const body = await readJson(req);
  const pushToken = body && typeof body === "object" ? (body as { pushToken?: unknown }).pushToken : undefined;
  if (typeof pushToken !== "string" || pushToken.length === 0 || pushToken.length > 500) {
    return json({ error: "pushToken manquant." }, 400);
  }

  switch (await deps.store.register(p.serial, token, p.deviceLibraryId, pushToken)) {
    case "created":
      return new Response(null, { status: 201 });
    case "exists":
      return new Response(null, { status: 200 });
    case "unauthorized":
      return unauthorized();
    case "not_found":
      return notFound();
    default:
      return json({ error: "Requête invalide." }, 400);
  }
}

/** DELETE : l'iPhone ne suit plus la carte (retirée du Wallet). */
export async function handleUnregister(req: Request, p: RegistrationParams, deps: WebServiceDeps): Promise<Response> {
  if (p.passTypeId !== deps.passTypeId || !SERIAL.test(p.serial)) return notFound();
  if (!DEVICE.test(p.deviceLibraryId)) return json({ error: "Appareil invalide." }, 400);
  const token = applePassToken(req);
  if (!token) return unauthorized();

  const limited = await tooMany(deps, `apple:device:${p.deviceLibraryId}`, limit(deps).device, true);
  if (limited) return limited;

  switch (await deps.store.unregister(p.serial, token, p.deviceLibraryId)) {
    case "ok":
      return new Response(null, { status: 200 });
    case "unauthorized":
      return unauthorized();
    default:
      return notFound();
  }
}

/** GET : quelles cartes de cet iPhone ont changé depuis le repère `passesUpdatedSince` ? */
export async function handleListUpdates(
  req: Request,
  p: { deviceLibraryId: string; passTypeId: string },
  deps: WebServiceDeps,
): Promise<Response> {
  if (p.passTypeId !== deps.passTypeId) return notFound();
  if (!DEVICE.test(p.deviceLibraryId)) return json({ error: "Appareil invalide." }, 400);

  const limited = await tooMany(deps, `apple:device:${p.deviceLibraryId}`, limit(deps).device, true);
  if (limited) return limited;

  // Un repère inconnu ou absent : on renvoie toutes les cartes de l'appareil (sans risque, juste plus long).
  const since = parseTag(new URL(req.url).searchParams.get("passesUpdatedSince"));
  const rows = await deps.store.updatedSerials(p.deviceLibraryId, since);
  if (rows.length === 0) return new Response(null, { status: 204 });
  return json({ serialNumbers: rows.map((r) => r.serialNumber), lastUpdated: rows[rows.length - 1].updatedAt });
}

function passResponse(pkpass: Buffer, extra: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(pkpass), {
    status: 200,
    headers: { "content-type": PKPASS, "cache-control": "no-cache", ...extra },
  });
}

/** GET : la carte à jour. Exige le secret de la carte ; répond 304 si l'iPhone a déjà la dernière version. */
export async function handleGetPass(
  req: Request,
  p: { passTypeId: string; serial: string },
  deps: WebServiceDeps,
): Promise<Response> {
  if (p.passTypeId !== deps.passTypeId || !SERIAL.test(p.serial)) return notFound();
  const token = applePassToken(req);
  if (!token) return unauthorized();

  const limited = await tooMany(deps, `apple:pass:${p.serial}`, limit(deps).pass, true);
  if (limited) return limited;

  const data = await deps.store.passData(p.serial);
  if (!data) return notFound();
  if (!safeEqual(token, data.card.auth_token)) return unauthorized();

  const now = (deps.now ?? (() => new Date()))();
  const modified = lastModifiedFor(data.card.updated_at, now);
  const headers: Record<string, string> = modified ? { "last-modified": modified.toUTCString() } : {};
  if (isNotModified(req.headers.get("if-modified-since"), data.card.updated_at)) {
    return new Response(null, { status: 304, headers });
  }

  try {
    return passResponse(await deps.buildPass(data), headers);
  } catch (e) {
    logger(deps)("Fabrication de la carte impossible", (e as Error).message);
    return json({ error: "Carte momentanément indisponible." }, 500);
  }
}

/** GET /api/cards/{série}/apple : télécharger la carte (le client l'ajoute à son Wallet). */
export async function handleDownloadPass(req: Request, p: { serial: string }, deps: WebServiceDeps): Promise<Response> {
  if (!SERIAL.test(p.serial)) return notFound();

  const limited = await tooMany(deps, `card:download:${clientIp(req)}:${p.serial}`, limit(deps).pass, true);
  if (limited) return limited;

  const data = await deps.store.passData(p.serial);
  if (!data) return notFound();

  try {
    return passResponse(await deps.buildPass(data), {
      "cache-control": "no-store",
      "content-disposition": 'inline; filename="carte-fidelite.pkpass"',
    });
  } catch (e) {
    logger(deps)("Fabrication de la carte impossible", (e as Error).message);
    return json({ error: "Carte momentanément indisponible." }, 500);
  }
}

/** POST : journaux d'erreurs envoyés par l'iPhone (utiles pour comprendre un problème d'ajout ou de mise à jour). */
export async function handleLog(req: Request, deps: StoreDeps): Promise<Response> {
  const limited = await tooMany(deps, `apple:log:${clientIp(req)}`, limit(deps).log, true);
  if (limited) return limited;

  const body = await readJson(req, 65_536);
  const logs = body && typeof body === "object" ? (body as { logs?: unknown }).logs : undefined;
  if (!Array.isArray(logs) || !logs.every((l) => typeof l === "string")) {
    return json({ error: "Format invalide." }, 400);
  }
  for (const line of logs.slice(0, 50)) logger(deps)("Journal Apple Wallet", line.slice(0, 2000));
  return new Response(null, { status: 200 });
}

// ─── Création d'une carte (page d'inscription du client) ────────────────────────────────────────

const CREATE_ERRORS: Record<string, { status: number; message: string }> = {
  program_not_found: { status: 404, message: "Ce programme de fidélité n'existe pas." },
  program_inactive: { status: 422, message: "Ce programme n'accepte plus de nouvelles cartes." },
  invalid_first_name: { status: 400, message: "Le prénom doit faire entre 1 et 60 caractères." },
  email_requires_consent: { status: 400, message: "Pour enregistrer ton e-mail, il faut cocher la case de consentement." },
  invalid_email: { status: 400, message: "Cette adresse e-mail n'a pas l'air valide." },
};

/** POST /api/cards : crée le client et sa carte, renvoie l'adresse pour l'ajouter au Wallet. */
export async function handleCreateCard(req: Request, deps: StoreDeps): Promise<Response> {
  const limited = await tooMany(deps, `card:create:${clientIp(req)}`, limit(deps).createCard, false);
  if (limited) return limited;

  const body = await readJson(req);
  if (!body || typeof body !== "object") return json({ error: "Requête invalide." }, 400);
  const b = body as Record<string, unknown>;
  const optionalBool = (v: unknown) => v === undefined || typeof v === "boolean";
  if (
    typeof b.programId !== "string" ||
    !UUID.test(b.programId) ||
    typeof b.firstName !== "string" ||
    (b.email !== undefined && b.email !== null && typeof b.email !== "string") ||
    !optionalBool(b.emailConsent) ||
    !optionalBool(b.marketingConsent)
  ) {
    return json({ error: "Requête invalide." }, 400);
  }

  try {
    const { serialNumber } = await deps.store.createCard({
      programId: b.programId,
      firstName: b.firstName,
      email: (b.email as string | null | undefined) ?? null,
      emailConsent: b.emailConsent as boolean | undefined,
      marketingConsent: b.marketingConsent as boolean | undefined,
    });
    return json({ serialNumber, appleUrl: `/api/cards/${serialNumber}/apple` }, 201);
  } catch (e) {
    const known = e instanceof StoreError ? CREATE_ERRORS[e.message] : undefined;
    if (known) return json({ error: known.message }, known.status);
    logger(deps)("Création de carte impossible", (e as Error).message);
    return json({ error: "Création impossible pour le moment." }, 500);
  }
}
