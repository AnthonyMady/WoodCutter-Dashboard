// Refresh Worker entry point. Cron Triggers fire `scheduled` events.
// Each cron decides which sources to refresh, fans out, rebuilds aggregated KV payloads.

import {
  ALL_VENUES,
  KV_KEYS,
  ODOO_COMPANIES,
  assertSafeKvKey,
  type AdsRow,
  type OdooInvoiceRow,
  type OdooPosRow,
  type SourceFreshness,
  type SourceId,
  type StripeRow,
  type Venue,
  type VivaRow,
  type PartialReason,
} from "@woodcutter/shared";

import { fetchAllStripe } from "./sources/stripe.ts";
import { fetchAllOdoo, type OdooEnv } from "./sources/odoo.ts";
import { fetchAllViva } from "./sources/viva.ts";
import { fetchAllSupermetrics } from "./sources/supermetrics.ts";
import { buildRevenue, buildMarketing, buildDigest, type AggregateInput } from "./aggregate.ts";

export interface Env {
  KV: KVNamespace;

  // Vars (declared in wrangler.toml [vars])
  ODOO_URL: string;
  ODOO_DB: string;
  ODOO_USER: string;

  // Stripe secrets
  STRIPE_KEY_BRUSSELS: string;
  STRIPE_KEY_BERLIN: string;
  STRIPE_KEY_FRANKFURT: string;
  STRIPE_KEY_HAMBURG: string;
  STRIPE_KEY_BONN: string;
  STRIPE_KEY_KOLN: string;
  STRIPE_KEY_LEIPZIG: string;
  STRIPE_KEY_SHOOTERS_BRUSSELS: string;

  // Odoo secrets
  ODOO_KEY_BELGIUM: string;
  ODOO_KEY_BERLIN: string;
  ODOO_KEY_FRANKFURT: string;
  ODOO_KEY_HAMBURG: string;
  ODOO_KEY_KOLN: string;
  ODOO_KEY_LEIPZIG: string;

  // Viva
  VIVAWALLET_MERCHANT_ID: string;
  VIVAWALLET_KEY: string;
  VIVA_CITY_MAP?: string;

  // Supermetrics
  SUPERMETRICS_API_KEY: string;
  SUPERMETRICS_USER?: string;
  GOOGLE_ADS_ACCOUNT_IDS: string;
  META_ADS_ACCOUNT_IDS: string;
  META_ADS_USER_ID?: string;
}

export default {
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const now = new Date(controller.scheduledTime);
    log(`[refresh] daily run at=${now.toISOString()}`);
    try {
      // All sources refresh together once a day. Fan out in parallel; per-source
      // failures don't kill the others (handled inside each refresh* function).
      await Promise.allSettled([
        refreshStripe(env, now),
        refreshOdooViva(env, now),
        refreshSupermetrics(env, now),
      ]);
    } catch (err) {
      log(`[refresh] FATAL ${scrub(String(err))}`);
      throw err;
    }
  },

  async fetch(_req: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    return new Response("not exposed; trigger via cron", { status: 403 });
  },
};

// ──────────────────────────── orchestration ─────────────────────────────

async function refreshStripe(env: Env, now: Date): Promise<void> {
  const jan1 = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const since = Math.floor(jan1.getTime() / 1000);
  const until = Math.floor(now.getTime() / 1000);

  const fresh = await readFreshness(env);

  const result = await fetchAllStripe(env as unknown as Record<string, string>, since, until);
  const partial: PartialReason[] = result.errors.map((e) => ({
    source: "stripe",
    venue: e.venue,
    reason: e.error,
  }));

  for (const [venue, rows] of result.rowsByVenue) {
    const key = KV_KEYS.stripeSlice(venue, now.getUTCFullYear());
    assertSafeKvKey(key);
    await env.KV.put(key, JSON.stringify(rows), { expirationTtl: 7 * 24 * 3600 });
  }
  if (result.errors.length === 0) {
    fresh.stripe = { okAt: now.toISOString(), errorAt: null };
  } else if (result.rowsByVenue.size > 0) {
    fresh.stripe = {
      okAt: now.toISOString(),
      errorAt: now.toISOString(),
      error: `partial: ${result.errors.length} of ${ALL_VENUES.length - 1} venues failed`,
    };
  } else {
    fresh.stripe = {
      okAt: fresh.stripe?.okAt ?? null,
      errorAt: now.toISOString(),
      error: result.errors[0]?.error ?? "all stripe fetches failed",
    };
  }
  await writeFreshness(env, fresh);
  log(`[refresh] stripe ok=${result.rowsByVenue.size} err=${result.errors.length}`);

  await rebuildAggregated(env, now, fresh, partial);
}

