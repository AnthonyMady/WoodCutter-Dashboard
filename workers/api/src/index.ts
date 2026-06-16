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
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Cf-Access-Jwt-Assertion,Authorization,Content-Type",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    const url = new URL(req.url);

    // /api/health is intentionally unauthenticated — for synthetic monitors.
    if (url.pathname === "/api/health") return json(await healthHandler(env));

    let identity;
    try {
      identity = await validateAccessJwt(req, env.CF_ACCESS_TEAM_DOMAIN, env.CF_ACCESS_AUD);
    } catch (err) {
      const status = err instanceof AccessError ? err.status : 500;
      const reason = err instanceof Error ? err.message : "unauthorised";
      return json({ error: reason }, status);
    }

    const allowed = parseList(env.SHOOTERS_ALLOWLIST);
    const canSeeShooters = allowed.includes(identity.email);

    if (url.pathname === "/api/meta") {
      return json(await metaHandler(env, identity.email, canSeeShooters));
    }

    if (url.pathname === "/api/revenue") {
      const venue = parseVenueParam(url, "All");
      if (venue === "Shooters Brussels" && !canSeeShooters) {
        return json({ error: "forbidden" }, 403);
      }
      return json(await revenueHandler(env, venue));
    }

    if (url.pathname === "/api/marketing") {
      const venue = parseVenueParam(url, "All");
      if (venue === "Shooters Brussels" && !canSeeShooters) {
        return json({ error: "forbidden" }, 403);
      }
      return json(await marketingHandler(env, venue));
    }

    if (url.pathname === "/api/digest") {
      return json(await digestHandler(env));
    }

    return json({ error: "not found" }, 404);
  },
};

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

async function healthHandler(env: Env): Promise<HealthResponse> {
  const freshness =
    (await env.KV.get<Partial<Record<SourceId, SourceFreshness>>>(KV_KEYS.freshness(), "json")) ?? {};
  const upstreams: HealthResponse["upstreams"] = {};
  let anyDown = false;
  let anyDegraded = false;
  for (const [src, f] of Object.entries(freshness) as Array<[SourceId, SourceFreshness]>) {
    const ok = f.errorAt == null;
    upstreams[src] = { ok, error: f.error };
    if (!ok && !f.okAt) anyDown = true;
    else if (!ok) anyDegraded = true;
  }
  return {
    status: anyDown ? "down" : anyDegraded ? "degraded" : "ok",
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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, max-age=60",
      ...CORS_HEADERS,
    },
  });
}
