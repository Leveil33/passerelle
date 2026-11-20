// Petits outils communs aux adresses publiques.
import { timingSafeEqual } from "node:crypto";

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

/** Adresse IP de l'appelant (derrière Vercel : premier élément de x-forwarded-for). */
export function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (forwarded || req.headers.get("x-real-ip")?.trim() || "inconnue").slice(0, 80);
}

/** Comparaison de deux textes en temps constant (évite de deviner un secret caractère par caractère). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Extrait le secret de « Authorization: ApplePass <secret> ». */
export function applePassToken(req: Request): string | null {
  const m = /^ApplePass\s+(\S{1,200})$/.exec(req.headers.get("authorization") ?? "");
  return m ? m[1] : null;
}

export async function readJson(req: Request, maxBytes = 16_384): Promise<unknown | undefined> {
  try {
    const text = await req.text();
    if (text.length > maxBytes) return undefined;
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
