// Contrôle des données reçues : on n'accepte que ce qu'on attend, avec un message clair sinon.
export class InputError extends Error {}

type Obj = Record<string, unknown>;
export const isObject = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

export function text(o: Obj, key: string, label: string, min: number, max: number, optional = false): string | undefined {
  const v = o[key];
  if (v === undefined) {
    if (optional) return undefined;
    throw new InputError(`${label} : champ obligatoire.`);
  }
  if (typeof v !== "string") throw new InputError(`${label} : texte attendu.`);
  const t = v.trim();
  if (t.length < min || t.length > max) throw new InputError(`${label} : entre ${min} et ${max} caractères.`);
  return t;
}

export function integer(o: Obj, key: string, label: string, min: number, max: number, optional = false): number | undefined {
  const v = o[key];
  if (v === undefined) {
    if (optional) return undefined;
    throw new InputError(`${label} : champ obligatoire.`);
  }
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new InputError(`${label} : nombre entier entre ${min} et ${max}.`);
  return v;
}

export function number(o: Obj, key: string, label: string, min: number, max: number, optional = false): number | undefined {
  const v = o[key];
  if (v === undefined) {
    if (optional) return undefined;
    throw new InputError(`${label} : champ obligatoire.`);
  }
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new InputError(`${label} : nombre entre ${min} et ${max}.`);
  return v;
}

export function bool(o: Obj, key: string, label: string): boolean | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new InputError(`${label} : oui ou non attendu.`);
  return v;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuid(o: Obj, key: string, label: string): string {
  const v = o[key];
  if (typeof v !== "string" || !UUID.test(v)) throw new InputError(`${label} : identifiant invalide.`);
  return v.toLowerCase();
}

export function color(o: Obj, key: string, optional = true): string | undefined {
  const v = o[key];
  if (v === undefined && optional) return undefined;
  if (typeof v !== "string" || !/^#[0-9a-fA-F]{6}$/.test(v)) throw new InputError("Couleur : format #RRGGBB attendu (ex. #E11D48).");
  return v.toUpperCase();
}

export function email(o: Obj, key: string): string {
  const v = o[key];
  if (typeof v !== "string") throw new InputError("Adresse e-mail : champ obligatoire.");
  const t = v.trim().toLowerCase();
  if (t.length > 200 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t)) throw new InputError("Cette adresse e-mail n'a pas l'air valide.");
  return t;
}

/** Ne garde que les champs renseignés. */
export function defined<T extends Obj>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
