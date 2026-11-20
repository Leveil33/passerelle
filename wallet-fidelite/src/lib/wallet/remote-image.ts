// Téléchargement des images du commerçant (logo, tampon importé) pour fabriquer les cartes.
//
// Sécurité : seules les adresses de NOTRE dossier d'images sont suivies (même site que Supabase, chemin imposé,
// pas de redirection, taille et délai limités). Une adresse quelconque ne doit jamais faire télécharger autre chose
// à notre serveur. En cas de problème, on renvoie null et la carte utilise ses dessins intégrés.
export const ASSET_PATH_PREFIX = "/storage/v1/object/public/merchant-assets/";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type AssetLoaderOptions = {
  /** Site autorisé, ex. https://xxxx.supabase.co */
  allowedOrigin: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  onProblem?: (message: string) => void;
};

export type AssetLoader = (url: string | null | undefined) => Promise<Buffer | null>;

export function createAssetLoader(opts: AssetLoaderOptions): AssetLoader {
  const doFetch = opts.fetch ?? fetch;
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const cache = new Map<string, Buffer>(); // les adresses contiennent l'empreinte du contenu : jamais périmées

  return async (url) => {
    if (!url) return null;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.origin !== new URL(opts.allowedOrigin).origin || !parsed.pathname.startsWith(ASSET_PATH_PREFIX) || parsed.username || parsed.password) {
      opts.onProblem?.("Adresse d'image refusée (hors de notre dossier d'images).");
      return null;
    }
    const hit = cache.get(parsed.href);
    if (hit) return hit;

    try {
      const res = await doFetch(parsed.href, { redirect: "error", signal: AbortSignal.timeout(opts.timeoutMs ?? 5000) });
      if (!res.ok) return null;
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > maxBytes) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes || buf.length < PNG_SIGNATURE.length || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
      if (cache.size >= 50) cache.delete(cache.keys().next().value as string);
      cache.set(parsed.href, buf);
      return buf;
    } catch (e) {
      opts.onProblem?.(`Image indisponible : ${(e as Error).message}`);
      return null;
    }
  };
}
