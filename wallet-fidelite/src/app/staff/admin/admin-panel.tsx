"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { AdminData } from "@/lib/admin/load";
import { STAMP_ICON_KEYS, STAMP_ICON_LABELS, STAMP_ICONS } from "@/lib/stamps/icons";

type Notice = { kind: "ok" | "error"; text: string } | null;

/** Envoie une modification au serveur et renvoie le résultat (message d'erreur lisible en cas de refus). */
async function send(url: string, method: string, body: unknown): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string; status: number }> {
  try {
    const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return { ok: true, data };
    return { ok: false, status: res.status, error: typeof data.error === "string" ? data.error : "Une erreur est survenue." };
  } catch {
    return { ok: false, status: 0, error: "Pas de connexion internet. Vérifiez votre réseau puis réessayez." };
  }
}

const input = "w-full rounded-xl border border-zinc-300 bg-white px-3 py-3 text-base dark:border-zinc-700 dark:bg-zinc-900";
const primary = "rounded-xl bg-zinc-900 px-4 py-3 font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900";
const secondary = "rounded-xl border border-zinc-300 px-4 py-3 font-medium disabled:opacity-50 dark:border-zinc-700";

function Card({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="text-lg font-semibold">{title}</h2>
      {hint && <p className="mt-1 text-sm text-zinc-500">{hint}</p>}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

function Message({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <p
      role={notice.kind === "error" ? "alert" : "status"}
      className={`rounded-xl px-4 py-3 text-sm font-medium ${notice.kind === "error" ? "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200" : "bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200"}`}
    >
      {notice.text}
    </p>
  );
}

function StampSvg({ name, className }: { name: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden
      dangerouslySetInnerHTML={{ __html: STAMP_ICONS[name] ?? STAMP_ICONS.star }} />
  );
}

// ─── Statistiques ──────────────────────────────────────────────────────────────────────────────
function Stats({ stats }: { stats: NonNullable<AdminData["stats"]> }) {
  const items: [string, number][] = [
    ["Cartes distribuées", stats.cards],
    ["Nouvelles cartes (7 jours)", stats.new_cards_7_days],
    ["Tampons aujourd'hui", stats.stamps_today],
    ["Tampons (7 jours)", stats.stamps_7_days],
    ["Récompenses données", stats.rewards_redeemed],
    ["Récompenses (7 jours)", stats.rewards_redeemed_7_days],
  ];
  return (
    <Card title="En un coup d'œil">
      <dl className="grid grid-cols-2 gap-3">
        {items.map(([label, value]) => (
          <div key={label} className="rounded-xl bg-zinc-50 p-3 dark:bg-zinc-900">
            <dd className="text-2xl font-bold tabular-nums">{value}</dd>
            <dt className="text-xs text-zinc-500">{label}</dt>
          </div>
        ))}
      </dl>
    </Card>
  );
}

// ─── Programme ─────────────────────────────────────────────────────────────────────────────────
function ProgramSection({ program, notice, setNotice }: { program: NonNullable<AdminData["program"]>; notice: Notice; setNotice: (n: Notice) => void }) {
  const router = useRouter();
  const [f, setF] = useState({
    name: program.name, stampsRequired: String(program.stamps_required), rewardLabel: program.reward_label, proximityMessage: program.proximity_message,
    isActive: program.is_active, doubleScanDelayMinutes: String(program.double_scan_delay_minutes),
  });
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await send("/api/admin/program", "PATCH", {
      programId: program.id, name: f.name, stampsRequired: Number(f.stampsRequired), rewardLabel: f.rewardLabel,
      proximityMessage: f.proximityMessage, isActive: f.isActive, doubleScanDelayMinutes: Number(f.doubleScanDelayMinutes),
    });
    setBusy(false);
    if (res.ok) {
      setNotice({ kind: "ok", text: "Enregistré. Les cartes déjà distribuées se mettent à jour." });
      router.refresh();
    } else setNotice({ kind: "error", text: res.error });
  }

  return (
    <Card title="Ma carte de fidélité" hint="Les cartes déjà installées chez vos clients se mettent à jour toutes seules.">
      <form onSubmit={save} noValidate className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm font-medium">Nom du programme
          <input className={input} value={f.name} maxLength={100} required onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">Nombre de cases (tampons pour la récompense)
          <input className={input} type="number" inputMode="numeric" min={1} max={50} required value={f.stampsRequired} onChange={(e) => setF({ ...f, stampsRequired: e.target.value })} />
          <span className="text-xs font-normal text-zinc-500">Au-delà d&apos;une vingtaine, les tampons deviennent petits sur la carte.</span>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">Récompense
          <input className={input} value={f.rewardLabel} maxLength={100} required onChange={(e) => setF({ ...f, rewardLabel: e.target.value })} placeholder="1 café offert" />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">Message affiché quand le client passe près de votre boutique (iPhone)
          <input className={input} value={f.proximityMessage} maxLength={200} onChange={(e) => setF({ ...f, proximityMessage: e.target.value })} placeholder="Un café vous attend !" />
          <span className="text-xs font-normal text-zinc-500">Sur Android, Google choisit lui-même le texte.</span>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">Délai avant de pouvoir retamponner la même carte (minutes)
          <input className={input} type="number" inputMode="numeric" min={0} max={1440} required value={f.doubleScanDelayMinutes} onChange={(e) => setF({ ...f, doubleScanDelayMinutes: e.target.value })} />
          <span className="text-xs font-normal text-zinc-500">0 pour désactiver la protection contre le double scan.</span>
        </label>
        <label className="flex items-center gap-3 text-sm font-medium">
          <input type="checkbox" className="h-5 w-5" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />
          Programme actif (décocher empêche d&apos;ajouter des tampons)
        </label>
        <Message notice={notice} />
        <button className={primary} disabled={busy}>{busy ? "Enregistrement…" : "Enregistrer"}</button>
      </form>
    </Card>
  );
}

// ─── Apparence : couleur, tampon, logo ──────────────────────────────────────────────────────────
function AppearanceSection({ merchant, program, notice, setNotice }: { merchant: AdminData["merchant"]; program: NonNullable<AdminData["program"]>; notice: Notice; setNotice: (n: Notice) => void }) {
  const router = useRouter();
  const [color, setColor] = useState(merchant.brand_color);
  const [icon, setIcon] = useState(program.stamp_icon);
  const [busy, setBusy] = useState<string | null>(null);

  async function run<T>(name: string, work: () => Promise<{ ok: boolean; error?: string }>, okText: string) {
    setBusy(name);
    const res = await work();
    setBusy(null);
    setNotice(res.ok ? { kind: "ok", text: okText } : { kind: "error", text: res.error ?? "Une erreur est survenue." });
    if (res.ok) router.refresh();
    return res as unknown as T;
  }

  const saveColor = () => run("color", () => send("/api/admin/merchant", "PATCH", { merchantId: merchant.id, brandColor: color }), "Couleur enregistrée. Les cartes se mettent à jour.");
  const pickIcon = (key: string) => {
    setIcon(key);
    return run("icon", () => send("/api/admin/program", "PATCH", { programId: program.id, stampIcon: key }), "Tampon enregistré. Les cartes se mettent à jour.");
  };

  async function upload(kind: "logo" | "stamp", file: File | undefined) {
    if (!file) return;
    const form = new FormData();
    form.set("kind", kind);
    form.set("id", kind === "logo" ? merchant.id : program.id);
    form.set("file", file);
    await run(kind, async () => {
      try {
        const res = await fetch("/api/admin/assets", { method: "POST", body: form });
        if (res.ok) return { ok: true };
        return { ok: false, error: ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Import impossible." };
      } catch {
        return { ok: false, error: "Pas de connexion internet. Vérifiez votre réseau puis réessayez." };
      }
    }, kind === "logo" ? "Logo enregistré. Les cartes se mettent à jour." : "Votre tampon est enregistré. Les cartes se mettent à jour.");
    if (kind === "stamp") setIcon("custom");
  }

  return (
    <Card title="Apparence de la carte" hint="Couleur, logo et tampon : choisissez dans la bibliothèque ou importez les vôtres.">
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Couleur de la carte</span>
        <div className="flex items-center gap-3">
          <input type="color" aria-label="Choisir la couleur" className="h-12 w-16 rounded-lg border border-zinc-300" value={color} onChange={(e) => setColor(e.target.value.toUpperCase())} />
          <input className={input} aria-label="Code de la couleur" value={color} maxLength={7} onChange={(e) => setColor(e.target.value)} placeholder="#E11D48" />
          <button type="button" className={secondary} disabled={busy !== null || !/^#[0-9a-fA-F]{6}$/.test(color)} onClick={saveColor}>{busy === "color" ? "…" : "Appliquer"}</button>
        </div>
        <span className="text-xs text-zinc-500">Le texte de la carte devient blanc ou noir automatiquement, pour rester lisible.</span>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Tampon</span>
        <div className="grid grid-cols-4 gap-2" role="group" aria-label="Choisir un tampon">
          {STAMP_ICON_KEYS.map((key) => (
            <button key={key} type="button" aria-pressed={icon === key} aria-label={STAMP_ICON_LABELS[key]} disabled={busy !== null} onClick={() => pickIcon(key)}
              className={`flex aspect-square flex-col items-center justify-center gap-1 rounded-xl border text-xs ${icon === key ? "border-zinc-900 bg-zinc-100 dark:border-white dark:bg-zinc-800" : "border-zinc-200 dark:border-zinc-800"}`}>
              <StampSvg name={key} className="h-7 w-7" />
              {STAMP_ICON_LABELS[key]}
            </button>
          ))}
          {program.stamp_icon_url && (
            <button type="button" aria-pressed={icon === "custom"} aria-label="Mon image" disabled={busy !== null} onClick={() => pickIcon("custom")}
              className={`flex aspect-square flex-col items-center justify-center gap-1 rounded-xl border text-xs ${icon === "custom" ? "border-zinc-900 bg-zinc-100 dark:border-white dark:bg-zinc-800" : "border-zinc-200 dark:border-zinc-800"}`}>
              {/* eslint-disable-next-line @next/next/no-img-element -- image du commerçant, hébergée chez nous */}
              <img src={program.stamp_icon_url} alt="" className="h-7 w-7 object-contain" />
              Mon image
            </button>
          )}
        </div>
        <label className={`${secondary} cursor-pointer text-center`}>
          {busy === "stamp" ? "Import en cours…" : "Importer mon propre tampon (PNG, JPEG ou WebP)"}
          <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="Importer mon tampon" disabled={busy !== null}
            onChange={(e) => { void upload("stamp", e.target.files?.[0]); e.target.value = ""; }} />
        </label>
        <span className="text-xs text-zinc-500">Idéal : un dessin simple, fond transparent, au moins 256 × 256 pixels, 2 Mo au maximum.</span>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Logo</span>
        {merchant.logo_url && (
          // eslint-disable-next-line @next/next/no-img-element -- image du commerçant, hébergée chez nous
          <img src={merchant.logo_url} alt="Logo actuel" className="h-20 w-20 rounded-xl border border-zinc-200 object-contain dark:border-zinc-800" />
        )}
        <label className={`${secondary} cursor-pointer text-center`}>
          {busy === "logo" ? "Import en cours…" : merchant.logo_url ? "Remplacer le logo" : "Importer mon logo (PNG, JPEG ou WebP)"}
          <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="Importer mon logo" disabled={busy !== null}
            onChange={(e) => { void upload("logo", e.target.files?.[0]); e.target.value = ""; }} />
        </label>
        <span className="text-xs text-zinc-500">Idéal : carré, au moins 660 × 660 pixels, 2 Mo au maximum. Google le découpe en rond.</span>
      </div>
      <Message notice={notice} />
    </Card>
  );
}

// ─── Adresses ──────────────────────────────────────────────────────────────────────────────────
function LocationsSection({ merchantId, locations }: { merchantId: string; locations: AdminData["locations"] }) {
  const router = useRouter();
  const [f, setF] = useState({ label: "", address: "", latitude: "", longitude: "" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await send("/api/admin/locations", "POST", {
      merchantId, label: f.label, address: f.address, latitude: Number(f.latitude.replace(",", ".")), longitude: Number(f.longitude.replace(",", ".")),
    });
    setBusy(false);
    if (res.ok) {
      setF({ label: "", address: "", latitude: "", longitude: "" });
      setNotice({ kind: "ok", text: res.data.overLimit ? "Adresse ajoutée. Attention : seules les 10 premières adresses déclenchent l'affichage sur l'écran verrouillé." : "Adresse ajoutée." });
      router.refresh();
    } else setNotice({ kind: "error", text: res.error });
  }

  async function remove(id: string) {
    setBusy(true);
    const res = await send("/api/admin/locations", "DELETE", { locationId: id });
    setBusy(false);
    setNotice(res.ok ? { kind: "ok", text: "Adresse supprimée." } : { kind: "error", text: res.error });
    if (res.ok) router.refresh();
  }

  return (
    <Card title="Mes adresses" hint="Quand un client passe près d'une de ces adresses, sa carte peut apparaître sur son écran verrouillé (10 adresses au maximum par carte).">
      {locations.length === 0 && <p className="text-sm text-zinc-500">Aucune adresse pour l&apos;instant.</p>}
      <ul className="flex flex-col gap-2">
        {locations.map((l, i) => (
          <li key={l.id} className="flex items-center justify-between gap-3 rounded-xl bg-zinc-50 p-3 text-sm dark:bg-zinc-900">
            <span>
              <strong>{l.label}</strong>{i >= 10 && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">non utilisée</span>}
              <br /><span className="text-zinc-500">{l.address || "—"} ({l.latitude}, {l.longitude})</span>
            </span>
            <button type="button" className="text-red-700 underline disabled:opacity-50" disabled={busy} onClick={() => remove(l.id)} aria-label={`Supprimer ${l.label}`}>Supprimer</button>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="flex flex-col gap-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <span className="text-sm font-medium">Ajouter une adresse</span>
        <input className={input} placeholder="Nom (ex. Boutique centre-ville)" aria-label="Nom de l'adresse" required maxLength={100} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
        <input className={input} placeholder="Adresse (facultatif)" aria-label="Adresse" maxLength={300} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
        <div className="grid grid-cols-2 gap-3">
          <input className={input} placeholder="Latitude (48.8566)" aria-label="Latitude" inputMode="decimal" required value={f.latitude} onChange={(e) => setF({ ...f, latitude: e.target.value })} />
          <input className={input} placeholder="Longitude (2.3522)" aria-label="Longitude" inputMode="decimal" required value={f.longitude} onChange={(e) => setF({ ...f, longitude: e.target.value })} />
        </div>
        <span className="text-xs text-zinc-500">Astuce : sur Google Maps, faites un clic droit (ou un appui long) sur l&apos;emplacement : les deux nombres s&apos;affichent en haut du menu.</span>
        <Message notice={notice} />
        <button className={primary} disabled={busy}>Ajouter l&apos;adresse</button>
      </form>
    </Card>
  );
}

// ─── Équipe ────────────────────────────────────────────────────────────────────────────────────
type Member = { id: string; role: "owner" | "staff"; email: string; isMe: boolean };

function TeamSection({ merchantId }: { merchantId: string }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);

  const [version, setVersion] = useState(0);
  const reload = () => setVersion((v) => v + 1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/team?merchantId=${merchantId}`);
        if (res.ok && !cancelled) setMembers(((await res.json()) as { members: Member[] }).members);
      } catch {
        /* la liste reste en « Chargement… » */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [merchantId, version]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setCreated(null);
    const res = await send("/api/admin/team", "POST", { merchantId, email });
    setBusy(false);
    if (res.ok) {
      setCreated({ email: String(res.data.email), password: String(res.data.temporaryPassword) });
      setEmail("");
      setNotice(null);
      reload();
    } else setNotice({ kind: "error", text: res.error });
  }

  async function remove(m: Member) {
    if (!confirm(`Retirer ${m.email} de l'équipe ?`)) return;
    setBusy(true);
    const res = await send("/api/admin/team", "DELETE", { memberId: m.id });
    setBusy(false);
    setNotice(res.ok ? { kind: "ok", text: "Membre retiré." } : { kind: "error", text: res.error });
    if (res.ok) reload();
  }

  return (
    <Card title="Mon équipe" hint="Chaque employé a son propre compte : le journal sait qui a tamponné quoi.">
      {members === null ? <p className="text-sm text-zinc-500">Chargement…</p> : (
        <ul className="flex flex-col gap-2">
          {members.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 rounded-xl bg-zinc-50 p-3 text-sm dark:bg-zinc-900">
              <span><strong>{m.email}</strong>{m.isMe && " (vous)"}<br /><span className="text-zinc-500">{m.role === "owner" ? "Propriétaire" : "Employé"}</span></span>
              {!m.isMe && <button type="button" className="text-red-700 underline disabled:opacity-50" disabled={busy} onClick={() => remove(m)} aria-label={`Retirer ${m.email}`}>Retirer</button>}
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="flex flex-col gap-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <span className="text-sm font-medium">Ajouter un employé</span>
        <input className={input} type="email" inputMode="email" autoComplete="off" placeholder="Adresse e-mail de l'employé" aria-label="Adresse e-mail de l'employé" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Message notice={notice} />
        <button className={primary} disabled={busy}>Créer son compte</button>
      </form>
      {created && (
        <div role="status" className="rounded-xl border-2 border-amber-400 bg-amber-50 p-4 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-50">
          <p className="font-semibold">Compte créé pour {created.email}</p>
          <p className="mt-2">Mot de passe provisoire (à lui transmettre, <strong>il ne sera plus jamais affiché</strong>) :</p>
          <p className="mt-1 select-all rounded bg-white px-3 py-2 font-mono text-lg tracking-wide text-black">{created.password}</p>
          <p className="mt-2">À sa première connexion, il devra choisir son propre mot de passe.</p>
        </div>
      )}
    </Card>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────────────────────
export function AdminPanel({ data }: { data: AdminData }) {
  const { merchant, program, locations, stats } = data;
  // Les formulaires repartent des valeurs enregistrées quand elles changent.
  const key = JSON.stringify([merchant, program]);
  // Les messages vivent ici : ils survivent au rafraîchissement qui recrée les formulaires.
  const [programNotice, setProgramNotice] = useState<Notice>(null);
  const [appearanceNotice, setAppearanceNotice] = useState<Notice>(null);
  return (
    <main className="flex flex-1 flex-col gap-5 pb-8">
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium uppercase tracking-wide text-zinc-500">Réglages</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{merchant.name}</h1>
        </div>
        <Link href="/staff" className="text-sm font-medium underline">Retour</Link>
      </header>
      {stats && <Stats stats={stats} />}
      {program && <ProgramSection key={`p-${key}`} program={program} notice={programNotice} setNotice={setProgramNotice} />}
      {program && <AppearanceSection key={`a-${key}`} merchant={merchant} program={program} notice={appearanceNotice} setNotice={setAppearanceNotice} />}
      <LocationsSection merchantId={merchant.id} locations={locations} />
      <TeamSection merchantId={merchant.id} />
    </main>
  );
}
