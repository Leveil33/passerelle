// Google Wallet : créer la carte d'un client, produire le lien « Ajouter », et la mettre à jour.
import type { WalletStore } from "@/lib/wallet/store";
import type { PassData } from "@/lib/wallet/types";
import { GoogleApiError, type WalletApi } from "./api";
import { buildClass, buildObject, classId, notificationMessage, objectId } from "./builders";
import type { GoogleConfig } from "./config";
import { createSaveUrl } from "./save-link";

export type GoogleDeps = {
  api: WalletApi;
  config: Pick<GoogleConfig, "issuerId" | "serviceAccountEmail" | "privateKey" | "appUrl">;
  qrSecret: string;
  store: WalletStore;
  now?: () => Date;
  newMessageId?: () => string;
};

/** Crée la classe du programme si elle n'existe pas (ne touche pas à une classe existante : voir syncClass). */
export async function ensureClass(programId: string, deps: GoogleDeps): Promise<"created" | "exists" | "unknown_program"> {
  const data = await deps.store.classData(programId);
  if (!data) return "unknown_program";
  return deps.api.insertClass(buildClass(data, deps.config));
}

/** Après un changement du commerçant (nom, couleur, logo, adresses…) : met à jour la classe, la crée si besoin. */
export async function syncClass(programId: string, deps: GoogleDeps): Promise<"updated" | "created" | "unknown_program"> {
  const data = await deps.store.classData(programId);
  if (!data) return "unknown_program";
  const body = buildClass(data, deps.config);
  if ((await deps.api.insertClass(body)) === "created") return "created";
  await deps.api.patchClass(classId(deps.config.issuerId, programId), body);
  return "updated";
}

async function ensureObject(data: PassData, deps: GoogleDeps): Promise<string> {
  const body = buildObject(data, { ...deps.config, qrSecret: deps.qrSecret });
  if ((await deps.api.insertObject(body)) === "exists") {
    await deps.api.patchObject(String(body.id), body);
  }
  return String(body.id);
}

/**
 * Lien « Ajouter à Google Wallet » d'une carte : crée (ou met à jour) la classe et la carte chez Google,
 * puis signe le lien. Renvoie null si le numéro de série est inconnu.
 */
export async function createSaveLink(serial: string, deps: GoogleDeps): Promise<string | null> {
  const data = await deps.store.passData(serial);
  if (!data) return null;

  await ensureClass(data.program.id, deps);
  const id = await ensureObject(data, deps);

  const marked = await deps.store.markGoogle(serial, id);
  if (marked === "conflict") throw new Error("La carte est déjà liée à un autre identifiant Google.");

  return createSaveUrl({
    email: deps.config.serviceAccountEmail,
    privateKey: deps.config.privateKey,
    origins: [deps.config.appUrl],
    objectIds: [id],
    now: deps.now?.(),
  });
}

/** Ce qui s'est passé lors d'une mise à jour (jamais d'exception : un échec Google ne doit pas bloquer un tampon). */
export type GoogleNotifySummary = {
  patched: boolean;
  notified: boolean;
  /** Pourquoi pas de notification : « no_google » (carte pas dans Google Wallet), « not_a_stamp », « budget », « quota », « error ». */
  reason?: "no_google" | "not_a_stamp" | "budget" | "quota" | "error";
  error?: string;
};

export type CardEvent = "stamp" | "redeem" | "undo" | "refresh";

/**
 * À appeler après chaque changement d'une carte. Met toujours la carte à jour chez Google ; n'envoie une
 * notification que pour un tampon, et dans la limite de 3 par 24 h (dont une réservée à la récompense).
 */
export async function notifyGoogleCardUpdated(serial: string, event: CardEvent, deps: GoogleDeps): Promise<GoogleNotifySummary> {
  let data: PassData | null;
  try {
    data = await deps.store.passData(serial);
  } catch (e) {
    return { patched: false, notified: false, reason: "error", error: (e as Error).message };
  }
  if (!data || (data.card.platform !== "google" && data.card.platform !== "both")) {
    return { patched: false, notified: false, reason: "no_google" };
  }

  const id = objectId(deps.config.issuerId, serial);
  let patched = false;
  try {
    const body = buildObject(data, { ...deps.config, qrSecret: deps.qrSecret });
    try {
      await deps.api.patchObject(id, body);
    } catch (e) {
      if (!(e instanceof GoogleApiError) || e.status !== 404) throw e;
      await ensureClass(data.program.id, deps);
      await deps.api.insertObject(body); // la carte n'existait pas encore chez Google
    }
    patched = true;

    if (event !== "stamp") return { patched, notified: false, reason: "not_a_stamp" };

    const message = notificationMessage(data);
    if (!(await deps.store.claimNotification(serial, message.kind))) return { patched, notified: false, reason: "budget" };

    const payload = {
      id: (deps.newMessageId ?? (() => `m${(deps.now?.() ?? new Date()).getTime()}`))(),
      header: message.header,
      body: message.body,
      messageType: "TEXT_AND_NOTIFY",
    };
    try {
      await deps.api.addMessage(id, payload);
    } catch (e) {
      if (e instanceof GoogleApiError && e.status === 400) {
        // Une carte garde 10 messages au maximum : on efface les anciens et on réessaie une fois.
        await deps.api.patchObject(id, { messages: [] });
        await deps.api.addMessage(id, payload);
      } else {
        throw e;
      }
    }
    return { patched, notified: true };
  } catch (e) {
    const err = e as GoogleApiError;
    const quota = err instanceof GoogleApiError && (err.status === 429 || err.reason === "quotaExceeded");
    return { patched, notified: false, reason: quota ? "quota" : "error", error: err.message };
  }
}
