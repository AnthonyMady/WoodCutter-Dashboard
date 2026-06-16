// Public API for @woodcutter/shared.

export * from "./venues.ts";
export * from "./targets.ts";
export * from "./vat.ts";
export * from "./iso.ts";
export * from "./split.ts";
export * from "./types.ts";

export const SCHEMA_VERSION = 1 as const;
export const KV_VERSION = "v1" as const;

export const KV_KEYS = {
  revenue: (venue: string, year: number) => `${KV_VERSION}:agg:revenue:${venue}:${year}`,
  marketing: (venue: string, year: number) => `${KV_VERSION}:agg:marketing:${venue}:${year}`,
  digest: (year: number) => `${KV_VERSION}:agg:digest:${year}`,
  stripeSlice: (venue: string, year: number) => `${KV_VERSION}:src:stripe:${venue}:${year}`,
  odooPosSlice: (venue: string, year: number) => `${KV_VERSION}:src:odoo_pos:${venue}:${year}`,
  odooInvoicesSlice: (venue: string, year: number) => `${KV_VERSION}:src:odoo_invoices:${venue}:${year}`,
  vivaSlice: (year: number) => `${KV_VERSION}:src:viva:Belgium:${year}`,
  supermetricsGoogleSlice: (year: number) => `${KV_VERSION}:src:supermetrics_google:all:${year}`,
  supermetricsMetaSlice: (year: number) => `${KV_VERSION}:src:supermetrics_meta:all:${year}`,
  freshness: () => `${KV_VERSION}:meta:freshness`,
} as const;

/** Validate a KV key matches the safe pattern. Used at write time so user-controlled
 *  values never leak into cache keys (poisoning prevention). */
export function assertSafeKvKey(key: string): void {
  if (!/^v\d+:(src|agg|meta):[a-zA-Z0-9_:\-\s]+$/.test(key)) {
    throw new Error(`unsafe KV key: ${key}`);
  }
}
