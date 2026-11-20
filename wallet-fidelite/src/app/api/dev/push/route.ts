// OUTIL DE TEST PROVISOIRE (à supprimer en Phase 4, quand le scan commerçant enverra lui-même ce signal).
// POST /api/dev/push  { "serial": "…" }   (Apple ET Google : chacun est ignoré s'il n'est pas configuré)  avec  Authorization: Bearer <DEV_TOOLS_TOKEN>
// Désactivé (404) tant que la variable DEV_TOOLS_TOKEN n'existe pas.
import { getAppleConfig } from "@/lib/apple/config";
import { getWalletStore } from "@/lib/apple/deps";
import { notifyCardUpdated } from "@/lib/apple/notify";
import { getGoogleDeps } from "@/lib/google/deps";
import { notifyGoogleCardUpdated } from "@/lib/google/service";
import { json, readJson, safeEqual } from "@/lib/wallet/http";

export async function POST(req: Request) {
  const expected = process.env.DEV_TOOLS_TOKEN;
  if (!expected || expected.length < 24) return json({ error: "Introuvable." }, 404);
  const given = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!given || !safeEqual(given, expected)) return json({ error: "Non autorisé." }, 401);

  const body = await readJson(req);
  const serial = body && typeof body === "object" ? (body as { serial?: unknown }).serial : undefined;
  if (typeof serial !== "string" || !/^[0-9a-f]{32}$/.test(serial)) return json({ error: "serial invalide." }, 400);

  const store = getWalletStore();
  const result: { apple?: unknown; google?: unknown } = {};
  try {
    result.apple = await notifyCardUpdated(serial, {
      store,
      config: getAppleConfig(),
      host: process.env.APPLE_APNS_HOST || undefined,
    });
  } catch (e) {
    result.apple = { error: (e as Error).message };
  }
  try {
    result.google = await notifyGoogleCardUpdated(serial, "stamp", getGoogleDeps());
  } catch (e) {
    result.google = { error: (e as Error).message };
  }
  return json(result);
}
