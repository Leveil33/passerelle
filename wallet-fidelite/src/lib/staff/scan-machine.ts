// Les « étapes » de l'écran de scan, sans aucun code d'interface : ce qui est affiché à chaque moment.
import type { CardAction, CardState } from "./types";

export type Notice = { kind: "success" | "error"; text: string };

export type ScanState =
  | { step: "scanning"; message: string | null; cameraError: boolean }
  | { step: "loading" }
  | {
      step: "card";
      card: CardState;
      /** Action en cours d'envoi (les boutons sont alors bloqués). */
      busy: CardAction | null;
      notice: Notice | null;
      /** Instants (ms) jusqu'auxquels l'annulation / le prochain tampon restent bloqués ou possibles. */
      undoUntil: number | null;
      blockedUntil: number | null;
    };

export const initialScanState: ScanState = { step: "scanning", message: null, cameraError: false };

export type ScanAction =
  | { type: "codeRead" }
  | { type: "cardLoaded"; card: CardState; now: number }
  | { type: "scanFailed"; message: string }
  | { type: "cameraFailed" }
  | { type: "actionStarted"; action: CardAction }
  | { type: "actionDone"; action: CardAction; card: CardState; now: number }
  | { type: "actionFailed"; message: string }
  | { type: "restart" };

const deadline = (seconds: number, now: number) => (seconds > 0 ? now + seconds * 1000 : null);

export function successText(action: CardAction, card: CardState): string {
  if (action === "stamp") {
    return card.rewardAvailable
      ? `Carte pleine ! ${card.firstName} a droit à : ${card.rewardLabel}.`
      : `Tampon ajouté à ${card.firstName} : ${card.stamps} / ${card.stampsRequired}.`;
  }
  if (action === "redeem") return `Récompense validée pour ${card.firstName}. La carte repart à 0.`;
  return `Dernier tampon annulé : ${card.stamps} / ${card.stampsRequired}.`;
}

export function scanReducer(state: ScanState, action: ScanAction): ScanState {
  switch (action.type) {
    case "codeRead":
      return { step: "loading" };
    case "cardLoaded":
      return {
        step: "card",
        card: action.card,
        busy: null,
        notice: null,
        undoUntil: deadline(action.card.undoSecondsLeft, action.now),
        blockedUntil: deadline(action.card.stampBlockedSeconds, action.now),
      };
    case "scanFailed":
      return { step: "scanning", message: action.message, cameraError: false };
    case "cameraFailed":
      return { step: "scanning", message: null, cameraError: true };
    case "actionStarted":
      return state.step === "card" ? { ...state, busy: action.action, notice: null } : state;
    case "actionDone":
      return state.step === "card"
        ? {
            step: "card",
            card: action.card,
            busy: null,
            notice: { kind: "success", text: successText(action.action, action.card) },
            undoUntil: deadline(action.card.undoSecondsLeft, action.now),
            blockedUntil: deadline(action.card.stampBlockedSeconds, action.now),
          }
        : state;
    case "actionFailed":
      return state.step === "card" ? { ...state, busy: null, notice: { kind: "error", text: action.message } } : state;
    case "restart":
      return initialScanState;
  }
}

/** Secondes restantes avant l'instant `until` (0 s'il est passé ou absent). */
export function secondsLeft(until: number | null, now: number): number {
  return until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000));
}

export function canStamp(state: Extract<ScanState, { step: "card" }>, now: number): boolean {
  return state.card.programActive && !state.card.rewardAvailable && state.busy === null && secondsLeft(state.blockedUntil, now) === 0;
}
export const canRedeem = (state: Extract<ScanState, { step: "card" }>) => state.card.rewardAvailable && state.busy === null;
export const canUndo = (state: Extract<ScanState, { step: "card" }>, now: number) => state.busy === null && secondsLeft(state.undoUntil, now) > 0;

/** « 1 min 05 s » / « 45 s » */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`;
}
