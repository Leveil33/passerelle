// Les « repères » d'Apple (passesUpdatedSince / lastUpdated) sont des textes que nous inventons.
// On utilise une date ISO 8601 UTC avec microsecondes (ex. 2026-11-20T00:56:09.488123Z) : sans
// perte de précision par rapport à la base, et sans caractère « + » qui se déformerait dans une adresse.

const TS = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]00(?::?00)?)$/;

/** Met un horodatage de Postgres (« …+00:00 ») au format de repère ci-dessus. Renvoie null s'il est illisible. */
export function normalizeTimestamp(value: string): string | null {
  const m = TS.exec(value.trim());
  if (m) return `${m[1]}T${m[2]}.${(m[3] ?? "").padEnd(6, "0")}Z`;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");
}

/** Repère reçu d'Apple : on le renvoie normalisé, ou null si absent / non reconnu (alors : on renvoie tout). */
export function parseTag(tag: string | null | undefined): string | null {
  if (!tag) return null;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(tag) ? tag : null;
}
