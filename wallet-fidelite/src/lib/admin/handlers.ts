// Adresses de l'administration : réglages du commerçant (propriétaire) et création d'un commerce (propriétaire de la solution).
import { randomInt } from "node:crypto";
import { isStampIconKey } from "@/lib/stamps/icons";
import { guardOrigin, guardPost } from "@/lib/staff/handlers";
import { json, readJson } from "@/lib/wallet/http";
import { StoreError } from "@/lib/wallet/store";
import { ImageError, MAX_UPLOAD_BYTES, assetPath, normalizeImage, type ImageKind } from "./images";
import type { OwnerStore, ServerAdmin } from "./types";
import * as v from "./validate";

export type AdminDeps = {
  owner: OwnerStore;
  server: ServerAdmin;
  /** Met à jour les cartes déjà distribuées de ces programmes (exécuté après la réponse en production). */
  propagate: (programIds: string[]) => Promise<void>;
  schedule?: (work: () => Promise<void>) => void;
  log?: (message: string, meta?: unknown) => void;
};

const fail = (status: number, code: string, error: string) => json({ error, code }, status);
const logger = (d: Pick<AdminDeps, "log">) => d.log ?? ((m: string, meta?: unknown) => console.error(m, meta ?? ""));

/** Mot de passe provisoire lisible (sans caractères ambigus), 14 caractères. */
export function temporaryPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  return Array.from({ length: 14 }, () => alphabet[randomInt(alphabet.length)]).join("");
}

function after(deps: AdminDeps, programIds: string[]) {
  if (programIds.length === 0) return;
  const work = async () => {
    try {
      await deps.propagate(programIds);
    } catch (e) {
      logger(deps)("Mise à jour des cartes impossible", (e as Error).message);
    }
  };
  if (deps.schedule) deps.schedule(work);
  else void work();
}

/** Lecture + contrôle du corps JSON ; renvoie la réponse d'erreur à renvoyer si le corps est invalide. */
async function body(req: Request): Promise<{ data: Record<string, unknown> } | { response: Response }> {
  const guard = guardPost(req);
  if (guard) return { response: guard };
  const data = await readJson(req, 8192);
  if (!v.isObject(data)) return { response: fail(400, "invalid_request", "Requête invalide.") };
  return { data };
}

/** Exécute un traitement en transformant les erreurs de saisie et de base en réponses claires. */
async function guarded(deps: Pick<AdminDeps, "log">, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof v.InputError) return fail(400, "invalid_input", e.message);
    if (e instanceof ImageError) return fail(422, e.code, e.message);
    if (e instanceof StoreError) {
      if (e.message === "last_owner") return fail(409, "last_owner", "Impossible : un commerce doit toujours garder au moins un propriétaire.");
      if (e.code === "23514" || e.code === "22P02" || e.code === "22003") return fail(400, "invalid_input", "Cette valeur n'est pas acceptée.");
      if (e.code === "42501") return fail(404, "not_found", "Introuvable.");
    }
    logger(deps)("Erreur d'administration", (e as Error).message);
    return fail(500, "unknown", "Une erreur est survenue. Réessayez dans un instant.");
  }
}

const notFound = () => fail(404, "not_found", "Introuvable.");

// ─── Programme et apparence ───────────────────────────────────────────────────────────────────

