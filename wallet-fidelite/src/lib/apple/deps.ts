// Branchement des adresses publiques sur la vraie base (clé secrète, côté serveur uniquement).
import "server-only";
import { getQrSecret } from "@/lib/loyalty/qr";
import { createAssetLoader, type AssetLoader } from "@/lib/wallet/remote-image";
import { createAdminClient } from "@/lib/supabase/admin";
import { json } from "@/lib/wallet/http";
import { createSupabaseWalletStore, type WalletStore } from "@/lib/wallet/store";
import { getAppleConfig, getPassTypeId } from "./config";
import { buildPkPass } from "./pass";
import type { StoreDeps, WebServiceDeps } from "./web-service";

let loader: { origin: string; load: AssetLoader } | null = null;

/** Chargeur des images du commerçant : n'accepte que notre dossier d'images Supabase. */
export function getAssetLoader(): AssetLoader {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return async () => null;
  const origin = new URL(url).origin;
  if (!loader || loader.origin !== origin) {
    loader = { origin, load: createAssetLoader({ allowedOrigin: origin, onProblem: (m) => console.error("Images :", m) }) };
  }
  return loader.load;
}

export function getWalletStore(): WalletStore {
  return createSupabaseWalletStore(createAdminClient());
}

/**
 * Prépare les dépendances puis exécute le traitement. Une configuration incomplète donne une réponse 503
 * (le détail — noms des variables manquantes, jamais leurs valeurs — va dans les journaux du serveur).
 */
export async function withWalletDeps(run: (deps: WebServiceDeps) => Promise<Response>): Promise<Response> {
  let deps: WebServiceDeps;
  try {
    deps = {
      store: getWalletStore(),
      passTypeId: getPassTypeId(),
      buildPass: async (data) => {
        const load = getAssetLoader();
        const [logo, stamp] = await Promise.all([
          load(data.merchant.logo_url),
          data.program.stamp_icon === "custom" ? load(data.program.stamp_icon_url) : Promise.resolve(null),
        ]);
        return buildPkPass(data, { config: getAppleConfig(), qrSecret: getQrSecret(), assets: { logo, stamp } });
      },
      loadAsset: getAssetLoader(),
    };
  } catch (e) {
    console.error("Configuration du Wallet incomplète :", (e as Error).message);
    return json({ error: "Service momentanément indisponible." }, 503);
  }
  try {
    return await run(deps);
  } catch (e) {
    console.error("Erreur inattendue :", (e as Error).message);
    return json({ error: "Une erreur est survenue." }, 500);
  }
}

/** Pour les adresses qui n'ont pas besoin d'Apple (création de carte, journaux) : seule la base est requise. */
export async function withStoreDeps(run: (deps: StoreDeps) => Promise<Response>): Promise<Response> {
  let deps: StoreDeps;
  try {
    deps = { store: getWalletStore(), loadAsset: getAssetLoader() };
  } catch (e) {
    console.error("Configuration du Wallet incomplète :", (e as Error).message);
    return json({ error: "Service momentanément indisponible." }, 503);
  }
  try {
    return await run(deps);
  } catch (e) {
    console.error("Erreur inattendue :", (e as Error).message);
    return json({ error: "Une erreur est survenue." }, 500);
  }
}
