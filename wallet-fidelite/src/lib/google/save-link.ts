// Lien « Ajouter à Google Wallet » : un JWT signé qui désigne une carte déjà créée chez Google.
import { signJwt } from "./auth";

export const SAVE_URL_PREFIX = "https://pay.google.com/gp/v/save/";

export function createSaveUrl(opts: {
  email: string;
  privateKey: string;
  /** Adresses des sites autorisés à afficher le bouton « Ajouter » (ici : le nôtre). */
  origins: string[];
  objectIds: string[];
  now?: Date;
}): string {
  const jwt = signJwt(
    {
      iss: opts.email,
      aud: "google",
      typ: "savetowallet",
      iat: Math.floor((opts.now ?? new Date()).getTime() / 1000),
      origins: opts.origins,
      payload: { loyaltyObjects: opts.objectIds.map((id) => ({ id })) },
    },
    opts.privateKey,
  );
  return `${SAVE_URL_PREFIX}${jwt}`;
}
