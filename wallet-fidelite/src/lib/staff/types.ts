// Ce que l'appli du commerçant affiche pour une carte scannée.

export type CardState = {
  cardId: string;
  firstName: string;
  programName: string;
  stamps: number;
  stampsRequired: number;
  rewardsEarned: number;
  rewardLabel: string;
  rewardAvailable: boolean;
  /** false si le programme est désactivé : plus de tampon possible (la récompense reste valable). */
  programActive: boolean;
  /** Secondes pendant lesquelles le dernier tampon peut encore être annulé (0 = plus possible). */
  undoSecondsLeft: number;
  /** Secondes à attendre avant de pouvoir retamponner (anti double scan, 0 = tout de suite). */
  stampBlockedSeconds: number;
};

export type CardAction = "stamp" | "redeem" | "undo";

/** Fenêtre d'annulation du dernier tampon : la même que dans la fonction SQL undo_last_stamp (2 minutes). */
export const UNDO_WINDOW_SECONDS = 120;

export type ApiError = { error: string; code: string; retryAfterSeconds?: number };
