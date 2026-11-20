// Adresses publiques Google Wallet : lien « Ajouter » et images des cartes.
import { cardColors } from "@/lib/wallet/colors";
import { clientIp, json } from "@/lib/wallet/http";
import { renderHero, renderProgramLogo } from "@/lib/stamps/render";
import { DEFAULT_STAMP_ICON, isStampIconKey } from "@/lib/stamps/icons";
import type { StoreDeps } from "@/lib/apple/web-service";
import { DEFAULT_LIMITS } from "@/lib/apple/web-service";
import { createSaveLink, type GoogleDeps } from "./service";

const SERIAL = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const logger = (deps: StoreDeps) => deps.log ?? ((m: string, meta?: unknown) => console.error(m, meta ?? ""));
const notFound = () => json({ error: "Introuvable." }, 404);

async function tooMany(deps: StoreDeps, key: string, max: number): Promise<Response | null> {
  try {
    if (await deps.store.rateLimit(key, 60, max)) return null;
    return json({ error: "Trop de requêtes, réessaie dans une minute." }, 429, { "retry-after": "60" });
  } catch (e) {
    logger(deps)("Compteur de requêtes indisponible", (e as Error).message);
    return null; // panne du compteur : on laisse passer (ces adresses ne créent rien)
  }
}

const limit = (deps: StoreDeps) => ({ ...DEFAULT_LIMITS, ...deps.limits });

/** GET /api/cards/{série}/google : redirige vers le lien « Ajouter à Google Wallet ». */
export async function handleGoogleLink(req: Request, p: { serial: string }, deps: StoreDeps & { google: GoogleDeps }): Promise<Response> {
  if (!SERIAL.test(p.serial)) return notFound();
  const limited = await tooMany(deps, `google:link:${clientIp(req)}:${p.serial}`, limit(deps).pass);
  if (limited) return limited;

  try {
    const url = await createSaveLink(p.serial, deps.google);
    if (!url) return notFound();
    return new Response(null, { status: 302, headers: { location: url, "cache-control": "no-store" } });
  } catch (e) {
    logger(deps)("Lien Google Wallet impossible", (e as Error).message);
    return json({ error: "Google Wallet est momentanément indisponible." }, 502);
  }
}

const png = (buf: Buffer) =>
  new Response(new Uint8Array(buf), { status: 200, headers: { "content-type": "image/png", "cache-control": "public, max-age=3600" } });

/** GET /api/cards/{série}/hero/{n}.png : le grand visuel de la carte avec n tampons (Google le télécharge). */
export async function handleHeroImage(req: Request, p: { serial: string; file: string }, deps: StoreDeps): Promise<Response> {
  const m = /^(\d{1,3})\.png$/.exec(p.file);
  if (!SERIAL.test(p.serial) || !m) return notFound();
  const limited = await tooMany(deps, `google:hero:${clientIp(req)}:${p.serial}`, limit(deps).pass);
  if (limited) return limited;

  const data = await deps.store.passData(p.serial);
  if (!data) return notFound();
  const colors = cardColors(data.merchant.brand_color);
  const icon = isStampIconKey(data.program.stamp_icon) ? data.program.stamp_icon : DEFAULT_STAMP_ICON;
  const customIcon = data.program.stamp_icon === "custom" ? ((await deps.loadAsset?.(data.program.stamp_icon_url)) ?? undefined) : undefined;
  return png(
    await renderHero({
      stampsRequired: data.program.stamps_required,
      stamps: Math.min(Number(m[1]), data.program.stamps_required),
      foreground: colors.foreground,
      background: colors.background,
      icon,
      customIcon,
    }),
  );
}

/** GET /api/programs/{programme}/logo.png : le logo dessiné d'un programme (quand le commerçant n'a pas de logo). */
export async function handleLogoImage(req: Request, p: { programId: string }, deps: StoreDeps): Promise<Response> {
  if (!UUID.test(p.programId)) return notFound();
  const limited = await tooMany(deps, `google:logo:${clientIp(req)}:${p.programId}`, limit(deps).pass);
  if (limited) return limited;

  const data = await deps.store.classData(p.programId);
  if (!data) return notFound();
  const colors = cardColors(data.merchant.brand_color);
  const icon = isStampIconKey(data.program.stamp_icon) ? data.program.stamp_icon : DEFAULT_STAMP_ICON;
  const customIcon = data.program.stamp_icon === "custom" ? ((await deps.loadAsset?.(data.program.stamp_icon_url)) ?? undefined) : undefined;
  return png(await renderProgramLogo({ background: colors.background, foreground: colors.foreground, icon, customIcon }));
}
