"use client";

import { useEffect } from "react";

/** Enregistre le service worker : c'est ce qui permet d'installer l'appli sur l'écran d'accueil. */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        /* sans service worker, l'appli fonctionne quand même (mais ne s'installe pas) */
      });
    }
  }, []);
  return null;
}