async function refreshOdooViva(env: Env, now: Date): Promise<void> {
  const jan1 = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const fresh = await readFreshness(env);
  const partial: PartialReason[] = [];

  // Odoo
  try {
    const odoo = await fetchAllOdoo(env as unknown as OdooEnv, jan1, now);
    for (const [venue, rows] of odoo.posRowsByVenue) {
      const key = KV_KEYS.odooPosSlice(venue, now.getUTCFullYear());
      assertSafeKvKey(key);
      await env.KV.put(key, JSON.stringify(rows), { expirationTtl: 7 * 24 * 3600 });
    }
    for (const [venue, rows] of odoo.invoiceRowsByVenue) {
      const key = KV_KEYS.odooInvoicesSlice(venue, now.getUTCFullYear());
      assertSafeKvKey(key);
      await env.KV.put(key, JSON.stringify(rows), { expirationTtl: 7 * 24 * 3600 });
    }
    for (const e of odoo.errors) {
      partial.push({
        source: e.phase === "pos" ? "odoo_pos" : "odoo_invoices",
        venue: e.venue,
        reason: e.error,
      });
    }
    if (odoo.errors.length === 0) {
      fresh.odoo_pos = { okAt: now.toISOString(), errorAt: null };
      fresh.odoo_invoices = { okAt: now.toISOString(), errorAt: null };
    } else {
      fresh.odoo_pos = {
        okAt: odoo.posRowsByVenue.size > 0 ? now.toISOString() : fresh.odoo_pos?.okAt ?? null,
        errorAt: now.toISOString(),
        error: `partial: ${odoo.errors.filter((e) => e.phase === "pos").length} POS errors`,
      };
      fresh.odoo_invoices = {
        okAt: odoo.invoiceRowsByVenue.size > 0 ? now.toISOString() : fresh.odoo_invoices?.okAt ?? null,
        errorAt: now.toISOString(),
        error: `partial: ${odoo.errors.filter((e) => e.phase === "invoices").length} invoice errors`,
      };
    }
    log(`[refresh] odoo pos=${odoo.posRowsByVenue.size} inv=${odoo.invoiceRowsByVenue.size} err=${odoo.errors.length}`);
  } catch (err) {
    fresh.odoo_pos = {
      okAt: fresh.odoo_pos?.okAt ?? null,
      errorAt: now.toISOString(),
      error: scrub(String(err)),
    };
    fresh.odoo_invoices = {
      okAt: fresh.odoo_invoices?.okAt ?? null,
      errorAt: now.toISOString(),
      error: scrub(String(err)),
    };
    partial.push({ source: "odoo_pos", reason: scrub(String(err)) });
  }

  // Viva
  try {
    const vivaRows = await fetchAllViva(env, jan1, now);
    const key = KV_KEYS.vivaSlice(now.getUTCFullYear());
    assertSafeKvKey(key);
    await env.KV.put(key, JSON.stringify(vivaRows), { expirationTtl: 7 * 24 * 3600 });
    fresh.viva = { okAt: now.toISOString(), errorAt: null };
    log(`[refresh] viva rows=${vivaRows.length}`);
  } catch (err) {
    fresh.viva = {
      okAt: fresh.viva?.okAt ?? null,
      errorAt: now.toISOString(),
      error: scrub(String(err)),
    };
    partial.push({ source: "viva", reason: scrub(String(err)) });
  }

  await writeFreshness(env, fresh);
  await rebuildAggregated(env, now, fresh, partial);
}

async function refreshSupermetrics(env: Env, now: Date): Promise<void> {
  const jan1 = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const fresh = await readFreshness(env);
  const partial: PartialReason[] = [];

  try {
    const sm = await fetchAllSupermetrics(env, jan1, now);
    const yr = now.getUTCFullYear();

    const gKey = KV_KEYS.supermetricsGoogleSlice(yr);
    assertSafeKvKey(gKey);
    await env.KV.put(gKey, JSON.stringify(sm.google), { expirationTtl: 7 * 24 * 3600 });

    const mKey = KV_KEYS.supermetricsMetaSlice(yr);
    assertSafeKvKey(mKey);
    await env.KV.put(mKey, JSON.stringify(sm.meta), { expirationTtl: 7 * 24 * 3600 });

    if (sm.errors.length === 0) {
      fresh.supermetrics_google = { okAt: now.toISOString(), errorAt: null };
      fresh.supermetrics_meta = { okAt: now.toISOString(), errorAt: null };
    } else {
      for (const e of sm.errors) {
        fresh[e.source] = {
          okAt: fresh[e.source]?.okAt ?? null,
          errorAt: now.toISOString(),
          error: e.error,
        };
        partial.push({ source: e.source, reason: e.error });
      }
    }
    log(`[refresh] supermetrics google=${sm.google.length} meta=${sm.meta.length}`);
  } catch (err) {
    fresh.supermetrics_google = {
      okAt: fresh.supermetrics_google?.okAt ?? null,
      errorAt: now.toISOString(),
      error: scrub(String(err)),
    };
    partial.push({ source: "supermetrics_google", reason: scrub(String(err)) });
  }

  await writeFreshness(env, fresh);
  await rebuildAggregated(env, now, fresh, partial);
}

