"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  canRedeem, canStamp, canUndo, formatDuration, initialScanState, scanReducer, secondsLeft,
} from "@/lib/staff/scan-machine";
import type { ApiError, CardAction, CardState } from "@/lib/staff/types";

const READER_ID = "lecteur-qr";

/** Fait vibrer le téléphone (ignoré s'il ne sait pas). */
const buzz = (pattern: number | number[]) => {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* sans effet */
  }
};

async function call(url: string, body: unknown): Promise<{ ok: true; data: CardState } | { ok: false; status: number; error: ApiError }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    if (res.ok && data) return { ok: true, data: data as CardState };
    return { ok: false, status: res.status, error: (data as ApiError) ?? { error: "Une erreur est survenue.", code: "unknown" } };
  } catch {
    return { ok: false, status: 0, error: { error: "Pas de connexion internet. Vérifiez votre réseau puis réessayez.", code: "offline" } };
  }
}

export function Scanner() {
  const router = useRouter();
  const [state, dispatch] = useReducer(scanReducer, initialScanState);
  const [now, setNow] = useState(() => Date.now());
  const handled = useRef(false);
  const [manual, setManual] = useState("");

  // Horloge pour les comptes à rebours (annulation, attente avant le prochain tampon).
  useEffect(() => {
    if (state.step !== "card") return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [state.step]);

  const onCode = useCallback(
    async (code: string) => {
      if (handled.current) return;
      handled.current = true;
      dispatch({ type: "codeRead" });
      const res = await call("/api/scan", { code });
      if (res.ok) {
        buzz(80);
        setNow(Date.now());
        dispatch({ type: "cardLoaded", card: res.data, now: Date.now() });
      } else if (res.status === 401) {
        router.replace("/staff/login");
      } else {
        buzz([100, 60, 100]);
        handled.current = false;
        dispatch({ type: "scanFailed", message: res.error.error });
      }
    },
    [router],
  );

  // Caméra : démarre quand on est en attente d'une carte, s'arrête sinon.
  const scanning = state.step === "scanning" && !state.cameraError;
  useEffect(() => {
    if (!scanning) return;
    let stopped = false;
    let scanner: import("html5-qrcode").Html5Qrcode | null = null;
    (async () => {
      try {
        const { Html5Qrcode } = await import("html5-qrcode");
        if (stopped) return;
        scanner = new Html5Qrcode(READER_ID, { verbose: false });
        await scanner.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 240, height: 240 } }, (text) => void onCode(text), () => {});
      } catch {
        if (!stopped) dispatch({ type: "cameraFailed" });
      }
    })();
    return () => {
      stopped = true;
      const s = scanner;
      if (s) s.stop().then(() => s.clear()).catch(() => {});
    };
  }, [scanning, onCode]);

  async function act(action: CardAction) {
    if (state.step !== "card") return;
    dispatch({ type: "actionStarted", action });
    const res = await call(`/api/cards/${state.card.cardId}/${action}`, {});
    if (res.ok) {
      buzz(action === "undo" ? 60 : 200);
      setNow(Date.now());
      dispatch({ type: "actionDone", action, card: res.data, now: Date.now() });
    } else if (res.status === 401) {
      router.replace("/staff/login");
    } else {
      buzz([100, 60, 100]);
      dispatch({ type: "actionFailed", message: res.error.error });
    }
  }

  function restart() {
    handled.current = false;
    dispatch({ type: "restart" });
  }

  const big = "w-full rounded-2xl px-6 py-6 text-xl font-bold disabled:opacity-40";

  if (state.step === "card") {
    const { card } = state;
    const blocked = secondsLeft(state.blockedUntil, now);
    const undo = secondsLeft(state.undoUntil, now);
    return (
      <main className="flex flex-1 flex-col gap-5">
        <header className="text-center">
          <p className="text-sm text-zinc-500">{card.programName}</p>
          <h1 className="mt-1 text-3xl font-semibold">{card.firstName}</h1>
          <p className="mt-3 text-6xl font-bold tabular-nums" aria-label={`${card.stamps} tampons sur ${card.stampsRequired}`}>
            {card.stamps} / {card.stampsRequired}
          </p>
          <p className="mt-2 text-sm text-zinc-500">
            {card.rewardsEarned} récompense{card.rewardsEarned > 1 ? "s" : ""} déjà obtenue{card.rewardsEarned > 1 ? "s" : ""}
          </p>
        </header>

        {state.notice && (
          <p
            role={state.notice.kind === "error" ? "alert" : "status"}
            className={`rounded-xl px-4 py-3 text-center font-medium ${state.notice.kind === "error" ? "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200" : "bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200"}`}
          >
            {state.notice.text}
          </p>
        )}

        {card.rewardAvailable && (
          <p className="rounded-xl bg-amber-50 px-4 py-4 text-center text-lg font-semibold text-amber-900 dark:bg-amber-950 dark:text-amber-100">
            Récompense disponible : {card.rewardLabel}
          </p>
        )}
        {!card.programActive && !card.rewardAvailable && (
          <p className="rounded-xl bg-zinc-100 px-4 py-3 text-center dark:bg-zinc-900">Ce programme est désactivé : plus de tampon possible.</p>
        )}
        {blocked > 0 && !card.rewardAvailable && (
          <p className="rounded-xl bg-zinc-100 px-4 py-3 text-center dark:bg-zinc-900">
            Déjà tamponnée à l&apos;instant. Prochain tampon possible dans {formatDuration(blocked)}.
          </p>
        )}

        {card.rewardAvailable ? (
          <button className={`${big} bg-amber-500 text-black`} disabled={!canRedeem(state)} onClick={() => act("redeem")}>
            {state.busy === "redeem" ? "Validation…" : "Valider la récompense"}
          </button>
        ) : (
          <button className={`${big} bg-green-600 text-white active:bg-green-700`} disabled={!canStamp(state, now)} onClick={() => act("stamp")}>
            {state.busy === "stamp" ? "Ajout…" : "+ 1 tampon"}
          </button>
        )}

        {canUndo(state, now) && (
          <button className="w-full rounded-xl border border-zinc-300 px-4 py-4 font-medium disabled:opacity-40 dark:border-zinc-700" disabled={state.busy !== null} onClick={() => act("undo")}>
            {state.busy === "undo" ? "Annulation…" : `Annuler le dernier tampon (${formatDuration(undo)})`}
          </button>
        )}

        <button className="mt-auto w-full rounded-xl bg-zinc-900 px-4 py-4 text-lg font-semibold text-white dark:bg-white dark:text-zinc-900" onClick={restart}>
          Scanner une autre carte
        </button>
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col gap-5">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Scanner une carte</h1>
        <Link href="/staff" className="text-sm font-medium underline">
          Retour
        </Link>
      </header>

      {state.step === "loading" && <p role="status" className="py-10 text-center text-lg text-zinc-500">Lecture de la carte…</p>}

      {state.step === "scanning" && (
        <>
          {state.message && (
            <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-red-800 dark:bg-red-950 dark:text-red-200">
              {state.message}
            </p>
          )}
          {state.cameraError ? (
            <p role="alert" className="rounded-xl bg-amber-50 px-4 py-3 text-amber-900 dark:bg-amber-950 dark:text-amber-100">
              La caméra n&apos;est pas accessible. Autorisez-la dans les réglages du navigateur, ou saisissez le code ci-dessous.
            </p>
          ) : (
            <div id={READER_ID} className="overflow-hidden rounded-2xl bg-black" style={{ minHeight: 280 }} />
          )}
          <details open={state.cameraError} className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
            <summary className="cursor-pointer font-medium">La caméra ne marche pas ?</summary>
            <form
              className="mt-3 flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (manual.trim()) void onCode(manual.trim());
              }}
            >
              <label className="flex flex-col gap-1 text-sm">
                Code de la carte (WL1.…)
                <input className="rounded-xl border border-zinc-300 bg-white px-3 py-3 dark:border-zinc-700 dark:bg-zinc-900" value={manual} onChange={(e) => setManual(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
              </label>
              <button className="rounded-xl bg-zinc-900 px-4 py-3 font-semibold text-white dark:bg-white dark:text-zinc-900">Valider le code</button>
            </form>
          </details>
        </>
      )}
    </main>
  );
}
