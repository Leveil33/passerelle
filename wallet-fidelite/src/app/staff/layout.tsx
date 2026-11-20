import type { Metadata, Viewport } from "next";
import { ServiceWorkerRegister } from "./service-worker-register";

export const metadata: Metadata = {
  title: "Fidélité — Commerçant",
  description: "Scanner les cartes de fidélité de vos clients.",
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: "Fidélité", statusBarStyle: "black-translucent" },
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = { themeColor: "#111827", width: "device-width", initialScale: 1, maximumScale: 1 };

export default function StaffLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col bg-white px-4 py-6 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
      <ServiceWorkerRegister />
      {children}
    </div>
  );
}
