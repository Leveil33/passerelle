import type { MetadataRoute } from "next";

// Rend l'appli commerçant installable sur l'écran d'accueil (Android : « Installer l'application » ;
// iPhone : Partager → « Sur l'écran d'accueil »).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Fidélité — Commerçant",
    short_name: "Fidélité",
    description: "Scanner les cartes de fidélité de vos clients.",
    lang: "fr",
    start_url: "/staff",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#111827",
    theme_color: "#111827",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