/** PATCH /api/admin/program : cases, récompense, message de proximité, tampon, délai anti double scan, activation. */
export async function handleUpdateProgram(req: Request, deps: AdminDeps): Promise<Response> {
  const b = await body(req);
  if ("response" in b) return b.response;
  return guarded(deps, async () => {
    const o = b.data;
    const programId = v.uuid(o, "programId", "Programme");
    const stampIcon = v.text(o, "stampIcon", "Tampon", 1, 40, true);
    if (stampIcon !== undefined && stampIcon !== "custom" && !isStampIconKey(stampIcon)) throw new v.InputError("Tampon : icône inconnue.");
    const patch = v.defined({
      name: v.text(o, "name", "Nom du programme", 1, 100, true),
      stamps_required: v.integer(o, "stampsRequired", "Nombre de cases", 1, 50, true),
      reward_label: v.text(o, "rewardLabel", "Récompense", 1, 100, true),
      proximity_message: v.text(o, "proximityMessage", "Message de proximité", 0, 200, true),
      is_active: v.bool(o, "isActive", "Programme actif"),
      double_scan_delay_minutes: v.integer(o, "doubleScanDelayMinutes", "Délai anti double scan", 0, 1440, true),
      stamp_icon: stampIcon,
    });
    if (Object.keys(patch).length === 0) throw new v.InputError("Rien à modifier.");

    const merchantId = await deps.owner.merchantOfProgram(programId);
    if (!merchantId || (await deps.owner.myRole(merchantId)) !== "owner") return notFound();
    if (!(await deps.owner.updateProgram(programId, patch))) return notFound();

    // Le délai anti double scan n'apparaît pas sur la carte : inutile de la remettre à jour.
    if (Object.keys(patch).some((k) => k !== "double_scan_delay_minutes")) after(deps, [programId]);
    return json({ ok: true });
  });
}

/** PATCH /api/admin/merchant : nom et couleur du commerce. */
export async function handleUpdateMerchant(req: Request, deps: AdminDeps): Promise<Response> {
  const b = await body(req);
  if ("response" in b) return b.response;
  return guarded(deps, async () => {
    const o = b.data;
    const merchantId = v.uuid(o, "merchantId", "Commerce");
    const patch = v.defined({ name: v.text(o, "name", "Nom du commerce", 1, 100, true), brand_color: v.color(o, "brandColor") });
    if (Object.keys(patch).length === 0) throw new v.InputError("Rien à modifier.");

    if ((await deps.owner.myRole(merchantId)) !== "owner") return notFound();
    if (!(await deps.owner.updateMerchant(merchantId, patch))) return notFound();
    after(deps, await deps.owner.programIds(merchantId));
    return json({ ok: true });
  });
}

// ─── Adresses ─────────────────────────────────────────────────────────────────────────────────

/** Apple et Google acceptent 10 adresses au maximum par carte : au-delà, seules les 10 premières comptent. */
const locationReply = async (deps: AdminDeps, merchantId: string, extra: Record<string, unknown> = {}) => {
  const count = await deps.owner.countLocations(merchantId);
  return json({ ok: true, ...extra, locationCount: count, overLimit: count > 10 });
};

export async function handleAddLocation(req: Request, deps: AdminDeps): Promise<Response> {
  const b = await body(req);
  if ("response" in b) return b.response;
  return guarded(deps, async () => {
    const o = b.data;
    const merchantId = v.uuid(o, "merchantId", "Commerce");
    const loc = {
      label: v.text(o, "label", "Nom de l'adresse", 1, 100) as string,
      address: v.text(o, "address", "Adresse", 0, 300, true) ?? "",
      latitude: v.number(o, "latitude", "Latitude", -90, 90) as number,
      longitude: v.number(o, "longitude", "Longitude", -180, 180) as number,
    };
    if ((await deps.owner.myRole(merchantId)) !== "owner") return notFound();
    const id = await deps.owner.insertLocation(merchantId, loc);
    after(deps, await deps.owner.programIds(merchantId));
    return locationReply(deps, merchantId, { id });
  });
}

