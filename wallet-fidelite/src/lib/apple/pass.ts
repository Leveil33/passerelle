// Fabrication de la carte Apple Wallet (.pkpass) d'un client.
import { PKPass } from "passkit-generator";
import sharp from "sharp";
import { signQrPayload } from "@/lib/loyalty/qr";
import { renderPassIcon, renderStrip, type Scale } from "@/lib/stamps/render";
import { cardColors, toRgbCss } from "@/lib/wallet/colors";
import type { PassData } from "@/lib/wallet/types";
import type { AppleConfig } from "./config";

/** Rayon (en mètres) autour d'une adresse à partir duquel la carte apparaît sur l'écran verrouillé. */
export const PROXIMITY_DISTANCE_METERS = 100;

const SCALES: readonly Scale[] = [1, 2, 3];
const suffix = (s: Scale) => (s === 1 ? "" : `@${s}x`);

function remainingText(remaining: number): string {
  return remaining === 1
    ? "Plus qu'%@ tampon avant ta récompense !"
    : "Plus que %@ tampons avant ta récompense !";
}

/** Champs de la carte. Le champ « status » change de valeur à chaque tampon : c'est lui qui déclenche la notification. */
export function passFields(data: PassData) {
  const { stamps, rewards_earned } = data.card;
  const { stamps_required, reward_label } = data.program;
  const full = stamps >= stamps_required;
  const remaining = Math.max(0, stamps_required - stamps);

  return {
    header: [{ key: "stamps", label: "TAMPONS", value: `${Math.min(stamps, stamps_required)} / ${stamps_required}` }],
    secondary: [
      full
        ? {
            key: "status",
            label: "RÉCOMPENSE DISPONIBLE",
            value: reward_label,
            changeMessage: "Récompense disponible : %@ !",
          }
        : {
            key: "status",
            label: "TAMPONS RESTANTS",
            value: String(remaining),
            changeMessage: remainingText(remaining),
          },
      { key: "holder", label: "TITULAIRE", value: data.customer.first_name },
    ],
    auxiliary: [
      { key: "reward", label: "RÉCOMPENSE", value: reward_label },
      { key: "rewards", label: "OBTENUES", value: String(rewards_earned) },
    ],
    back: [
      {
        key: "rules",
        label: "Comment ça marche",
        value: `Présente cette carte à chaque passage en caisse : un tampon t'est ajouté. À ${stamps_required} tampons, ${reward_label.toLowerCase()}.`,
      },
      ...(data.locations.length > 0
        ? [
            {
              key: "shops",
              label: "Nos adresses",
              value: data.locations.map((l) => (l.address ? `${l.label} — ${l.address}` : l.label)).join("\n"),
            },
          ]
        : []),
    ],
  };
}

/** Logo d'Apple : 160 × 50 points au maximum (×2 et ×3 pour les écrans Retina). */
async function logoPng(source: Buffer, scale: Scale): Promise<Buffer> {
  return sharp(source).resize({ width: 160 * scale, height: 50 * scale, fit: "inside" }).png({ compressionLevel: 9 }).toBuffer();
}

export async function buildPkPass(
  data: PassData,
  ctx: { config: AppleConfig; qrSecret: string; assets?: { logo?: Buffer | null; stamp?: Buffer | null } },
): Promise<Buffer> {
  const { config, qrSecret } = ctx;
  const logo = ctx.assets?.logo ?? undefined;
  const customIcon = data.program.stamp_icon === "custom" ? (ctx.assets?.stamp ?? undefined) : undefined;
  const colors = cardColors(data.merchant.brand_color);
  const fields = passFields(data);

  const pass = new PKPass({}, config.certs, {
    formatVersion: 1,
    passTypeIdentifier: config.passTypeId,
    teamIdentifier: config.teamId,
    serialNumber: data.card.serial_number,
    organizationName: data.merchant.name || config.organizationName,
    description: `${data.program.name} — ${data.merchant.name}`,
    // Avec un logo, le nom du commerce est dans l'image ; sinon on l'écrit en texte.
    ...(logo ? {} : { logoText: data.merchant.name }),
    backgroundColor: toRgbCss(colors.background),
    foregroundColor: toRgbCss(colors.foreground),
    labelColor: toRgbCss(colors.label),
    suppressStripShine: true,
    // Mise à jour automatique : l'iPhone s'enregistre auprès de notre service Web, puis récupère la carte à jour.
    webServiceURL: config.webServiceURL,
    authenticationToken: data.card.auth_token,
    // Apparition sur l'écran verrouillé à proximité des adresses (10 maximum).
    maxDistance: PROXIMITY_DISTANCE_METERS,
  });

  pass.type = "storeCard";
  pass.headerFields.push(...fields.header);
  pass.secondaryFields.push(...fields.secondary);
  pass.auxiliaryFields.push(...fields.auxiliary);
  pass.backFields.push(...fields.back);

  // QR code signé : le serveur refuse tout QR modifié ou fabriqué.
  pass.setBarcodes({
    message: signQrPayload(data.card.serial_number, qrSecret),
    format: "PKBarcodeFormatQR",
    messageEncoding: "iso-8859-1",
  });

  const nearby = data.program.proximity_message.trim() || `${data.merchant.name} est tout près : pense à ta carte !`;
  if (data.locations.length > 0) {
    pass.setLocations(
      ...data.locations.slice(0, 10).map((l) => ({ latitude: l.latitude, longitude: l.longitude, relevantText: nearby })),
    );
  }

  const icon = data.program.stamp_icon;
  for (const scale of SCALES) {
    if (logo) pass.addBuffer(`logo${suffix(scale)}.png`, await logoPng(logo, scale));
    pass.addBuffer(`icon${suffix(scale)}.png`, await renderPassIcon({ background: colors.background, foreground: colors.foreground, icon, customIcon }, scale));
    pass.addBuffer(
      `strip${suffix(scale)}.png`,
      await renderStrip(
        { stampsRequired: data.program.stamps_required, stamps: data.card.stamps, foreground: colors.foreground, icon, customIcon },
        scale,
      ),
    );
  }

  return pass.getAsBuffer();
}
