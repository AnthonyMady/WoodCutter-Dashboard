// Viva Wallet exporter — Belgium only. OAuth2 client_credentials, paginated reporting API.

import type { VivaRow, City } from "@woodcutter/shared";

const TOKEN_URL = "https://accounts.vivapayments.com/connect/token";
const API_BASE = "https://api.vivawallet.com";

const STATUS_MAP: Record<string, string> = {
  F: "Paid", A: "Cancelled", R: "Refunded", X: "Expired",
  M: "Chargeback", MA: "Chargeback Reversed", MI: "Dispute In Progress", E: "Error",
};

export interface VivaEnv {
  VIVAWALLET_MERCHANT_ID: string;
  VIVAWALLET_KEY: string;
  VIVA_CITY_MAP?: string;
}

async function getToken(env: VivaEnv): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.VIVAWALLET_MERCHANT_ID,
    client_secret: env.VIVAWALLET_KEY,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`viva token: HTTP ${res.status}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("viva token: missing access_token");
  return json.access_token;
}

function parseCityMap(env: VivaEnv): Map<string, City> {
  const raw = env.VIVA_CITY_MAP;
  if (!raw) return new Map();
  try {
    const obj = JSON.parse(raw) as Record<string, string>;
    const out = new Map<string, City>();
    for (const [k, v] of Object.entries(obj)) {
      if (v === "Anvers") out.set(k, "Anvers");
      else if (v === "Belgium" || v === "Brussels") out.set(k, "Belgium");
    }
    return out;
  } catch {
    return new Map();
  }
}

export async function fetchAllViva(env: VivaEnv, jan1: Date, now: Date): Promise<VivaRow[]> {
  const token = await getToken(env);
  const cityMap = parseCityMap(env);

  const dateFrom = jan1.toISOString().slice(0, 19);
  const dateTo = now.toISOString().slice(0, 19);

  const rows: VivaRow[] = [];
  const PAGE_SIZE = 500;
  let page = 1;

  while (true) {
    const url = new URL(`${API_BASE}/reporting/v1/transactions`);
    url.searchParams.set("DateFrom", dateFrom);
    url.searchParams.set("DateTo", dateTo);
    url.searchParams.set("PageNumber", String(page));
    url.searchParams.set("PageSize", String(PAGE_SIZE));

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`viva reporting: HTTP ${res.status}`);
    const data = (await res.json()) as unknown;

    let transactions: any[];
    if (Array.isArray(data)) transactions = data;
    else if (data && typeof data === "object") {
      const d = data as { Transactions?: any[]; transactions?: any[] };
      transactions = d.Transactions ?? d.transactions ?? [];
    } else transactions = [];

    if (transactions.length === 0) break;
    for (const t of transactions) rows.push(rowFromTransaction(t, cityMap));
    if (transactions.length < PAGE_SIZE) break;
    page++;
  }
  return rows;
}

function rowFromTransaction(
  t: Record<string, unknown>,
  cityMap: ReadonlyMap<string, City>,
): VivaRow {
  const get = (k1: string, k2: string, fallback: unknown = "") => t[k1] ?? t[k2] ?? fallback;

  const rawStatus = String(get("StatusId", "statusId", "")).trim();
  const status = STATUS_MAP[rawStatus] ?? rawStatus;

  const amountCents = Number(get("Amount", "amount", 0)) || 0;
  const feeCents = Number(get("Fee", "fee", 0)) || 0;
  const tipCents = Number(get("TipAmount", "tipAmount", 0)) || 0;

  const createdRaw = String(
    t.InsDate ?? t.insDate ?? t.TransactionDate ?? t.transactionDate ?? "",
  );
  let createdAt = createdRaw;
  if (createdRaw) {
    const d = new Date(createdRaw.replace("Z", "+00:00"));
    if (!Number.isNaN(d.getTime())) createdAt = d.toISOString();
  }

  const sourceCode = String(get("SourceCode", "sourceCode", "")).trim();
  const city: City = cityMap.get(sourceCode) ?? "Belgium";

  return {
    transactionId: String(get("TransactionId", "transactionId", "")),
    createdAt,
    amount: amountCents / 100,
    fee: feeCents / 100,
    tipAmount: tipCents / 100,
    currency: String(get("CurrencyCode", "currencyCode", "EUR")),
    status,
    orderCode: String(get("OrderCode", "orderCode", "")),
    sourceCode,
    terminalId: String(get("TerminalId", "terminalId", "")),
    cardHolder: String(get("CardHolder", "cardHolder", "")),
    cardNumber: String(get("CardNumber", "cardNumber", "")),
    email: String(get("Email", "email", "")),
    merchantReference: String(get("MerchantTrns", "merchantTrns", "")),
    customerDescription: String(get("CustomerTrns", "customerTrns", "")),
    channel: String(get("ChannelId", "channelId", "")),
    city,
  };
}
