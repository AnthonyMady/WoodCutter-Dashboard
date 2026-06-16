// api Worker — read-only KV reader behind Cloudflare Access.
// All routes return JSON.

import {
  ALL_VENUES,
  ANNUAL_TARGETS,
  KV_KEYS,
  VENUE_CONFIG,
  type DigestResponse,
  type HealthResponse,
  type MarketingResponse,
  type MetaConfigResponse,
  type RevenueResponse,
  type SourceFreshness,
  type SourceId,
  type Venue,
} from "@woodcutter/shared";

import { AccessError, validateAccessJwt } from "./auth.ts";

export interface Env {
  KV: KVNamespace;
  CF_ACCESS_AUD: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  SHOOTERS_ALLOWLIST: string;
  /** Comma-separated allowed origins for CORS (e.g. "https://dashboard.example.com"). Optional — defaults to same-origin only. */
  ALLOWED_ORIGINS?: string;
}

const SECURITY_HEADERS = {
  // Defence-in-depth headers that apply to every JSON response.
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  // CSP: this Worker only emits JSON. No need to allow scripts/styles.
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  // Same-origin (no Origin header) → no CORS needed
  // Cross-origin from an allowed origin → echo it back
  // Anything else → no CORS headers (browser blocks)
  if (origin && allowed.includes(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Cf-Access-Jwt-Assertion,Content-Type",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Credentials": "true",
      "Vary": "Origin",
    };
  }
  return {};
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(req, env);

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(req.url);

    // /api/health is public — but returns ONLY a single overall status to
    // unauthenticated callers. Per-source detail requires a valid JWT.
    if (url.pathname === "/api/health") {
      const authed = await tryAuth(req, env);
      return json(await healthHandler(env, authed != null), 200, cors);
    }

    let identity;
    try {
      identity = await validateAccessJwt(req, env.CF_ACCESS_TEAM_DOMAIN, env.CF_ACCESS_AUD);
    } catch (err) {
      const status = err instanceof AccessError ? err.status : 500;
      const reason = err instanceof Error ? err.message : "unauthorised";
      return json({ error: reason }, status, cors);
    }

    const allowed = parseList(env.SHOOTERS_ALLOWLIST);
    const canSeeShooters = allowed.includes(identity.email);

    if (url.pathname === "/api/meta") {
      return json(await metaHandler(env, identity.email, canSeeShooters), 200, cors);
    }

    if (url.pathname === "/api/revenue") {
      const venue = parseVenueParam(url, "All");
      if (venue === "Shooters Brussels" && !canSeeShooters) {
        return json({ error: "forbidden" }, 403, cors);
      }
      return json(await revenueHandler(env, venue), 200, cors);
    }

    if (url.pathname === "/api/marketing") {
      const venue = parseVenueParam(url, "All");
      if (venue === "Shooters Brussels" && !canSeeShooters) {
        return json({ error: "forbidden" }, 403, cors);
      }
      return json(await marketingHandler(env, venue), 200, cors);
    }

    if (url.pathname === "/api/digest") {
      return json(await digestHandler(env), 200, cors);
    }

    return json({ error: "not found" }, 404, cors);
  },
};

/** Try to validate; return null on any failure (used by /api/health to detect auth without erroring). */
async function tryAuth(req: Request, env: Env): Promise<string | null> {
  try {
    const id = await validateAccessJwt(req, env.CF_ACCESS_TEAM_DOMAIN, env.CF_ACCESS_AUD);
    return id.email;
  } catch {
    return null;
  }
}

async function revenueHandler(env: Env, venue: Venue | "All"): Promise<RevenueResponse | { error: string }> {
  const yr = new Date().getUTCFullYear();
  const data = await env.KV.get<RevenueResponse>(KV_KEYS.revenue(String(venue), yr), "json");
  if (!data) return { error: `no cached data for venue=${venue} (refresh worker may not have run yet)` };
  return data;
}

async function marketingHandler(env: Env, venue: Venue | "All"): Promise<MarketingResponse | { error: string }> {
  const yr = new Date().getUTCFullYear();
  const data = await env.KV.get<MarketingResponse>(KV_KEYS.marketing(String(venue), yr), "json");
  if (!data) return { error: `no cached marketing data for venue=${venue}` };
  return data;
}

async function digestHandler(env: Env): Promise<DigestResponse | { error: string }> {
  const yr = new Date().getUTCFullYear();
  const data = await env.KV.get<DigestResponse>(KV_KEYS.digest(yr), "json");
  if (!data) return { error: "no cached digest data" };
  return data;
}

async function metaHandler(env: Env, email: string, canSeeShooters: boolean): Promise<MetaConfigResponse> {
  const freshness =
    (await env.KV.get<Partial<Record<SourceId, SourceFreshness>>>(KV_KEYS.freshness(), "json")) ?? {};
  const venueList = canSeeShooters
    ? ALL_VENUES.slice()
    : ALL_VENUES.filter((v) => v !== "Shooters Brussels");
  const vatDivisors = Object.fromEntries(
    venueList.map((v) => [v, VENUE_CONFIG[v].vatDivisor]),
  ) as Record<Venue, number>;
  return {
    schemaVersion: 1,
    venues: venueList,
    vatDivisors,
    targets: ANNUAL_TARGETS,
    sourceFreshness: freshness,
    canSeeShooters,
    email,
  };
}

async function healthHandler(env: Env, authed: boolean): Promise<HealthResponse | { status: string }> {
  const freshness =
    (await env.KV.get<Partial<Record<SourceId, SourceFreshness>>>(KV_KEYS.freshness(), "json")) ?? {};

  // Compute overall status once
  let anyDown = false;
  let anyDegraded = false;
  for (const f of Object.values(freshness) as SourceFreshness[]) {
    const ok = f.errorAt == null;
    if (!ok && !f.okAt) anyDown = true;
    else if (!ok) anyDegraded = true;
  }
  const status = anyDown ? "down" : anyDegraded ? "degraded" : "ok";

  // Unauthenticated callers get only the overall status — no upstream detail,
  // no error strings (which could leak partial secrets despite scrubbing).
  if (!authed) return { status };

  // Authenticated callers get the full picture
  const upstreams: HealthResponse["upstreams"] = {};
  for (const [src, f] of Object.entries(freshness) as Array<[SourceId, SourceFreshness]>) {
    upstreams[src] = { ok: f.errorAt == null, error: f.error };
  }
  return {
    status,
    upstreams,
    generatedAt: new Date().toISOString(),
  };
}

function parseVenueParam(url: URL, defaultVenue: Venue | "All"): Venue | "All" {
  const v = url.searchParams.get("venue");
  if (!v) return defaultVenue;
  if (v === "All") return "All";
  if ((ALL_VENUES as readonly string[]).includes(v)) return v as Venue;
  return defaultVenue;
}

function parseList(s: string | undefined): string[] {
  if (!s) return [];
  return s.split(",").map((x) => x.trim()).filter((x) => x.length > 0);
}

function json(data: unknown, status = 200, cors: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      ...SECURITY_HEADERS,
      ...cors,
    },
  });
}