// ──────────────────────────── aggregation ───────────────────────────────

async function rebuildAggregated(
  env: Env,
  now: Date,
  freshness: Partial<Record<SourceId, SourceFreshness>>,
  newPartial: PartialReason[],
): Promise<void> {
  const yr = now.getUTCFullYear();
  const jan1 = new Date(Date.UTC(yr, 0, 1));

  const [stripeMap, odooPosMap, odooInvoicesMap, viva, googleAds, metaAds] = await Promise.all([
    readVenueMap<StripeRow>(env, "stripe", yr),
    readVenueMap<OdooPosRow>(env, "odoo_pos", yr),
    readVenueMap<OdooInvoiceRow>(env, "odoo_invoices", yr),
    readJson<VivaRow[]>(env, KV_KEYS.vivaSlice(yr)),
    readJson<AdsRow[]>(env, KV_KEYS.supermetricsGoogleSlice(yr)),
    readJson<AdsRow[]>(env, KV_KEYS.supermetricsMetaSlice(yr)),
  ]);

  const input: AggregateInput = {
    raw: {
      stripe: stripeMap,
      odooPos: odooPosMap,
      odooInvoices: odooInvoicesMap,
      viva: viva ?? [],
      google: googleAds ?? [],
      meta: metaAds ?? [],
    },
    partial: newPartial,
    freshness,
    now,
    jan1,
  };

  const venueOptions: Array<Venue | "All"> = ["All", ...ALL_VENUES];

  for (const venue of venueOptions) {
    const revenue = buildRevenue(input, venue);
    const marketing = buildMarketing(input, venue);
    const revKey = KV_KEYS.revenue(String(venue), yr);
    const mktKey = KV_KEYS.marketing(String(venue), yr);
    assertSafeKvKey(revKey);
    assertSafeKvKey(mktKey);
    // No TTL — the dashboard ALWAYS has data to show. If cron breaks for a week,
    // users see last-known-good with `sourceFreshness` showing how stale it is.
    // Better than a blank dashboard.
    await env.KV.put(revKey, JSON.stringify(revenue));
    await env.KV.put(mktKey, JSON.stringify(marketing));
  }

  const digest = buildDigest(input);
  const dKey = KV_KEYS.digest(yr);
  assertSafeKvKey(dKey);
  await env.KV.put(dKey, JSON.stringify(digest));

  log(`[refresh] aggregated ${venueOptions.length} venues + digest`);
}

async function readVenueMap<T>(
  env: Env,
  source: "stripe" | "odoo_pos" | "odoo_invoices",
  year: number,
): Promise<Map<Venue, T[]>> {
  const map = new Map<Venue, T[]>();
  const venues =
    source === "stripe"
      ? (ALL_VENUES.filter((v) => v !== "Anvers") as Venue[])
      : (Object.keys(ODOO_COMPANIES) as Venue[]);
  await Promise.all(
    venues.map(async (v) => {
      const key =
        source === "stripe"
          ? KV_KEYS.stripeSlice(v, year)
          : source === "odoo_pos"
            ? KV_KEYS.odooPosSlice(v, year)
            : KV_KEYS.odooInvoicesSlice(v, year);
      const data = await readJson<T[]>(env, key);
      if (data) map.set(v, data);
    }),
  );
  return map;
}

async function readJson<T>(env: Env, key: string): Promise<T | null> {
  const v = await env.KV.get(key, "json");
  return (v as T) ?? null;
}

async function readFreshness(env: Env): Promise<Partial<Record<SourceId, SourceFreshness>>> {
  const v = await env.KV.get(KV_KEYS.freshness(), "json");
  return (v as Partial<Record<SourceId, SourceFreshness>>) ?? {};
}

async function writeFreshness(
  env: Env,
  freshness: Partial<Record<SourceId, SourceFreshness>>,
): Promise<void> {
  const key = KV_KEYS.freshness();
  assertSafeKvKey(key);
  await env.KV.put(key, JSON.stringify(freshness));
}

/** Logger that strips obvious secret patterns. Defense vs accidental log leakage. */
function log(msg: string): void {
  console.log(scrub(msg));
}

function scrub(s: string): string {
  let out = s.replace(/(sk|rk)_(live|test)_[A-Za-z0-9]{20,}/g, "$1_$2_[REDACTED]");
  out = out.replace(/Bearer [A-Za-z0-9._\-]{20,}/g, "Bearer [REDACTED]");
  out = out.replace(/([?&](key|token|secret|api_key|access_token)=)[^&\s]+/gi, "$1[REDACTED]");
  return out;
}
