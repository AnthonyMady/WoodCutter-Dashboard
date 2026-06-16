// Supermetrics fetcher — Google Ads + Meta Ads. Replaces fetch_and_sync.py.
// Now we hold rows in KV instead of writing to a Sheet.

import type { AdsRow, Venue } from "@woodcutter/shared";

const SUPERMETRICS_URL = "https://api.supermetrics.com/enterprise/v2/query/data/json";

const GOOGLE_ADS_FIELDS = [
  "Date", "CampaignName", "Impressions", "Clicks", "Cost",
  "Conversions", "ConversionValue", "CTR", "CPC", "ROAS",
] as const;

const META_ADS_FIELDS = [
  "date_start", "campaign_name", "impressions", "clicks", "spend",
  "purchase_conversions", "purchase_roas", "ctr", "cpc",
] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface SupermetricsEnv {
  SUPERMETRICS_API_KEY: string;
  SUPERMETRICS_USER?: string;
  GOOGLE_ADS_ACCOUNT_IDS: string;
  META_ADS_ACCOUNT_IDS: string;
  META_ADS_USER_ID?: string;
}

async function fetchSupermetrics(
  env: SupermetricsEnv,
  dsId: string,
  accounts: string[],
  fields: readonly string[],
  startDate: string,
  endDate: string,
  dsUser?: string,
): Promise<unknown[][]> {
  const payload: Record<string, unknown> = {
    ds_id: dsId,
    ds_accounts: accounts,
    date_range_type: "custom",
    start_date: startDate,
    end_date: endDate,
    fields: [...fields],
    max_rows: 100_000,
  };
  if (dsUser) payload.ds_user = dsUser;

  const res = await fetch(SUPERMETRICS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SUPERMETRICS_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`supermetrics: HTTP ${res.status}: ${scrub(txt, env.SUPERMETRICS_API_KEY)}`);
  }
  const json = (await res.json()) as { meta?: { status_code?: string }; data?: unknown[][] };
  const status = (json.meta?.status_code ?? "").toUpperCase();
  if (status !== "SUCCESS") throw new Error(`supermetrics: ${JSON.stringify(json)}`);
  const rows = json.data ?? [];
  // Drop header bleed-through (any row whose first cell isn't a YYYY-MM-DD date).
  return rows.filter((r) => r.length > 0 && DATE_RE.test(String(r[0])));
}

function parseAccountIds(raw: string, prefixForMeta: boolean): string[] {
  return raw.split(",").map((a) => {
    const t = a.trim();
    if (prefixForMeta && t && !t.startsWith("act_")) return `act_${t}`;
    return t;
  }).filter((a) => a.length > 0);
}

const VENUE_PATTERNS: Array<{ venue: Venue; re: RegExp }> = [
  { venue: "Belgium",            re: /\b(brussels|bruxelles|brussel|bxl|brux)\b/i },
  { venue: "Anvers",             re: /\b(anvers|antwerp|antwerpen|anv)\b/i },
  { venue: "Berlin",             re: /\b(berlin|ber)\b/i },
  { venue: "Frankfurt",          re: /\b(frankfurt|fra)\b/i },
  { venue: "Hamburg",            re: /\b(hamburg|hh)\b/i },
  { venue: "Bonn",               re: /\bbonn\b/i },
  { venue: "Koln",               re: /\b(koln|köln|cologne|kol)\b/i },
  { venue: "Leipzig",            re: /\bleipzig\b/i },
  { venue: "Shooters Brussels",  re: /\b(shooters|shooting.?bar|schietbar|exp.?rience.?tir)\b/i },
];

function parseVenue(campaign: string): Venue | null {
  for (const { venue, re } of VENUE_PATTERNS) {
    if (re.test(campaign)) return venue;
  }
  return null;
}

const COUNTRY_PATTERNS: Array<{ country: string; re: RegExp }> = [
  { country: "BE", re: /\b(belgium|be|brussels|anvers|antwerp)\b/i },
  { country: "DE", re: /\b(germany|de|berlin|frankfurt|hamburg|bonn|koln|köln|leipzig)\b/i },
];

function parseCountry(campaign: string): string {
  for (const { country, re } of COUNTRY_PATTERNS) {
    if (re.test(campaign)) return country;
  }
  return "Other";
}

export interface SupermetricsResult {
  google: AdsRow[];
  meta: AdsRow[];
  errors: Array<{ source: "supermetrics_google" | "supermetrics_meta"; error: string }>;
}

export async function fetchAllSupermetrics(
  env: SupermetricsEnv,
  jan1: Date,
  now: Date,
): Promise<SupermetricsResult> {
  const startDate = jan1.toISOString().slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);

  const googleAccounts = parseAccountIds(env.GOOGLE_ADS_ACCOUNT_IDS ?? "", false);
  const metaAccounts = parseAccountIds(env.META_ADS_ACCOUNT_IDS ?? "", true);

  const errors: SupermetricsResult["errors"] = [];

  let googleRaw: unknown[][] = [];
  try {
    googleRaw = await fetchSupermetrics(env, "AW", googleAccounts, GOOGLE_ADS_FIELDS, startDate, endDate);
  } catch (e) {
    errors.push({ source: "supermetrics_google", error: scrub(String(e), env.SUPERMETRICS_API_KEY) });
  }

  let metaRaw: unknown[][] = [];
  try {
    metaRaw = await fetchSupermetrics(
      env, "FA", metaAccounts, META_ADS_FIELDS, startDate, endDate, env.META_ADS_USER_ID,
    );
  } catch (e) {
    errors.push({ source: "supermetrics_meta", error: scrub(String(e), env.SUPERMETRICS_API_KEY) });
  }

  return { google: googleRaw.map(toGoogleAdsRow), meta: metaRaw.map(toMetaAdsRow), errors };
}

function toGoogleAdsRow(row: unknown[]): AdsRow {
  const [date, campaignName, impressions, clicks, cost, conversions, conversionValue, ctr, cpc, roas] = row as [
    string, string, number, number, number, number, number, number, number, number,
  ];
  return {
    date,
    campaignName,
    platform: "google",
    venue: parseVenue(campaignName),
    country: parseCountry(campaignName),
    spend: Number(cost) || 0,
    clicks: Number(clicks) || 0,
    impressions: Number(impressions) || 0,
    conversions: Number(conversions) || 0,
    conversionValue: Number(conversionValue) || 0,
    ctr: Number(ctr) || 0,
    cpc: Number(cpc) || 0,
    roas: Number(roas) || 0,
  };
}

function toMetaAdsRow(row: unknown[]): AdsRow {
  const [date, campaignName, impressions, clicks, spend, purchaseConversions, purchaseRoas, ctr, cpc] = row as [
    string, string, number, number, number, number, number, number, number,
  ];
  return {
    date,
    campaignName,
    platform: "meta",
    venue: parseVenue(campaignName),
    country: parseCountry(campaignName),
    spend: Number(spend) || 0,
    clicks: Number(clicks) || 0,
    impressions: Number(impressions) || 0,
    conversions: Number(purchaseConversions) || 0,
    conversionValue: 0,
    ctr: Number(ctr) || 0,
    cpc: Number(cpc) || 0,
    roas: Number(purchaseRoas) || 0,
  };
}

function scrub(s: string, secret: string): string {
  if (!secret) return s;
  return s.split(secret).join("[REDACTED]");
}
