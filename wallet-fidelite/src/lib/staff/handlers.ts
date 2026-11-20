// Adresses de l'appli du commerçant : scanner une carte, +1 tampon, valider la récompense, annuler.
//
// Tout se fait « au nom de l'employé connecté » : les droits sont vérifiés par la base elle-même
// (règles de sécurité + fonctions stamp_card / redeem_reward / undo_last_stamp), pas par ce code.
import { parseLoyaltyError } from "@/lib/loyalty/errors";
import { verifyQrPayload } from "@/lib/loyalty/qr";
import { json, readJson } from "@/lib/wallet/http";
import { StoreError } from "@/lib/wallet/store";
import { UNDO_WINDOW_SECONDS, type ApiError, type CardAction, type CardState } from "./types";

export type CardRow = {
  id: string;
  serial_number: string;
  customer_id: string;
  program_id: string;
  stamps: number;
  rewards_earned: number;
};
export type ProgramRow = {
  name: string;
  stamps_required: number;
  reward_label: string;
  is_active: boolean;
  double_scan_delay_minutes: number;
};
export type LastEvent = { type: "stamp" | "reward_redeemed" | "correction"; createdAt: string };

/** Accès aux données AU NOM de l'employé connecté (la base applique ses droits). */
export interface StaffStore {
  cardBySerial(serial: string): Promise<CardRow | null>;
  cardById(cardId: string): Promise<CardRow | null>;
  customerName(customerId: string): Promise<string | null>;
  program(programId: string): Promise<ProgramRow | null>;
  lastEvent(cardId: string): Promise<LastEvent | null>;
  /** Lèvent une StoreError dont le message est un code (« double_scan », « card_full »…). */
  perform(action: CardAction, cardId: string): Promise<void>;
}

export type StaffDeps = {
  staff: StaffStore;
  qrSecret: string;
  now?: () => Date;
  /** Exécute un travail après la réponse (en production : after() de Next.js). */
  schedule?: (work: () => Promise<void>) => void;
  /** Prévient les Wallets (Apple, Google) que la carte a changé. Ne doit jamais lever d'erreur. */
  notify?: (serial: string, action: CardAction) => Promise<void>;
  log?: (message: string, meta?: unknown) => void;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS: readonly CardAction[] = ["stamp", "redeem", "undo"];

const fail = (status: number, code: string, error: string, extra: Partial<ApiError> = {}) => json({ error, code, ...extra } satisfies ApiError, status);
const logger = (deps: StaffDeps) => deps.log ?? ((m: string, meta?: unknown) => console.error(m, meta ?? ""));

/**
 * Protections des adresses qui modifient des données avec le cookie de session :
 * contenu JSON obligatoire et requête venant de notre propre site (contre les requêtes forgées depuis un autre site).
 */
export function guardPost(req: Request): Response | null {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return fail(415, "bad_content_type", "Requête invalide.");
  }
  const origin = req.headers.get("origin");
  if (origin) {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      /* origine illisible : refusée plus bas */
    }
    if (originHost !== host) return fail(403, "bad_origin", "Requête refusée.");
  }
  return null;
}

/** Fabrique l'état d'une carte tel que l'affiche l'appli (une carte que l'employé a le droit de voir). */
export async function describeCard(card: CardRow, deps: StaffDeps): Promise<CardState | null> {
  const [name, program, last] = await Promise.all([
    deps.staff.customerName(card.customer_id),
    deps.staff.program(card.program_id),
    deps.staff.lastEvent(card.id),
  ]);
  if (!program) return null;

  const now = (deps.now ?? (() => new Date()))().getTime();
  const age = last ? Math.max(0, (now - Date.parse(last.createdAt)) / 1000) : Infinity;
  const afterStamp = last?.type === "stamp";

  return {
    cardId: card.id,
    firstName: name ?? "",
    programName: program.name,
    stamps: card.stamps,
    stampsRequired: program.stamps_required,
    rewardsEarned: card.rewards_earned,
    rewardLabel: program.reward_label,
    rewardAvailable: card.stamps >= program.stamps_required,
    programActive: program.is_active,
    undoSecondsLeft: afterStamp && card.stamps > 0 ? Math.max(0, Math.ceil(UNDO_WINDOW_SECONDS - age)) : 0,
    stampBlockedSeconds: afterStamp ? Math.max(0, Math.ceil(program.double_scan_delay_minutes * 60 - age)) : 0,
  };
}

/** POST /api/scan { code } : lit un QR code et renvoie l'état de la carte. */
export async function handleScan(req: Request, deps: StaffDeps): Promise<Response> {
  const guard = guardPost(req);
  if (guard) return guard;

  const body = await readJson(req, 2048);
  const code = body && typeof body === "object" ? (body as { code?: unknown }).code : undefined;
  if (typeof code !== "string" || code.length === 0 || code.length > 300) {
    return fail(400, "invalid_request", "Requête invalide.");
  }

  const serial = verifyQrPayload(code, deps.qrSecret);
  if (!serial) return fail(422, "invalid_qr", "Ce QR code n'est pas une carte de fidélité reconnue.");

  const card = await deps.staff.cardBySerial(serial);
  const state = card ? await describeCard(card, deps) : null;
  // Même réponse pour « carte inconnue » et « carte d'un autre commerce » : on ne révèle rien.
  if (!state) return fail(404, "card_not_found", "Carte introuvable pour votre commerce.");
  return json(state);
}

/** POST /api/cards/{id}/stamp | redeem | undo : modifie la carte, renvoie son nouvel état. */
export async function handleAction(req: Request, p: { cardId: string; action: string }, deps: StaffDeps): Promise<Response> {
  const guard = guardPost(req);
  if (guard) return guard;
  if (!UUID.test(p.cardId) || !ACTIONS.includes(p.action as CardAction)) return fail(404, "not_found", "Introuvable.");
  const action = p.action as CardAction;

  try {
    await deps.staff.perform(action, p.cardId);
  } catch (e) {
    if (!(e instanceof StoreError)) {
      logger(deps)("Action sur une carte impossible", (e as Error).message);
      return fail(500, "unknown", "Une erreur est survenue. Réessayez dans un instant.");
    }
    const err = parseLoyaltyError({ message: e.message, details: e.details });
    if (err.code === "unknown") logger(deps)("Refus inattendu de la base", e.message);
    return fail(err.status, err.code, err.message, err.retryAfterSeconds ? { retryAfterSeconds: err.retryAfterSeconds } : {});
  }

  // L'action a réussi : on relit la carte (état à jour) et on prévient les Wallets après la réponse.
  const card = await deps.staff.cardById(p.cardId);
  const state = card ? await describeCard(card, deps) : null;
  if (!card || !state) return fail(500, "unknown", "L'action a été enregistrée, mais la carte n'a pas pu être relue.");

  if (deps.notify) {
    const notify = deps.notify;
    const work = async () => {
      try {
        await notify(card.serial_number, action);
      } catch (e) {
        logger(deps)("Mise à jour des Wallets impossible", (e as Error).message);
      }
    };
    if (deps.schedule) deps.schedule(work);
    else void work();
  }
  return json(state);
}
