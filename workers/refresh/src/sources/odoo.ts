// Odoo POS + invoice fetcher. Ports odoo_export.py via the hand-rolled XML-RPC client.
// Belgium splits Brussels/Anvers via POS config name; German cities filter by company_id.

import {
  ODOO_COMPANIES,
  BELGIUM_INVOICE_EXCLUDE_JOURNALS,
  type OdooPosRow,
  type OdooInvoiceRow,
  type Venue,
  type City,
} from "@woodcutter/shared";
import { xmlrpcCall } from "./xmlrpc.ts";

const BATCH_SIZE = 200;

const PAYMENT_STATE_LABELS: Record<string, string> = {
  paid: "Paid",
  not_paid: "Not Paid",
  in_payment: "In Payment",
  partial: "Partial",
  reversed: "Reversed",
  invoicing_legacy: "Invoicing Legacy",
};

export interface OdooEnv {
  ODOO_URL: string;
  ODOO_DB: string;
  ODOO_USER: string;
  [k: string]: string;
}

export function odooKeyEnvName(venue: Venue): string {
  return `ODOO_KEY_${venue.toUpperCase().replace(/\s+/g, "_")}`;
}

/** A many2one Odoo field is `[id, name]` or false/null when unset. */
function m2oName(val: unknown): string {
  if (Array.isArray(val) && val.length > 1) return String(val[1] ?? "");
  return "";
}

function m2oId(val: unknown): number | null {
  if (Array.isArray(val) && val.length > 0) return Number(val[0]);
  if (typeof val === "number") return val;
  return null;
}

interface OdooConnection {
  uid: number;
  apiKey: string;
  url: string;
  db: string;
}

async function connect(env: OdooEnv, apiKey: string): Promise<OdooConnection> {
  const uid = await xmlrpcCall<number | false>({
    url: `${env.ODOO_URL}/xmlrpc/2/common`,
    method: "authenticate",
    params: [env.ODOO_DB, env.ODOO_USER, apiKey, {}],
  });
  if (!uid || typeof uid !== "number") {
    throw new Error("Odoo authentication failed — check API key");
  }
  return { uid, apiKey, url: `${env.ODOO_URL}/xmlrpc/2/object`, db: env.ODOO_DB };
}

async function execute_kw<T = unknown>(
  conn: OdooConnection,
  model: string,
  method: string,
  args: unknown[] = [],
  kwargs: Record<string, unknown> = {},
): Promise<T> {
  return xmlrpcCall<T>({
    url: conn.url,
    method: "execute_kw",
    params: [conn.db, conn.uid, conn.apiKey, model, method, args, kwargs],
  });
}

async function readInBatches<T = unknown>(
  conn: OdooConnection,
  model: string,
  ids: number[],
  fields: string[],
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const rows = await execute_kw<T[]>(conn, model, "read", [batch], { fields });
    results.push(...rows);
  }
  return results;
}

// ───────────────────────────── POS export ─────────────────────────────────

