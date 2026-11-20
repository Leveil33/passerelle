import { describe, expect, it } from "vitest";
import {
  canRedeem, canStamp, canUndo, formatDuration, initialScanState, scanReducer, secondsLeft, successText,
  type ScanState,
} from "./scan-machine";
import type { CardState } from "./types";

const card = (over: Partial<CardState> = {}): CardState => ({
  cardId: "c1", firstName: "Léa", programName: "Carte café", stamps: 3, stampsRequired: 10, rewardsEarned: 0,
  rewardLabel: "1 café offert", rewardAvailable: false, programActive: true, undoSecondsLeft: 0, stampBlockedSeconds: 0, ...over,
});
type CardStep = Extract<ScanState, { step: "card" }>;
const loaded = (over: Partial<CardState> = {}, now = 1000): CardStep => scanReducer(initialScanState, { type: "cardLoaded", card: card(over), now }) as CardStep;

describe("étapes de l'écran de scan", () => {
  it("démarre en lecture, passe en chargement dès qu'un code est lu", () => {
    expect(initialScanState).toMatchObject({ step: "scanning", message: null, cameraError: false });
    expect(scanReducer(initialScanState, { type: "codeRead" })).toEqual({ step: "loading" });
  });

  it("affiche la carte une fois chargée, avec les délais d'annulation et d'attente", () => {
    const s = loaded({ undoSecondsLeft: 100, stampBlockedSeconds: 500 }, 1000);
    expect(s).toMatchObject({ step: "card", busy: null, notice: null, undoUntil: 101_000, blockedUntil: 501_000 });
    expect(loaded().undoUntil).toBeNull();
    expect(loaded().blockedUntil).toBeNull();
  });

  it("une lecture ratée revient au scan avec le message, une caméra en panne le signale", () => {
    expect(scanReducer({ step: "loading" }, { type: "scanFailed", message: "QR inconnu" })).toEqual({ step: "scanning", message: "QR inconnu", cameraError: false });
    expect(scanReducer(initialScanState, { type: "cameraFailed" })).toMatchObject({ step: "scanning", cameraError: true });
  });

  it("pendant une action, les boutons sont bloqués ; en cas d'échec, un message d'erreur reste affiché", () => {
    const busy = scanReducer(loaded(), { type: "actionStarted", action: "stamp" }) as CardStep;
    expect(busy.busy).toBe("stamp");
    expect(canStamp(busy, 0)).toBe(false);
    expect(canRedeem(busy)).toBe(false);
    const failed = scanReducer(busy, { type: "actionFailed", message: "Trop tôt" }) as CardStep;
    expect(failed).toMatchObject({ busy: null, notice: { kind: "error", text: "Trop tôt" } });
    expect(failed.card).toEqual(busy.card);
  });

  it("une action réussie remplace la carte, annonce le résultat et relance l'annulation de 2 minutes", () => {
    const done = scanReducer(loaded(), { type: "actionDone", action: "stamp", card: card({ stamps: 4, undoSecondsLeft: 120, stampBlockedSeconds: 600 }), now: 5000 }) as CardStep;
    expect(done.card.stamps).toBe(4);
    expect(done.notice).toEqual({ kind: "success", text: "Tampon ajouté à Léa : 4 / 10." });
    expect(done.undoUntil).toBe(125_000);
    expect(done.blockedUntil).toBe(605_000);
  });

  it("les actions arrivant hors de l'écran « carte » sont ignorées", () => {
    for (const a of [{ type: "actionStarted", action: "stamp" }, { type: "actionFailed", message: "x" }] as const) {
      expect(scanReducer(initialScanState, a)).toBe(initialScanState);
    }
    expect(scanReducer({ step: "loading" }, { type: "actionDone", action: "stamp", card: card(), now: 0 })).toEqual({ step: "loading" });
  });

  it("« scanner une autre carte » repart de zéro", () => {
    expect(scanReducer(loaded(), { type: "restart" })).toEqual(initialScanState);
  });
});

describe("boutons disponibles", () => {
  it("+1 tampon : seulement si le programme est actif, la carte pas pleine et aucune attente", () => {
    expect(canStamp(loaded(), 0)).toBe(true);
    expect(canStamp(loaded({ programActive: false }), 0)).toBe(false);
    expect(canStamp(loaded({ stamps: 10, rewardAvailable: true }), 0)).toBe(false);
    const waiting = loaded({ stampBlockedSeconds: 60 }, 1000);
    expect(canStamp(waiting, 1000)).toBe(false);
    expect(canStamp(waiting, 1000 + 59_000)).toBe(false);
    expect(canStamp(waiting, 1000 + 60_000)).toBe(true);
  });

  it("récompense : seulement quand la carte est pleine (même si le programme est désactivé)", () => {
    expect(canRedeem(loaded())).toBe(false);
    expect(canRedeem(loaded({ stamps: 10, rewardAvailable: true }))).toBe(true);
    expect(canRedeem(loaded({ stamps: 10, rewardAvailable: true, programActive: false }))).toBe(true);
  });

  it("annulation : possible 2 minutes après un tampon, plus ensuite", () => {
    const s = loaded({ undoSecondsLeft: 120 }, 0);
    expect(canUndo(s, 0)).toBe(true);
    expect(canUndo(s, 119_000)).toBe(true);
    expect(canUndo(s, 120_000)).toBe(false);
    expect(canUndo(loaded(), 0)).toBe(false);
  });
});

describe("textes", () => {
  it("décompte et durées", () => {
    expect(secondsLeft(null, 0)).toBe(0);
    expect(secondsLeft(10_500, 10_000)).toBe(1);
    expect(secondsLeft(10_000, 20_000)).toBe(0);
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(65)).toBe("1 min 05 s");
    expect(formatDuration(600)).toBe("10 min 00 s");
  });

  it("messages de réussite", () => {
    expect(successText("stamp", card({ stamps: 10, rewardAvailable: true }))).toContain("Carte pleine");
    expect(successText("redeem", card())).toContain("repart à 0");
    expect(successText("undo", card({ stamps: 2 }))).toBe("Dernier tampon annulé : 2 / 10.");
  });
});