export async function handleUpdateLocation(req: Request, deps: AdminDeps): Promise<Response> {
  const b = await body(req);
  if ("response" in b) return b.response;
  return guarded(deps, async () => {
    const o = b.data;
    const locationId = v.uuid(o, "locationId", "Adresse");
    const patch = v.defined({
      label: v.text(o, "label", "Nom de l'adresse", 1, 100, true),
      address: v.text(o, "address", "Adresse", 0, 300, true),
      latitude: v.number(o, "latitude", "Latitude", -90, 90, true),
      longitude: v.number(o, "longitude", "Longitude", -180, 180, true),
    });
    if (Object.keys(patch).length === 0) throw new v.InputError("Rien à modifier.");
    const merchantId = await deps.owner.merchantOfLocation(locationId);
    if (!merchantId || (await deps.owner.myRole(merchantId)) !== "owner") return notFound();
    if (!(await deps.owner.updateLocation(locationId, patch))) return notFound();
    after(deps, await deps.owner.programIds(merchantId));
    return locationReply(deps, merchantId);
  });
}

export async function handleDeleteLocation(req: Request, deps: AdminDeps): Promise<Response> {
  const b = await body(req);
  if ("response" in b) return b.response;
  return guarded(deps, async () => {
    const locationId = v.uuid(b.data, "locationId", "Adresse");
    const merchantId = await deps.owner.merchantOfLocation(locationId);
    if (!merchantId || (await deps.owner.myRole(merchantId)) !== "owner") return notFound();
    if (!(await deps.owner.deleteLocation(locationId))) return notFound();
    after(deps, await deps.owner.programIds(merchantId));
    return locationReply(deps, merchantId);
  });
}

// ─── Équipe ───────────────────────────────────────────────────────────────────────────────────

/** GET : membres du commerce avec leur adresse e-mail (réservé au propriétaire). */
export async function handleListTeam(req: Request, deps: AdminDeps): Promise<Response> {
  return guarded(deps, async () => {
    const merchantId = new URL(req.url).searchParams.get("merchantId") ?? "";
    if (!v.UUID.test(merchantId) || (await deps.owner.myRole(merchantId)) !== "owner") return notFound();
    const members = await deps.owner.team(merchantId);
    const emails = await deps.server.emails(members.map((m) => m.userId));
    return json({ members: members.map((m) => ({ id: m.id, role: m.role, email: emails[m.userId] ?? "(inconnu)", isMe: m.userId === deps.owner.userId })) });
  });
}

/** POST : ajoute un employé (compte créé avec un mot de passe provisoire, affiché une seule fois). */
export async function handleAddMember(req: Request, deps: AdminDeps): Promise<Response> {
  const b = await body(req);
  if ("response" in b) return b.response;
  return guarded(deps, async () => {
    const merchantId = v.uuid(b.data, "merchantId", "Commerce");
    const email = v.email(b.data, "email");
    if ((await deps.owner.myRole(merchantId)) !== "owner") return notFound();

    const password = temporaryPassword();
    const user = await deps.server.createUser(email, password);
    // On n'accroche jamais un compte existant : il pourrait appartenir à un autre commerce.
    if (user === "exists") return fail(409, "email_taken", "Un compte existe déjà avec cette adresse e-mail.");
    try {
      await deps.server.addMember(merchantId, user.id, "staff");
    } catch (e) {
      await deps.server.deleteUser(user.id).catch(() => {});
      throw e;
    }
    return json({ ok: true, email, temporaryPassword: password }, 201);
  });
}

/** DELETE : retire un membre (le dernier propriétaire ne peut pas être retiré). */
export async function handleRemoveMember(req: Request, deps: AdminDeps): Promise<Response> {
  const b = await body(req);
  if ("response" in b) return b.response;
  return guarded(deps, async () => {
    const memberId = v.uuid(b.data, "memberId", "Membre");
    const merchantId = await deps.owner.merchantOfMember(memberId);
    if (!merchantId || (await deps.owner.myRole(merchantId)) !== "owner") return notFound();
    if (!(await deps.owner.removeMember(memberId))) return notFound();
    return json({ ok: true });
  });
}

// ─── Images (logo, tampon) ────────────────────────────────────────────────────────────────────