export async function fetchOdooPos(
  env: OdooEnv,
  venue: keyof typeof ODOO_COMPANIES,
  apiKey: string,
  jan1: Date,
  now: Date,
): Promise<OdooPosRow[]> {
  const config = ODOO_COMPANIES[venue];
  const conn = await connect(env, apiKey);

  const sinceStr = jan1.toISOString().replace("T", " ").slice(0, 19);
  const untilStr = now.toISOString().replace("T", " ").slice(0, 19);

  const domain: unknown[] = [
    ["state", "in", ["paid", "posted", "invoiced", "done"]],
    ["date_order", ">=", sinceStr],
    ["date_order", "<=", untilStr],
  ];
  if (config.companyId != null) domain.unshift(["company_id", "=", config.companyId]);

  if (config.posNames.length > 0) {
    const configIds = await execute_kw<number[]>(conn, "pos.config", "search", [
      [["name", "in", config.posNames]],
    ]);
    if (configIds.length === 0) {
      throw new Error(`POS configs not found: ${config.posNames.join(", ")}`);
    }
    domain.unshift(["config_id", "in", configIds]);
  }

  const ctx = config.companyId != null ? { allowed_company_ids: [config.companyId] } : {};

  const orderIds = await execute_kw<number[]>(conn, "pos.order", "search", [domain], {
    order: "date_order asc",
    context: ctx,
  });
  if (orderIds.length === 0) return [];

  type Order = {
    id: number;
    name?: string;
    date_order?: string;
    config_id?: unknown;
    session_id?: unknown;
    employee_id?: unknown;
    user_id?: unknown;
    partner_id?: unknown;
    state?: string;
    amount_total?: number;
    pos_reference?: string;
    lines?: number[];
    payment_ids?: number[];
  };
  const orders = await readInBatches<Order>(conn, "pos.order", orderIds, [
    "name", "date_order", "config_id", "session_id", "employee_id",
    "user_id", "partner_id", "state", "amount_total", "pos_reference",
    "lines", "payment_ids",
  ]);

  // Payments
  const allPaymentIds = orders.flatMap((o) => o.payment_ids ?? []);
  const paymentMap = new Map<number, string>();
  if (allPaymentIds.length > 0) {
    type Payment = { pos_order_id: unknown; transaction_id: unknown };
    const payments = await readInBatches<Payment>(conn, "pos.payment", allPaymentIds, [
      "pos_order_id",
      "transaction_id",
    ]);
    for (const p of payments) {
      let ref = p.transaction_id;
      if (Array.isArray(ref)) ref = ref.length > 1 ? ref[1] : "";
      const orderId = m2oId(p.pos_order_id);
      const refStr = String(ref ?? "");
      if (orderId != null && !paymentMap.has(orderId) && refStr.startsWith("pi_")) {
        paymentMap.set(orderId, refStr);
      }
    }
  }

  // Order lines
  const allLineIds = orders.flatMap((o) => o.lines ?? []);
  const linesByOrder = new Map<number, Array<Record<string, unknown>>>();
  const productIdsNeeded = new Set<number>();
  if (allLineIds.length > 0) {
    type Line = {
      id: number;
      order_id: unknown;
      product_id: unknown;
      qty?: number;
      price_unit?: number;
      discount?: number;
      price_subtotal?: number;
      price_subtotal_incl?: number;
    };
    const lines = await readInBatches<Line>(conn, "pos.order.line", allLineIds, [
      "order_id", "product_id", "qty",
      "price_unit", "discount",
      "price_subtotal", "price_subtotal_incl",
    ]);
    for (const l of lines) {
      const orderId = m2oId(l.order_id);
      if (orderId == null) continue;
      if (!linesByOrder.has(orderId)) linesByOrder.set(orderId, []);
      linesByOrder.get(orderId)!.push(l as unknown as Record<string, unknown>);
      const pid = m2oId(l.product_id);
      if (pid != null) productIdsNeeded.add(pid);
    }
  }

  // Product categories
  const categoryByProduct = new Map<number, string>();
  if (productIdsNeeded.size > 0) {
    type Product = { id: number; categ_id: unknown };
    const products = await readInBatches<Product>(conn, "product.product", [...productIdsNeeded], [
      "id",
      "categ_id",
    ]);
    const productToCategory = new Map<number, number>();
    const catIds = new Set<number>();
    for (const p of products) {
      const catId = m2oId(p.categ_id);
      if (catId != null) {
        productToCategory.set(p.id, catId);
        catIds.add(catId);
      }
    }
    if (catIds.size > 0) {
      type Cat = { id: number; name: string };
      const cats = await readInBatches<Cat>(conn, "product.category", [...catIds], ["id", "name"]);
      const catNames = new Map(cats.map((c) => [c.id, c.name]));
      for (const [pid, catId] of productToCategory) {
        categoryByProduct.set(pid, catNames.get(catId) ?? "");
      }
    }
  }

  const rows: OdooPosRow[] = [];
  for (const order of orders) {
    const cashier = m2oName(order.employee_id) || m2oName(order.user_id);
    const lines = linesByOrder.get(order.id) ?? [];
    const pointOfSale = m2oName(order.config_id);
    const city = belgiumPosToCity(pointOfSale, venue);
    for (const line of lines) {
      const pid = m2oId(line.product_id);
      rows.push({
        date: String(order.date_order ?? ""),
        orderRef: String(order.name ?? ""),
        pointOfSale,
        receiptNumber: String(order.pos_reference ?? ""),
        session: m2oName(order.session_id),
        cashier,
        customer: m2oName(order.partner_id),
        status: String(order.state ?? ""),
        orderTotal: Number(order.amount_total ?? 0),
        paymentTransactionId: paymentMap.get(order.id) ?? null,
        product: m2oName(line.product_id),
        productCategory: pid != null ? categoryByProduct.get(pid) ?? "" : "",
        qty: Number(line.qty ?? 0),
        unitPrice: Number(line.price_unit ?? 0),
        discountPct: Number(line.discount ?? 0),
        priceSubtotal: Number(line.price_subtotal ?? 0),
        priceSubtotalInclTax: Number(line.price_subtotal_incl ?? 0),
        venue,
        city,
      });
    }
  }
  return rows;
}

function belgiumPosToCity(pointOfSale: string, venue: Venue): City {
  if (venue !== "Belgium") return venue;
  if (pointOfSale.includes("Anvers") || pointOfSale.includes("Antwerp")) return "Anvers";
  return "Belgium";
}

// ──────────────────────────── Invoice export ──────────────────────────────

