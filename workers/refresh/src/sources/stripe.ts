import Stripe from "stripe";
import type { StripeRow, Venue } from "@woodcutter/shared";
import { ALL_VENUES } from "@woodcutter/shared";

// Ports stripe_export.py. Reader Label is ground truth for in-store classification.
// The Stripe Node SDK works in Workers via the fetch-based HTTP client.

const TERMINAL_TYPES = new Set(["card_present", "interac_present"]);

export type StripeFetchEnv = Record<string, string>;

/** Map a Venue to its env var name. Belgium's Stripe key is named BRUSSELS for legacy reasons. */
export function stripeKeyEnvName(venue: Venue): string {
  if (venue === "Belgium") return "STRIPE_KEY_BRUSSELS";
  return `STRIPE_KEY_${venue.toUpperCase().replace(/\s+/g, "_")}`;
}

export interface StripeFetchOptions {
  apiKey: string;
  venue: Venue;
  since: number;
  until: number;
}

export async function fetchStripeForVenue(opts: StripeFetchOptions): Promise<StripeRow[]> {
  const stripe = new Stripe(opts.apiKey, {
    apiVersion: "2024-06-20",
    httpClient: Stripe.createFetchHttpClient(),
  });

  const readerMap = new Map<string, string>();
  try {
    for await (const reader of stripe.terminal.readers.list({ limit: 100 })) {
      readerMap.set(reader.id, reader.label || "");
    }
  } catch {
    // Online-only accounts have no Terminal access — fine.
  }

  const rows: StripeRow[] = [];

  for await (const charge of stripe.charges.list({
    created: { gte: opts.since, lte: opts.until },
    limit: 100,
    expand: ["data.payment_intent", "data.refunds", "data.balance_transaction"],
  })) {
    rows.push(rowFromCharge(charge, readerMap, opts.venue));
  }
  return rows;
}

function rowFromCharge(
  charge: Stripe.Charge,
  readerMap: ReadonlyMap<string, string>,
  venue: Venue,
): StripeRow {
  let status: StripeRow["status"];
  if (charge.refunded) status = "Refunded";
  else if (charge.status === "succeeded") status = "Paid";
  else if (charge.status === "failed") status = "Failed";
  else status = charge.status;

  const pmdType = charge.payment_method_details?.type ?? "";

  let readerLabel = "";
  const cardPresent = charge.payment_method_details?.card_present as
    | (Stripe.Charge.PaymentMethodDetails.CardPresent & { reader?: string | null })
    | undefined;
  if (cardPresent?.reader && typeof cardPresent.reader === "string") {
    readerLabel = readerMap.get(cardPresent.reader) ?? "";
  }

  const paymentType: StripeRow["paymentType"] =
    readerLabel || TERMINAL_TYPES.has(pmdType) ? "in-store" : "online";

  let tipAmount = 0;
  let paymentIntentId: string | null = null;
  const pi = charge.payment_intent;
  if (pi && typeof pi !== "string") {
    paymentIntentId = pi.id;
    const tip = pi.amount_details?.tip;
    if (tip && typeof tip.amount === "number") {
      tipAmount = tip.amount / 100;
    }
  } else if (typeof pi === "string") {
    paymentIntentId = pi;
  }

  let stripeFee = 0;
  let netAmount = 0;
  const bt = charge.balance_transaction;
  if (bt && typeof bt !== "string") {
    stripeFee = bt.fee / 100;
    netAmount = bt.net / 100;
  }

  return {
    id: charge.id,
    venue,
    // City filled later by aggregator (Belgium → Brussels/Anvers split).
    // Default for non-Belgium: city == venue.
    city: venue === "Belgium" ? "Belgium" : venue,
    createdAt: new Date(charge.created * 1000).toISOString(),
    amount: charge.amount / 100,
    amountRefunded: charge.amount_refunded / 100,
    currency: (charge.currency || "").toUpperCase(),
    status,
    paymentType,
    readerLabel,
    paymentMethodType: pmdType,
    tipAmount,
    paymentIntentId,
    stripeFee,
    netAmount,
    description: charge.description ?? "",
  };
}

export interface StripeFanoutResult {
  rowsByVenue: Map<Venue, StripeRow[]>;
  errors: Array<{ venue: Venue; error: string }>;
}

/** Fan out across all venues in parallel. Per-venue failures don't kill the run. */
export async function fetchAllStripe(
  env: StripeFetchEnv,
  since: number,
  until: number,
): Promise<StripeFanoutResult> {
  // Anvers data lives in the Belgium account — no separate Anvers Stripe key.
  const tasks = ALL_VENUES.filter((v) => v !== "Anvers").map(async (venue) => {
    const keyName = stripeKeyEnvName(venue);
    const apiKey = env[keyName];
    if (!apiKey) return { venue, error: `missing secret: ${keyName}`, rows: null };
    try {
      const rows = await fetchStripeForVenue({ apiKey, venue, since, until });
      return { venue, rows, error: null };
    } catch (err) {
      const msg = scrubSecrets(String(err), [apiKey]);
      return { venue, error: msg, rows: null };
    }
  });

  const settled = await Promise.allSettled(tasks);
  const rowsByVenue = new Map<Venue, StripeRow[]>();
  const errors: Array<{ venue: Venue; error: string }> = [];

  for (const r of settled) {
    if (r.status === "rejected") {
      errors.push({ venue: "Belgium", error: String(r.reason) });
      continue;
    }
    const { venue, rows, error } = r.value;
    if (rows) rowsByVenue.set(venue, rows);
    if (error) errors.push({ venue, error });
  }
  return { rowsByVenue, errors };
}

function scrubSecrets(s: string, secrets: string[]): string {
  let out = s;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join("[REDACTED]");
  }
  return out;
}
