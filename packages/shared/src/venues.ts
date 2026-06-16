// Single source of truth for venue identity. Imported by both Worker and dashboard
// so the two can never disagree about what a venue is or how to label it.

export type Venue =
  | "Belgium"
  | "Anvers"
  | "Berlin"
  | "Frankfurt"
  | "Hamburg"
  | "Bonn"
  | "Koln"
  | "Leipzig"
  | "Shooters Brussels";

export type City = Venue;

export const ALL_VENUES: readonly Venue[] = [
  "Belgium",
  "Anvers",
  "Berlin",
  "Frankfurt",
  "Hamburg",
  "Bonn",
  "Koln",
  "Leipzig",
  "Shooters Brussels",
] as const;

export interface VenueConfig {
  vatDivisor: number;
  cities: City[];
  countryCode: "BE" | "DE";
}

// Belgium contains both Brussels & Anvers; the split happens via Odoo POS
// payment_intent matching. Stripe charges from the Belgium account get tagged
// "Belgium" by default and re-tagged "Anvers" when their pi_ matches an
// Anvers-side POS row.
export const VENUE_CONFIG: Record<Venue, VenueConfig> = {
  Belgium:             { vatDivisor: 1.21, cities: ["Belgium", "Anvers"],     countryCode: "BE" },
  Anvers:              { vatDivisor: 1.21, cities: ["Anvers"],                countryCode: "BE" },
  Berlin:              { vatDivisor: 1.19, cities: ["Berlin"],                countryCode: "DE" },
  Frankfurt:           { vatDivisor: 1.19, cities: ["Frankfurt"],             countryCode: "DE" },
  Hamburg:             { vatDivisor: 1.19, cities: ["Hamburg"],               countryCode: "DE" },
  Bonn:                { vatDivisor: 1.19, cities: ["Bonn"],                  countryCode: "DE" },
  Koln:                { vatDivisor: 1.19, cities: ["Koln"],                  countryCode: "DE" },
  Leipzig:             { vatDivisor: 1.19, cities: ["Leipzig"],               countryCode: "DE" },
  "Shooters Brussels": { vatDivisor: 1.21, cities: ["Shooters Brussels"],     countryCode: "BE" },
};

export interface OdooCompanyConfig {
  companyId: number | null;
  posNames: string[];
}

// Belgium has no company filter (sole company in its key's database).
// German cities all live in the woodcutter DB and are distinguished by
// company_id to prevent cross-company data leakage.
export const ODOO_COMPANIES: Record<
  Exclude<Venue, "Anvers" | "Bonn" | "Shooters Brussels">,
  OdooCompanyConfig
> = {
  Belgium:   { companyId: null, posNames: ["WoodCutter - Brussels", "WoodCutter - Anvers"] },
  Berlin:    { companyId: 3,    posNames: [] },
  Frankfurt: { companyId: 2,    posNames: [] },
  Hamburg:   { companyId: 5,    posNames: [] },
  Koln:      { companyId: 6,    posNames: [] },
  Leipzig:   { companyId: 12,   posNames: [] },
};

// Belgium-specific journal exclusions for invoice export.
// German venues export all journals (per legacy odoo_export.py).
export const BELGIUM_INVOICE_EXCLUDE_JOURNALS: ReadonlySet<string> = new Set([
  "BRU + ANT - ONLINE SALES",
  "Customer Invoices",
  "Ventes Stripe",
]);
