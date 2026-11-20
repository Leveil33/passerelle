// OUTIL DE TEST PROVISOIRE (à supprimer en Phase 4, quand le scan commerçant enverra lui-même ce signal).
// POST /api/dev/push  { "serial": "…" }  avec  Authorization: Bearer <DEV_TOOLS_TOKEN>
// Désactivé (404) tant que la variable DEV_TOOLS_TOKEN n'existe pas.
import { getAppleConfig } from "@/lib/apple/config";
import { getWalletStore } from "@/lib/apple/deps";
import { notifyCardUpdated } from "@/lib/apple/notify";
import { json, readJson, safeEqual } from "@/lib/wallet/http";

export async function POST(req: Request) {
  const expected = process.env.DEV_TOOLS_TOKEN;
  if (!expected || expected.length < 24) return json({ error: "Introuvable." }, 404);
  const given = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!given || !safeEqual(given, expected)) return json({ error: "Non autorisé." }, 401);

  const body = await readJson(req);
  const serial = body && typeof body === "object" ? (body as { serial?: unknown }).serial : undefined;
  if (typeof serial !== "string" || !/^[0-9a-f]{32}$/.test(serial)) return json({ error: "serial invalide." }, 400);

  try {
    const summary = await notifyCardUpdated(serial, {
      store: getWalletStore(),
      config: getAppleConfig(),
      host: process.env.APPLE_APNS_HOST || undefined,
    });
    return json(summary);
  } catch (e) {
    console.error("Envoi du signal impossible :", (e as Error).message);
    return json({ error: "Envoi impossible." }, 500);
  }
}