export async function fetchOdooInvoices(
  env: OdooEnv,
  venue: keyof typeof ODOO_COMPANIES,
  apiKey: string,
  jan1: Date,
  now: Date,
): Promise<OdooInvoiceRow[]> {
  const config = ODOO_COMPANIES[venue];
  const conn = await connect(env, apiKey);

  const sinceStr = jan1.toISOString().slice(0, 10);
  const untilStr = now.toISOString().slice(0, 10);

  const domain: unknown[] = [
    ["move_type", "=", "out_invoice"],
    ["state", "=", "posted"],
    ["invoice_date", ">=", sinceStr],
    ["invoice_date", "<=", untilStr],
  ];
  if (config.companyId != null) domain.unshift(["company_id", "=", config.companyId]);
  const ctx = config.companyId != null ? { allowed_company_ids: [config.companyId] } : {};

  const invoiceIds = await execute_kw<number[]>(conn, "account.move", "search", [domain], {
    order: "invoice_date asc",
    context: ctx,
  });
  if (invoiceIds.length === 0) return [];

  type Invoice = {
    id: number;
    name?: string;
    invoice_date?: string;
    journal_id?: unknown;
    payment_state?: string;
    amount_untaxed_signed?: number;
    amount_total_signed?: number;
  };
  const invoices = await readInBatches<Invoice>(conn, "account.move", invoiceIds, [
    "name", "invoice_date", "journal_id", "payment_state",
    "amount_untaxed_signed", "amount_total_signed",
  ]);

  const excludeJournals =
    venue === "Belgium" ? BELGIUM_INVOICE_EXCLUDE_JOURNALS : new Set<string>();

  const rows: OdooInvoiceRow[] = [];
  for (const inv of invoices) {
    const journalName = m2oName(inv.journal_id);
    const paymentStateRaw = inv.payment_state ?? "";

    if (excludeJournals.has(journalName) || paymentStateRaw === "reversed") continue;

    rows.push({
      date: String(inv.invoice_date ?? ""),
      invoiceRef: String(inv.name ?? ""),
      number: String(inv.name ?? ""),
      journal: journalName,
      paymentStatus: PAYMENT_STATE_LABELS[paymentStateRaw] ?? paymentStateRaw,
      untaxedAmount: Number(inv.amount_untaxed_signed ?? 0),
      totalAmount: Number(inv.amount_total_signed ?? 0),
      currency: "EUR",
      venue,
    });
  }
  return rows;
}

// ──────────────────────────── fan-out ─────────────────────────────────────

export interface OdooFanoutResult {
  posRowsByVenue: Map<Venue, OdooPosRow[]>;
  invoiceRowsByVenue: Map<Venue, OdooInvoiceRow[]>;
  errors: Array<{ venue: Venue; phase: "pos" | "invoices"; error: string }>;
}

export async function fetchAllOdoo(
  env: OdooEnv,
  jan1: Date,
  now: Date,
): Promise<OdooFanoutResult> {
  const venues = Object.keys(ODOO_COMPANIES) as Array<keyof typeof ODOO_COMPANIES>;
  const tasks = venues.map(async (venue) => {
    const keyName = odooKeyEnvName(venue);
    const apiKey = env[keyName];
    if (!apiKey) {
      return {
        venue,
        pos: null,
        invoices: null,
        posError: `missing secret: ${keyName}`,
        invoiceError: `missing secret: ${keyName}`,
      };
    }
    const [posResult, invoiceResult] = await Promise.allSettled([
      fetchOdooPos(env, venue, apiKey, jan1, now),
      fetchOdooInvoices(env, venue, apiKey, jan1, now),
    ]);
    return {
      venue,
      pos: posResult.status === "fulfilled" ? posResult.value : null,
      invoices: invoiceResult.status === "fulfilled" ? invoiceResult.value : null,
      posError: posResult.status === "rejected" ? scrub(String(posResult.reason), apiKey) : undefined,
      invoiceError:
        invoiceResult.status === "rejected" ? scrub(String(invoiceResult.reason), apiKey) : undefined,
    };
  });

  const settled = await Promise.all(tasks);
  const posRowsByVenue = new Map<Venue, OdooPosRow[]>();
  const invoiceRowsByVenue = new Map<Venue, OdooInvoiceRow[]>();
  const errors: OdooFanoutResult["errors"] = [];

  for (const r of settled) {
    if (r.pos) posRowsByVenue.set(r.venue, r.pos);
    if (r.invoices) invoiceRowsByVenue.set(r.venue, r.invoices);
    if (r.posError) errors.push({ venue: r.venue, phase: "pos", error: r.posError });
    if (r.invoiceError) errors.push({ venue: r.venue, phase: "invoices", error: r.invoiceError });
  }
  return { posRowsByVenue, invoiceRowsByVenue, errors };
}

function scrub(s: string, secret: string): string {
  if (!secret) return s;
  return s.split(secret).join("[REDACTED]");
}
