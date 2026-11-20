// Données nécessaires pour fabriquer une carte Wallet (Apple ou Google).
// Elles viennent de la fonction SQL public.loyalty_pass_data (réservée au serveur).

export type PassData = {
  card: {
    id: string;
    serial_number: string;
    /** Secret Apple : ne doit jamais sortir du serveur, sauf dans le .pkpass lui-même. */
    auth_token: string;
    stamps: number;
    rewards_earned: number;
    platform: string | null;
    /** ISO 8601 UTC, avec microsecondes. */
    updated_at: string;
  };
  customer: { first_name: string };
  program: {
    id: string;
    name: string;
    stamps_required: number;
    reward_label: string;
    proximity_message: string;
    is_active: boolean;
    stamp_icon: string;
    stamp_icon_url: string | null;
  };
  merchant: { id: string; name: string; logo_url: string | null; brand_color: string };
  /** 10 au maximum (limite Apple / Google), les plus anciennes d'abord. */
  locations: { label: string; address: string; latitude: number; longitude: number }[];
};

function fail(path: string): never {
  throw new Error(`Données de carte invalides : « ${path} » manquant ou de mauvais type.`);
}
const obj = (v: unknown, path: string) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : fail(path));
const str = (v: unknown, path: string) => (typeof v === "string" ? v : fail(path));
const num = (v: unknown, path: string) => (typeof v === "number" && Number.isFinite(v) ? v : fail(path));
const bool = (v: unknown, path: string) => (typeof v === "boolean" ? v : fail(path));
const strOrNull = (v: unknown, path: string) => (v === null || v === undefined ? null : str(v, path));

/** Vérifie la forme des données reçues de la base (et ne garde que ce qu'on utilise). */
export function parsePassData(value: unknown): PassData {
  const root = obj(value, "racine");
  const card = obj(root.card, "card");
  const customer = obj(root.customer, "customer");
  const program = obj(root.program, "program");
  const merchant = obj(root.merchant, "merchant");
  const locations = Array.isArray(root.locations) ? root.locations : fail("locations");

  return {
    card: {
      id: str(card.id, "card.id"),
      serial_number: str(card.serial_number, "card.serial_number"),
      auth_token: str(card.auth_token, "card.auth_token"),
      stamps: num(card.stamps, "card.stamps"),
      rewards_earned: num(card.rewards_earned, "card.rewards_earned"),
      platform: strOrNull(card.platform, "card.platform"),
      updated_at: str(card.updated_at, "card.updated_at"),
    },
    customer: { first_name: str(customer.first_name, "customer.first_name") },
    program: {
      id: str(program.id, "program.id"),
      name: str(program.name, "program.name"),
      stamps_required: num(program.stamps_required, "program.stamps_required"),
      reward_label: str(program.reward_label, "program.reward_label"),
      proximity_message: str(program.proximity_message ?? "", "program.proximity_message"),
      is_active: bool(program.is_active, "program.is_active"),
      stamp_icon: str(program.stamp_icon, "program.stamp_icon"),
      stamp_icon_url: strOrNull(program.stamp_icon_url, "program.stamp_icon_url"),
    },
    merchant: {
      id: str(merchant.id, "merchant.id"),
      name: str(merchant.name, "merchant.name"),
      logo_url: strOrNull(merchant.logo_url, "merchant.logo_url"),
      brand_color: str(merchant.brand_color, "merchant.brand_color"),
    },
    locations: locations.map((l, i) => {
      const loc = obj(l, `locations[${i}]`);
      return {
        label: str(loc.label, `locations[${i}].label`),
        address: str(loc.address ?? "", `locations[${i}].address`),
        latitude: num(loc.latitude, `locations[${i}].latitude`),
        longitude: num(loc.longitude, `locations[${i}].longitude`),
      };
    }),
  };
}