/** POST multipart : kind = logo | stamp, id = commerce (logo) ou programme (tampon), file = image. */
export async function handleUploadAsset(req: Request, deps: AdminDeps): Promise<Response> {
  const guard = guardOrigin(req);
  if (guard) return guard;
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) return fail(415, "bad_content_type", "Requête invalide.");
  if (Number(req.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES + 64 * 1024) return fail(413, "too_large", "Image trop lourde (2 Mo au maximum).");

  return guarded(deps, async () => {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return fail(400, "invalid_request", "Requête invalide.");
    }
    const kind = form.get("kind");
    const id = form.get("id");
    const file = form.get("file");
    if ((kind !== "logo" && kind !== "stamp") || typeof id !== "string" || !v.UUID.test(id) || !(file instanceof Blob)) {
      return fail(400, "invalid_request", "Requête invalide.");
    }
    const merchantId = kind === "logo" ? id : await deps.owner.merchantOfProgram(id);
    if (!merchantId || (await deps.owner.myRole(merchantId)) !== "owner") return notFound();

    const png = await normalizeImage(Buffer.from(await file.arrayBuffer()), kind as ImageKind);
    const url = await deps.server.uploadAsset(assetPath(kind as ImageKind, id.toLowerCase(), png), png);
    if (kind === "logo") await deps.server.setLogo(id.toLowerCase(), url);
    else await deps.server.setCustomStamp(id.toLowerCase(), url);
    after(deps, kind === "logo" ? await deps.owner.programIds(id) : [id.toLowerCase()]);
    return json({ ok: true, url });
  });
}

// ─── Mot de passe (changement obligatoire à la première connexion) ───────────────────────────────

export async function handleChangePassword(req: Request, deps: Pick<AdminDeps, "server" | "log"> & { userId: string }): Promise<Response> {
  const b = await body(req);
  if ("response" in b) return b.response;
  return guarded(deps, async () => {
    const password = b.data.password;
    if (typeof password !== "string" || password.length < 10 || password.length > 72) {
      throw new v.InputError("Le mot de passe doit faire entre 10 et 72 caractères.");
    }
    if (/^(.)\1+$/.test(password)) throw new v.InputError("Ce mot de passe est trop simple.");
    await deps.server.setPassword(deps.userId, password);
    return json({ ok: true });
  });
}

// ─── Propriétaire de la solution : créer un commerce ─────────────────────────────────────────────

export async function handleCreateMerchant(req: Request, deps: AdminDeps & { adminUserId: string }): Promise<Response> {
  const b = await body(req);
  if ("response" in b) return b.response;
  // Même réponse pour « pas administrateur » et « page inexistante » : on ne révèle pas l'existence de cette page.
  if (!(await deps.server.isPlatformAdmin(deps.adminUserId))) return notFound();

  return guarded(deps, async () => {
    const o = b.data;
    const name = v.text(o, "name", "Nom du commerce", 1, 100) as string;
    const ownerEmail = v.email(o, "ownerEmail");
    const stamps = v.integer(o, "stampsRequired", "Nombre de cases", 1, 50, true) ?? 10;
    const reward = v.text(o, "rewardLabel", "Récompense", 1, 100, true) ?? "Une récompense offerte";

    const password = temporaryPassword();
    const owner = await deps.server.ensureUser(ownerEmail, password);
    try {
      const res = await deps.server.createMerchant(deps.adminUserId, name, owner.id, stamps, reward);
      return json({ ok: true, merchantId: res.merchantId, programId: res.programId, ownerEmail, temporaryPassword: owner.created ? password : null }, 201);
    } catch (e) {
      if (owner.created) await deps.server.deleteUser(owner.id).catch(() => {}); // pas de compte orphelin
      throw e;
    }
  });
}

export async function handleListMerchants(deps: Pick<AdminDeps, "server" | "log"> & { adminUserId: string }): Promise<Response> {
  if (!(await deps.server.isPlatformAdmin(deps.adminUserId))) return notFound();
  return guarded(deps, async () => json({ merchants: await deps.server.listMerchants() }));
}
