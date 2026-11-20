import { describe, expect, it } from "vitest";
import { StoreError, createSupabaseWalletStore } from "@/lib/wallet/store";

type Call = { fn: string; args: Record<string, unknown> };

/** Faux client Supabase : enregistre les appels et renvoie la réponse prévue. */
function fakeClient(reply: (fn: string) => { data?: unknown; error?: { message: string; code?: string; details?: string } }) {
  const calls: Call[] = [];
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      const r = reply(fn);
      return { data: r.data ?? null, error: r.error ?? null };
    },
  };
  return { calls, store: createSupabaseWalletStore(client as never) };
}

describe("accès à la vraie base (noms de fonctions et de paramètres)", () => {
  // Ces noms doivent correspondre EXACTEMENT à ceux de supabase/migrations (testés dans tests/db).
  it("appelle chaque fonction SQL avec les bons paramètres", async () => {
    const { calls, store } = fakeClient((fn) => ({
      data: fn === "rate_limit_hit" ? true : fn === "create_card" ? { card_id: "c1", serial_number: "s1" } : fn.endsWith("_serials") || fn.endsWith("_targets") ? [] : "ok",
    }));

    await store.rateLimit("k", 60, 5);
    await store.register("s", "t", "d", "p");
    await store.unregister("s", "t", "d");
    await store.updatedSerials("d", "2026-11-20T00:00:00.000000Z");
    await store.pushTargets("s");
    await store.forgetPushToken("p");
    await store.createCard({ programId: "prog", firstName: "Léa", email: "l@x.fr", emailConsent: true, marketingConsent: true });

    expect(calls).toEqual([
      { fn: "rate_limit_hit", args: { p_key: "k", p_window_seconds: 60, p_max: 5 } },
      { fn: "apple_register_device", args: { p_serial: "s", p_auth_token: "t", p_device_library_id: "d", p_push_token: "p" } },
      { fn: "apple_unregister_device", args: { p_serial: "s", p_auth_token: "t", p_device_library_id: "d" } },
      { fn: "apple_updated_serials", args: { p_device_library_id: "d", p_since: "2026-11-20T00:00:00.000000Z" } },
      { fn: "apple_push_targets", args: { p_serial: "s" } },
      { fn: "apple_forget_push_token", args: { p_push_token: "p" } },
      { fn: "create_card", args: { p_program_id: "prog", p_first_name: "Léa", p_email: "l@x.fr", p_email_consent: true, p_marketing_consent: true } },
    ]);
  });

  it("par défaut, aucun consentement n'est transmis comme donné", async () => {
    const { calls, store } = fakeClient(() => ({ data: { card_id: "c", serial_number: "s" } }));
    await store.createCard({ programId: "p", firstName: "A" });
    expect(calls[0].args).toMatchObject({ p_email: null, p_email_consent: false, p_marketing_consent: false });
  });

  it("met les dates de Postgres au format des repères Apple", async () => {
    const { store } = fakeClient(() => ({
      data: [
        { serial_number: "a", updated_at: "2026-11-20T00:56:09.488123+00:00" },
        { serial_number: "b", updated_at: "2026-11-20T00:56:10+00:00" },
      ],
    }));
    expect(await store.updatedSerials("d", null)).toEqual([
      { serialNumber: "a", updatedAt: "2026-11-20T00:56:09.488123Z" },
      { serialNumber: "b", updatedAt: "2026-11-20T00:56:10.000000Z" },
    ]);
  });

  it("transforme les données d'une carte (date normalisée) ou renvoie null", async () => {
    const valid = {
      card: { id: "c", serial_number: "s", auth_token: "t", stamps: 1, rewards_earned: 0, platform: null, updated_at: "2026-11-20T00:56:09.4881+00:00" },
      customer: { first_name: "Léa" },
      program: { id: "p", name: "N", stamps_required: 5, reward_label: "R", proximity_message: "", is_active: true, stamp_icon: "star", stamp_icon_url: null },
      merchant: { id: "m", name: "M", logo_url: null, brand_color: "#1F2937" },
      locations: [],
    };
    expect((await fakeClient(() => ({ data: valid })).store.passData("s"))?.card.updated_at).toBe("2026-11-20T00:56:09.488100Z");
    expect(await fakeClient(() => ({ data: null })).store.passData("inconnu")).toBeNull();
    await expect(fakeClient(() => ({ data: { card: {} } })).store.passData("s")).rejects.toThrow(/invalides/);
  });

  it("transforme une erreur de la base en StoreError (code lisible conservé, sans fuite ailleurs)", async () => {
    const { store } = fakeClient(() => ({ error: { message: "program_inactive", code: "PT422", details: "x" } }));
    const err = await store.createCard({ programId: "p", firstName: "A" }).catch((e) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(err).toMatchObject({ message: "program_inactive", code: "PT422", details: "x" });
  });
});
