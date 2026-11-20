// Après un changement du commerçant (récompense, couleur, logo, adresses…) : mettre à jour les cartes DÉJÀ distribuées.
//  • la base marque déjà ces cartes comme modifiées (déclencheurs) : un iPhone qui rafraîchit les récupère ;
//  • ici, on PRÉVIENT activement : signal à tous les iPhone, mise à jour de la classe et des cartes chez Google.
// Aucune notification visible n'est créée (seul un tampon change le texte de notification).
import { sendPassUpdatePushes, type PushOptions, type PushResult } from "@/lib/apple/push";
import type { AppleConfig } from "@/lib/apple/config";
import { notifyGoogleCardUpdated, syncClass, type GoogleDeps } from "@/lib/google/service";
import type { WalletStore } from "@/lib/wallet/store";

export type PropagateDeps = {
  store: WalletStore;
  apple?: { config: Pick<AppleConfig, "passTypeId" | "certs">; host?: string; ca?: Buffer; sender?: (tokens: string[], o: PushOptions) => Promise<PushResult[]> } | null;
  google?: GoogleDeps | null;
  /** Nombre maximum de cartes traitées par programme et par passage (le reste est signalé). */
  limit?: number;
  concurrency?: number;
  log?: (message: string, meta?: unknown) => void;
};

export type PropagateSummary = {
  apple: { tokens: number; sent: number; removed: number } | null;
  google: { cards: number; patched: number; failed: number; classUpdated: boolean } | null;
  truncated: boolean;
};

async function inBatches<T>(items: T[], size: number, work: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(work));
}

/** Ne lève jamais d'erreur : un Wallet en panne ne doit pas faire échouer l'enregistrement d'un réglage. */
export async function propagateProgram(programId: string, deps: PropagateDeps): Promise<PropagateSummary> {
  const limit = deps.limit ?? 2000;
  const log = deps.log ?? ((m: string, meta?: unknown) => console.error(m, meta ?? ""));
  const summary: PropagateSummary = { apple: null, google: null, truncated: false };

  if (deps.apple) {
    try {
      const tokens = await deps.store.programPushTokens(programId, limit + 1);
      if (tokens.length > limit) summary.truncated = true;
      const used = tokens.slice(0, limit);
      const send = deps.apple.sender ?? sendPassUpdatePushes;
      let sent = 0;
      let removed = 0;
      for (let i = 0; i < used.length; i += 500) {
        const results = await send(used.slice(i, i + 500), {
          passTypeId: deps.apple.config.passTypeId,
          cert: deps.apple.config.certs.signerCert,
          key: deps.apple.config.certs.signerKey,
          passphrase: deps.apple.config.certs.signerKeyPassphrase,
          host: deps.apple.host,
          ca: deps.apple.ca,
        });
        sent += results.filter((r) => r.status === 200).length;
        for (const r of results) if (r.invalid) removed += await deps.store.forgetPushToken(r.token);
      }
      summary.apple = { tokens: used.length, sent, removed };
    } catch (e) {
      log("Mise à jour Apple impossible", (e as Error).message);
    }
  }

  if (deps.google) {
    const g = { cards: 0, patched: 0, failed: 0, classUpdated: false };
    summary.google = g;
    try {
      await syncClass(programId, deps.google);
      g.classUpdated = true;
    } catch (e) {
      log("Mise à jour de la classe Google impossible", (e as Error).message);
    }
    try {
      const serials = await deps.store.programGoogleSerials(programId, limit + 1);
      if (serials.length > limit) summary.truncated = true;
      const used = serials.slice(0, limit);
      g.cards = used.length;
      await inBatches(used, deps.concurrency ?? 5, async (serial) => {
        const res = await notifyGoogleCardUpdated(serial, "refresh", deps.google!);
        if (res.patched) g.patched++;
        else g.failed++;
      });
    } catch (e) {
      log("Mise à jour des cartes Google impossible", (e as Error).message);
    }
  }

  if (summary.truncated) log("Mise à jour partielle : trop de cartes, le reste sera mis à jour au prochain tampon.", programId);
  return summary;
}

export async function propagatePrograms(programIds: string[], deps: PropagateDeps): Promise<PropagateSummary[]> {
  const out: PropagateSummary[] = [];
  for (const id of programIds) out.push(await propagateProgram(id, deps));
  return out;
}
