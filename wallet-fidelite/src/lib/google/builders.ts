// Construction des objets envoyés à Google : la « classe » (un programme) et l'« objet » (la carte d'un client).
import { createHash } from "node:crypto";
import { signQrPayload } from "@/lib/loyalty/qr";
import type { ClassData, PassData } from "@/lib/wallet/types";
import type { Json } from "./api";

export const MAX_LOCATIONS = 10;

export const classId = (issuerId: string, programId: string) => `${issuerId}.${programId}`;
export const objectId = (issuerId: string, serial: string) => `${issuerId}.${serial}`;

/** Raccourcit un texte (Google recommande 20 caractères pour le nom de l'émetteur, 29 pour un titre de notification). */
export function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Empreinte de l'apparence (couleur, icône, nombre de cases) : change l'adresse des images, donc vide leur cache chez Google. */
export function lookHash(parts: { brand_color: string; stamp_icon: string; stamps_required?: number }): string {
  return createHash("sha1").update(JSON.stringify([parts.brand_color, parts.stamp_icon, parts.stamps_required ?? 0])).digest("hex").slice(0, 8);
}

export function programLogoUrl(appUrl: string, data: ClassData): string {
  // Un logo fourni par le commerçant (Phase 5, rangé chez nous) a la priorité ; sinon, un logo dessiné.
  if (data.merchant.logo_url) return data.merchant.logo_url;
  return `${appUrl}/api/programs/${data.program.id}/logo.png?v=${lookHash({ ...data.merchant, ...data.program, stamps_required: 0 })}`;
}

export function heroUrl(appUrl: string, data: PassData): string {
  const stamps = Math.min(Math.max(0, data.card.stamps), data.program.stamps_required);
  return `${appUrl}/api/cards/${data.card.serial_number}/hero/${stamps}.png?v=${lookHash({ ...data.merchant, ...data.program })}`;
}

const text = (value: string) => ({ defaultValue: { language: "fr", value } });
const image = (uri: string, description: string) => ({ sourceUri: { uri }, contentDescription: text(description) });

/** La classe : ce qui est commun à toutes les cartes d'un programme (nom, logo, couleur, adresses). */
export function buildClass(data: ClassData, ctx: { issuerId: string; appUrl: string }): Json {
  return {
    id: classId(ctx.issuerId, data.program.id),
    issuerName: truncate(data.merchant.name, 20),
    programName: data.program.name,
    programLogo: image(programLogoUrl(ctx.appUrl, data), data.merchant.name),
    hexBackgroundColor: data.merchant.brand_color,
    reviewStatus: "UNDER_REVIEW",
    // « merchantLocations » (et non « locations », obsolète et sans effet) : déclenche l'apparition de la carte
    // à proximité. Google choisit lui-même la distance et le texte. 10 au maximum.
    merchantLocations: data.locations.slice(0, MAX_LOCATIONS).map((l) => ({ latitude: l.latitude, longitude: l.longitude })),
  };
}

/** L'objet : la carte d'un client. */
export function buildObject(data: PassData, ctx: { issuerId: string; appUrl: string; qrSecret: string }): Json {
  const { stamps, rewards_earned, serial_number } = data.card;
  const { stamps_required, reward_label } = data.program;
  return {
    id: objectId(ctx.issuerId, serial_number),
    classId: classId(ctx.issuerId, data.program.id),
    state: "ACTIVE",
    accountId: serial_number,
    accountName: truncate(data.customer.first_name, 20),
    barcode: { type: "QR_CODE", value: signQrPayload(serial_number, ctx.qrSecret) },
    loyaltyPoints: { label: "Tampons", balance: { string: `${Math.min(stamps, stamps_required)} / ${stamps_required}` } },
    secondaryLoyaltyPoints: { label: "Obtenues", balance: { int: rewards_earned } },
    heroImage: image(heroUrl(ctx.appUrl, data), `${stamps} tampon${stamps > 1 ? "s" : ""} sur ${stamps_required}`),
    textModulesData: [
      { id: "reward", header: "Récompense", body: reward_label },
      {
        id: "rules",
        header: "Comment ça marche",
        body: `Présente cette carte à chaque passage en caisse : un tampon t'est ajouté. À ${stamps_required} tampons, ${reward_label.toLowerCase()}.`,
      },
    ],
  };
}

/** Le message qui déclenche une notification Android : récompense disponible, ou nombre de tampons restants. */
export function notificationMessage(data: PassData): { kind: "stamp" | "reward"; header: string; body: string } {
  const remaining = Math.max(0, data.program.stamps_required - data.card.stamps);
  if (remaining === 0) {
    return { kind: "reward", header: "Carte pleine !", body: truncate(`Récompense disponible : ${data.program.reward_label} !`, 80) };
  }
  return {
    kind: "stamp",
    header: truncate(data.merchant.name, 28),
    body: remaining === 1 ? "Plus qu'1 tampon avant ta récompense !" : `Plus que ${remaining} tampons avant ta récompense !`,
  };
}
