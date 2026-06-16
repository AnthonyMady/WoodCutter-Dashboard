import type { Venue, City } from "./venues.ts";

// ─── Source-level row types ─────────────────────────────────────────────────

export type StripeStatus = "Paid" | "Refunded" | "Failed" | string;
export type StripePaymentType = "in-store" | "online";

export interface StripeRow {
  id: string;
  venue: Venue;
  city: City;
  createdAt: string;
  amount: number;
  amountRefunded: number;
  currency: string;
  status: StripeStatus;
  paymentType: StripePaymentType;
  readerLabel: string;
  paymentMethodType: string;
  tipAmount: number;
  paymentIntentId: string | null;
  stripeFee: number;
  netAmount: number;
  description: string;
}

export interface OdooPosRow {
  date: string;
  orderRef: string;
  pointOfSale: string;
  receiptNumber: string;
  session: string;
  cashier: string;
  customer: string;
  status: string;
  orderTotal: number;
  paymentTransactionId: string | null;
  product: string;
  productCategory: string;
  qty: number;
  unitPrice: number;
  discountPct: number;
  /** Pre-tax — already ex-VAT in Odoo. Never divide. */
  priceSubtotal: number;
  priceSubtotalInclTax: number;
  venue: Venue;
  city: City;
}

export interface OdooInvoiceRow {
  date: string;
  invoiceRef: string;
  journal: string;
  number: string;
  paymentStatus: string;
  /** Pre-tax. Already ex-VAT in Odoo. */
  untaxedAmount: number;
  totalAmount: number;
  currency: string;
  venue: Venue;
}

export interface VivaRow {
  transactionId: string;
  createdAt: string;
  amount: number;
  fee: number;
  tipAmount: number;
  currency: string;
  status: string;
  orderCode: string;
  sourceCode: string;
  terminalId: string;
  cardHolder: string;
  cardNumber: string;
  email: string;
  merchantReference: string;
  customerDescription: string;
  channel: string;
  city: City;
}

export interface AdsRow {
  date: string;
  campaignName: string;
  platform: "google" | "meta";
  venue: Venue | null;
  country: string;
  spend: number;
  clicks: number;
  impressions: number;
  conversions: number;
  conversionValue: number;
  ctr: number;
  cpc: number;
  roas: number;
}

// ─── Aggregated payload types ──────────────────────────────────────────────

export type SourceId =
  | "stripe"
  | "odoo_pos"
  | "odoo_invoices"
  | "viva"
  | "supermetrics_google"
  | "supermetrics_meta";

export interface SourceFreshness {
  okAt: string | null;
  errorAt: string | null;
  error?: string;
}

export interface PartialReason {
  source: SourceId;
  venue?: Venue;
  reason: string;
}

export interface Meta {
  schemaVersion: 1;
  generatedAt: string;
  sourceFreshness: Partial<Record<SourceId, SourceFreshness>>;
  venueFilter: Venue | "All";
  dateRange: { from: string; to: string };
}

export interface RevenueKpis {
  totalRevenue: number;
  totalTips: number;
  tipRate: number;
  avgTransaction: number;
  avgTip: number;
  inStorePct: number;
}

export interface RevenueResponse {
  meta: Meta;
  kpis: RevenueKpis;
  charts: {
    revenueTrend: Array<{ date: string; city: City; revenue: number }>;
    paymentTypeDonut: Array<{ label: string; value: number }>;
    tipDonut: Array<{ label: string; value: number }>;
    revenueByCity: Array<{ city: City; revenue: number }>;
    heatmap: Array<{ dow: number; hour: number; count: number }>;
    targets: Array<{ city: City; ytd: number; target: number | null }>;
    cityTipsPrevMonth: Array<{ city: City; tips: number }>;
    cityFnbPrevMonth: Array<{ city: City; fnb: number }>;
    pace: Array<{ city: City; series: Array<{ date: string; actual: number; target: number | null }> }>;
    streamDonut: { invoices: number; pos: number; stripeOnline: number; tips: number };
    invoicePipeline: Array<{ status: string; amount: number }>;
  };
  rows: StripeRow[];
  partial: PartialReason[];
}

export interface MarketingResponse {
  meta: Meta;
  google: {
    kpis: { spend: number; clicks: number; impressions: number; conversions: number; conversionValue: number; ctr: number; cpc: number; cpa: number; roas: number };
    daily: Array<{ date: string; spend: number; conversions: number }>;
    byCountry: Array<{ country: string; spend: number }>;
    topByRoas: Array<{ campaign: string; roas: number; spend: number }>;
    topBySpend: Array<{ campaign: string; spend: number; roas: number }>;
    rows: AdsRow[];
  };
  meta_ads: {
    kpis: { spend: number; clicks: number; impressions: number; actions: number; ctr: number; cpc: number };
    daily: Array<{ date: string; spend: number }>;
    byCountry: Array<{ country: string; spend: number }>;
    topBySpend: Array<{ campaign: string; spend: number }>;
    topByClicks: Array<{ campaign: string; clicks: number }>;
    rows: AdsRow[];
  };
  partial: PartialReason[];
}

export interface DigestResponse {
  meta: Meta;
  rows: Array<{
    rank: number;
    city: City;
    mtdGross: number;
    momPct: number | null;
    yoyPct: number | null;
  }>;
  windows: {
    mtd: { from: string; to: string };
    mom: { from: string; to: string };
    yoy: { from: string; to: string };
  };
}

export interface MetaConfigResponse {
  schemaVersion: 1;
  venues: Venue[];
  vatDivisors: Record<Venue, number>;
  targets: Partial<Record<City, number>>;
  sourceFreshness: Partial<Record<SourceId, SourceFreshness>>;
  canSeeShooters: boolean;
  email: string | null;
}

export interface HealthResponse {
  status: "ok" | "degraded" | "down";
  upstreams: Partial<Record<SourceId, { ok: boolean; latencyMs?: number; error?: string }>>;
  generatedAt: string;
}
