// En-têtes Last-Modified / If-Modified-Since de l'adresse « télécharger la carte à jour ».
//
// Piège : ces dates n'ont qu'une précision d'une seconde. Si on annonçait « modifiée à 12:00:00 »
// et qu'un 2e changement arrivait dans la même seconde, l'iPhone (« j'ai la version de 12:00:00 »)
// recevrait « rien de neuf » et garderait une carte périmée. On annonce donc la seconde SUIVANTE, et
// seulement une fois qu'elle est écoulée : tout changement ultérieur est alors forcément postérieur.

/** Date « Last-Modified » à envoyer, ou null s'il vaut mieux ne pas en envoyer (changement trop récent). */
export function lastModifiedFor(updatedAtIso: string, now: Date): Date | null {
  const updated = Date.parse(updatedAtIso);
  if (Number.isNaN(updated)) return null;
  const nextSecond = (Math.floor(updated / 1000) + 1) * 1000;
  return now.getTime() >= nextSecond ? new Date(nextSecond) : null;
}

/**
 * true si l'iPhone a déjà la dernière version : sa date (If-Modified-Since) est strictement postérieure au dernier
 * changement. Strict, pour qu'un changement tombant pile sur la limite ne soit jamais pris pour « rien de neuf ».
 */
export function isNotModified(ifModifiedSince: string | null, updatedAtIso: string): boolean {
  if (!ifModifiedSince) return false;
  const since = Date.parse(ifModifiedSince);
  const updated = Date.parse(updatedAtIso);
  if (Number.isNaN(since) || Number.isNaN(updated)) return false;
  return updated < since;
}
