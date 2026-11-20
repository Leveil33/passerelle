// Traduit les refus renvoyés par les fonctions de tampon de la base (voir
// supabase/migrations) en messages clairs pour l'employé, avec le bon code HTTP.

export type LoyaltyErrorCode =
  | "not_authenticated"
  | "card_not_found"
  | "program_inactive"
  | "card_full"
  | "card_not_full"
  | "double_scan"
  | "nothing_to_undo"
  | "undo_expired"
  | "unknown";

export type LoyaltyError = {
  code: LoyaltyErrorCode;
  /** Code HTTP à renvoyer par l'API. */
  status: number;
  /** Message en français, affichable tel quel à l'écran. */
  message: string;
  /** Pour double_scan : secondes à attendre avant de pouvoir retamponner. */
  retryAfterSeconds?: number;
};

/** Forme minimale d'une erreur Supabase / Postgres. */
export type DbErrorLike = { message?: string | null; details?: string | null; detail?: string | null };

function formatDelay(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  return `${Math.ceil(seconds / 60)} min`;
}

const FIXED: Record<Exclude<LoyaltyErrorCode, "double_scan" | "unknown">, { status: number; message: string }> = {
  not_authenticated: { status: 401, message: "Session expirée : reconnectez-vous puis réessayez." },
  card_not_found: { status: 404, message: "Carte introuvable pour votre commerce." },
  program_inactive: {
    status: 422,
    message: "Ce programme de fidélité est désactivé : impossible d'ajouter un tampon.",
  },
  card_full: { status: 409, message: "La carte est pleine : validez d'abord la récompense." },
  card_not_full: {
    status: 409,
    message: "La carte n'est pas encore pleine : la récompense n'est pas disponible.",
  },
  nothing_to_undo: { status: 409, message: "Il n'y a aucun tampon à annuler." },
  undo_expired: {
    status: 409,
    message: "Trop tard : un tampon ne peut être annulé que pendant les 2 minutes qui suivent.",
  },
};

export function parseLoyaltyError(error: DbErrorLike | null | undefined): LoyaltyError {
  const code = (error?.message ?? "").trim();

  if (code === "double_scan") {
    const parsed = Number.parseInt(error?.details ?? error?.detail ?? "", 10);
    const retryAfterSeconds = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    return {
      code: "double_scan",
      status: 409,
      message: retryAfterSeconds
        ? `Cette carte vient déjà d'être tamponnée. Réessayez dans ${formatDelay(retryAfterSeconds)}.`
        : "Cette carte vient déjà d'être tamponnée. Réessayez un peu plus tard.",
      retryAfterSeconds,
    };
  }

  // Object.hasOwn : « constructor », « toString »… ne doivent pas passer pour des codes connus.
  if (Object.hasOwn(FIXED, code)) {
    const known = code as keyof typeof FIXED;
    return { code: known, ...FIXED[known] };
  }

  // Erreur inattendue : on ne montre jamais le détail technique à l'employé.
  return { code: "unknown", status: 500, message: "Une erreur est survenue. Réessayez dans un instant." };
}
