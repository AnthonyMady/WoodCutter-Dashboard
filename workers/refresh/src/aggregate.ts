// Orchestration layer — takes per-source data and produces api Worker payloads.
// All Belgium/Anvers splitting, VAT division, ISO week tagging, KPI rollups,
// and prevMonthKey resolution happen here. The dashboard renders, doesn't compute.

import {
  ALL_VENUES,
  buildBelgiumPaymentMap,
  getAnnualTarget,
  linearTargetAtDate,
  monthKey,
  prevMonthKey,
  splitBelgium,
  stripeOnlineExVat,
  type AdsRow,
  type City,
  type DigestResponse,
  type MarketingResponse,
  type Meta,
  type OdooInvoiceRow,
  type OdooPosRow,
  type PartialReason,
  type RevenueResponse,
  type SourceFreshness,
  type SourceId,
  type StripeRow,
  type Venue,
  type VivaRow,
} from "@woodcutter/shared";

interface RawData {
  stripe: Map<Venue, StripeRow[]>;
  odooPos: Map<Venue, OdooPosRow[]>;
  odooInvoices: Map<Venue, OdooInvoiceRow[]>;
  viva: VivaRow[];
  google: AdsRow[];
  meta: AdsRow[];
}

export interface AggregateInput {
  raw: RawData;
  partial: PartialReason[];
  freshness: Partial<Record<SourceId, SourceFreshness>>;
  now: Date;
  jan1: Date;
}

// ─────────────────────────────── REVENUE ──────────────────────────────────

export function buildRevenue(input: AggregateInput, venueFilter: Venue | "All"): RevenueResponse {
  const { raw, partial, freshness, now, jan1 } = input;

  const belgiumPosRows = raw.odooPos.get("Belgium") ?? [];
  const belgiumPaymentMap = buildBelgiumPaymentMap(belgiumPosRows);

  const stripeRowsAll: StripeRow[] = [];
  for (const [venue, rows] of raw.stripe) {
    if (venue === "Belgium") {
      for (const r of rows) {
        const city = splitBelgium(r.paymentIntentId, belgiumPaymentMap);
        stripeRowsAll.push({ ...r, city });
      }
    } else {
      stripeRowsAll.push(...rows);
    }
  }

  const matchVenue = (city: City): boolean => {
    if (venueFilter === "All") return true;
    if (venueFilter === "Belgium") return city === "Belgium" || city === "Anvers";
    return city === venueFilter;
  };
  const stripeRows = stripeRowsAll.filter((r) => matchVenue(r.city));

  const posRowsAll: OdooPosRow[] = [];
  for (const rows of raw.odooPos.values()) posRowsAll.push(...rows);
  const posRows = posRowsAll.filter((r) => matchVenue(r.city));

  const invoiceRows: OdooInvoiceRow[] = [];
  for (const [venue, rows] of raw.odooInvoices) {
    if (venueFilter === "All" || venueFilter === venue) invoiceRows.push(...rows);
  }

  // KPIs (Paid only)
  const paid = stripeRows.filter((r) => r.status === "Paid");
  const totalRevenue = sum(paid.map((r) => r.amount));
  const totalTips = sum(paid.map((r) => r.tipAmount));
  const tipRate = totalRevenue > 0 ? totalTips / totalRevenue : 0;
  const avgTransaction = paid.length > 0 ? totalRevenue / paid.length : 0;
  const tipped = paid.filter((r) => r.tipAmount > 0);
  const avgTip = tipped.length > 0 ? totalTips / tipped.length : 0;
  const inStorePct =
    paid.length > 0 ? paid.filter((r) => r.paymentType === "in-store").length / paid.length : 0;

  // Revenue trend (line per city, daily)
  const trendMap = new Map<string, number>();
  for (const r of paid) {
    const date = r.createdAt.slice(0, 10);
    trendMap.set(`${date}|${r.city}`, (trendMap.get(`${date}|${r.city}`) ?? 0) + r.amount);
  }
  const revenueTrend = [...trendMap.entries()].map(([k, revenue]) => {
    const parts = k.split("|");
    return { date: parts[0]!, city: parts[1]! as City, revenue };
  });

  // Donuts
  const inStore = sum(paid.filter((r) => r.paymentType === "in-store").map((r) => r.amount));
  const online = sum(paid.filter((r) => r.paymentType === "online").map((r) => r.amount));
  const paymentTypeDonut = [
    { label: "In-store", value: inStore },
    { label: "Online", value: online },
  ];
  const tipDonut = [
    { label: "Tip", value: totalTips },
    { label: "Net (no tip)", value: totalRevenue - totalTips },
  ];

  // Revenue by city
  const cityMap = new Map<City, number>();
  for (const r of paid) cityMap.set(r.city, (cityMap.get(r.city) ?? 0) + r.amount);
  const revenueByCity = [...cityMap.entries()].map(([city, revenue]) => ({ city, revenue }));

  // Heatmap (day-of-week × hour)
  const heatBuckets = new Map<string, number>();
  for (const r of paid) {
    const d = new Date(r.createdAt);
    const k = `${d.getUTCDay()}|${d.getUTCHours()}`;
    heatBuckets.set(k, (heatBuckets.get(k) ?? 0) + 1);
  }
  const heatmap = [...heatBuckets.entries()].map(([k, count]) => {
    const parts = k.split("|").map(Number);
    return { dow: parts[0]!, hour: parts[1]!, count };
  });

  // Targets thermometers (always 4 cities, regardless of venue filter)
  const targetCities: City[] = ["Belgium", "Anvers", "Berlin", "Frankfurt"];
  const targets = targetCities.map((city) => {
    const ytd = sum(stripeRowsAll.filter((r) => r.status === "Paid" && r.city === city).map((r) => r.amount));
    return { city, ytd, target: getAnnualTarget(city) };
  });

  // Previous-month tips per city
  const prevMK = prevMonthKey(now);
  const cityTipsPrevMonth = aggregateBy<City>(
    stripeRowsAll.filter((r) => r.status === "Paid" && monthKey(new Date(r.createdAt)) === prevMK),
    (r) => r.city,
    (r) => r.tipAmount,
  ).map(([city, tips]) => ({ city, tips }));

  // Previous-month F&B revenue per city (Odoo POS pre-tax)
  const cityFnbPrevMonth = aggregateBy<City>(
    posRowsAll.filter((r) => isFnb(r.productCategory) && monthKey(new Date(r.date)) === prevMK),
    (r) => r.city,
    (r) => r.priceSubtotal,
  ).map(([city, fnb]) => ({ city, fnb }));

  // YTD pace chart
  const paceCities: City[] =
    venueFilter === "Belgium" || venueFilter === "All" ? ["Belgium", "Anvers"] : [venueFilter];
  const pace = paceCities.map((city) => {
    const series: Array<{ date: string; actual: number; target: number | null }> = [];
    let running = 0;
    const days = daysBetween(jan1, now);
    const cityRows = stripeRowsAll
      .filter((r) => r.status === "Paid" && r.city === city)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let idx = 0;
    for (let i = 0; i <= days; i++) {
      const d = new Date(jan1.getTime() + i * 86_400_000);
      const dStr = d.toISOString().slice(0, 10);
      while (idx < cityRows.length && cityRows[idx]!.createdAt.slice(0, 10) === dStr) {
        running += cityRows[idx]!.amount;
        idx++;
      }
      series.push({ date: dStr, actual: running, target: linearTargetAtDate(city, d) });
    }
    return { city, series };
  });

  // Stream donut (revenue by source)
  const invoicesPaid = invoiceRows.filter((r) => r.paymentStatus !== "Reversed");
  const invoicesTotal = sum(invoicesPaid.map((r) => r.untaxedAmount));
  const posTotal = sum(posRows.map((r) => r.priceSubtotal));
  const onlinePaid = paid.filter((r) => r.paymentType === "online");
  const stripeOnlineTotal = sum(
    onlinePaid.map((r) => stripeOnlineExVat(r.amount, r.tipAmount, r.venue) - r.tipAmount),
  );
  const tipsTotal = totalTips;
  const streamDonut = {
    invoices: invoicesTotal,
    pos: posTotal,
    stripeOnline: stripeOnlineTotal,
    tips: tipsTotal,
  };

  // Invoice pipeline donut
  const pipelineMap = aggregateBy<string>(
    invoiceRows,
    (r) => r.paymentStatus || "Unknown",
    (r) => r.untaxedAmount,
  );
  const invoicePipeline = pipelineMap.map(([status, amount]) => ({ status, amount }));

  const rows = stripeRows
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 500);

  const meta: Meta = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    sourceFreshness: freshness,
    venueFilter,
    dateRange: { from: jan1.toISOString(), to: now.toISOString() },
  };

  return {
    meta,
    kpis: { totalRevenue, totalTips, tipRate, avgTransaction, avgTip, inStorePct },
    charts: {
      revenueTrend, paymentTypeDonut, tipDonut, revenueByCity, heatmap,
      targets, cityTipsPrevMonth, cityFnbPrevMonth, pace, streamDonut, invoicePipeline,
    },
    rows,
    partial,
  };
}

// ─────────────────────────────── MARKETING ────────────────────────────────

export function buildMarketing(input: AggregateInput, venueFilter: Venue | "All"): MarketingResponse {
  const { raw, partial, freshness, now, jan1 } = input;

  const matchVenue = (v: Venue | null): boolean => {
    if (venueFilter === "All") return true;
    if (!v) return false;
    return v === venueFilter;
  };

  const google = raw.google.filter((r) => matchVenue(r.venue));
  const metaR = raw.meta.filter((r) => matchVenue(r.venue));

  return {
    meta: {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      sourceFreshness: freshness,
      venueFilter,
      dateRange: { from: jan1.toISOString(), to: now.toISOString() },
    },
    google: {
      kpis: googleKpis(google),
      daily: dailyGoogle(google),
      byCountry: byCountry(google),
      topByRoas: topByRoas(google, 7),
      topBySpend: topBySpendWithRoas(google, 7),
      rows: google,
    },
    meta_ads: {
      kpis: metaKpis(metaR),
      daily: dailyMeta(metaR),
      byCountry: byCountry(metaR),
      topBySpend: topBySpendOnly(metaR, 7),
      topByClicks: topByClicks(metaR, 7),
      rows: metaR,
    },
    partial,
  };
}

function googleKpis(rows: AdsRow[]) {
  const spend = sum(rows.map((r) => r.spend));
  const clicks = sum(rows.map((r) => r.clicks));
  const impressions = sum(rows.map((r) => r.impressions));
  const conversions = sum(rows.map((r) => r.conversions));
  const conversionValue = sum(rows.map((r) => r.conversionValue));
  return {
    spend, clicks, impressions, conversions, conversionValue,
    ctr: impressions > 0 ? clicks / impressions : 0,
    cpc: clicks > 0 ? spend / clicks : 0,
    cpa: conversions > 0 ? spend / conversions : 0,
    roas: spend > 0 ? conversionValue / spend : 0,
  };
}

function metaKpis(rows: AdsRow[]) {
  const spend = sum(rows.map((r) => r.spend));
  const clicks = sum(rows.map((r) => r.clicks));
  const impressions = sum(rows.map((r) => r.impressions));
  const actions = sum(rows.map((r) => r.conversions));
  return {
    spend, clicks, impressions, actions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    cpc: clicks > 0 ? spend / clicks : 0,
  };
}

function dailyGoogle(rows: AdsRow[]) {
  const map = new Map<string, { spend: number; conversions: number }>();
  for (const r of rows) {
    const cur = map.get(r.date) ?? { spend: 0, conversions: 0 };
    cur.spend += r.spend;
    cur.conversions += r.conversions;
    map.set(r.date, cur);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, spend: v.spend, conversions: v.conversions }));
}

function dailyMeta(rows: AdsRow[]) {
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.date, (map.get(r.date) ?? 0) + r.spend);
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, spend]) => ({ date, spend }));
}

function byCountry(rows: AdsRow[]) {
  return aggregateBy<string>(rows, (r) => r.country, (r) => r.spend)
    .map(([country, spend]) => ({ country, spend }))
    .sort((a, b) => b.spend - a.spend);
}

function topByRoas(rows: AdsRow[], n: number) {
  const map = new Map<string, { spend: number; conversionValue: number }>();
  for (const r of rows) {
    const cur = map.get(r.campaignName) ?? { spend: 0, conversionValue: 0 };
    cur.spend += r.spend;
    cur.conversionValue += r.conversionValue;
    map.set(r.campaignName, cur);
  }
  return [...map.entries()]
    .map(([campaign, v]) => ({
      campaign,
      roas: v.spend > 0 ? v.conversionValue / v.spend : 0,
      spend: v.spend,
    }))
    .sort((a, b) => b.roas - a.roas)
    .slice(0, n);
}

function topBySpendWithRoas(rows: AdsRow[], n: number) {
  const map = aggregateBy<string>(rows, (r) => r.campaignName, (r) => r.spend);
  return map
    .map(([campaign, spend]) => {
      const r = rows.find((x) => x.campaignName === campaign);
      return { campaign, spend, roas: r?.roas ?? 0 };
    })
    .sort((a, b) => b.spend - a.spend)
    .slice(0, n);
}

function topBySpendOnly(rows: AdsRow[], n: number) {
  return aggregateBy<string>(rows, (r) => r.campaignName, (r) => r.spend)
    .map(([campaign, spend]) => ({ campaign, spend }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, n);
}

function topByClicks(rows: AdsRow[], n: number) {
  return aggregateBy<string>(rows, (r) => r.campaignName, (r) => r.clicks)
    .map(([campaign, clicks]) => ({ campaign, clicks }))
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, n);
}

// ─────────────────────────────── DIGEST ───────────────────────────────────

/** Replaces weekly_digest.py — produces MTD/MoM/YoY rows per city. */
export function buildDigest(input: AggregateInput): DigestResponse {
  const { raw, freshness, now } = input;
  const { mtd, mom, yoy } = mtdMomYoyRanges(now);

  const stripeAll: StripeRow[] = [];
  for (const rows of raw.stripe.values()) stripeAll.push(...rows);
  const belgiumPaymentMap = buildBelgiumPaymentMap(raw.odooPos.get("Belgium") ?? []);
  const splitRows = stripeAll.map((r) =>
    r.venue === "Belgium" ? { ...r, city: splitBelgium(r.paymentIntentId, belgiumPaymentMap) } : r,
  );

  const sumWindow = (city: City, range: { from: number; to: number }) =>
    sum(
      splitRows
        .filter(
          (r) =>
            r.status === "Paid" &&
            r.city === city &&
            new Date(r.createdAt).getTime() >= range.from * 1000 &&
            new Date(r.createdAt).getTime() <= range.to * 1000,
        )
        .map((r) => r.amount),
    );

  const sumBelgiumCombined = (range: { from: number; to: number }) =>
    sumWindow("Belgium", range) + sumWindow("Anvers", range);

  type CityKey = "Belgium" | "Berlin" | "Frankfurt" | "Hamburg" | "Koln" | "Leipzig";
  const cities: CityKey[] = ["Belgium", "Berlin", "Frankfurt", "Hamburg", "Koln", "Leipzig"];

  const rows = cities.map((city) => {
    const mtdGross = city === "Belgium" ? sumBelgiumCombined(mtd) : sumWindow(city as City, mtd);
    const momGross = city === "Belgium" ? sumBelgiumCombined(mom) : sumWindow(city as City, mom);
    const yoyGross = city === "Belgium" ? sumBelgiumCombined(yoy) : sumWindow(city as City, yoy);
    return {
      rank: 0,
      city: city as City,
      mtdGross,
      momPct: momGross > 0 ? (mtdGross - momGross) / momGross : null,
      yoyPct: yoyGross > 0 ? (mtdGross - yoyGross) / yoyGross : null,
    };
  });

  rows.sort((a, b) => b.mtdGross - a.mtdGross);
  rows.forEach((r, i) => (r.rank = i + 1));

  return {
    meta: {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      sourceFreshness: freshness,
      venueFilter: "All",
      dateRange: {
        from: new Date(mtd.from * 1000).toISOString(),
        to: new Date(mtd.to * 1000).toISOString(),
      },
    },
    rows,
    windows: {
      mtd: { from: new Date(mtd.from * 1000).toISOString(), to: new Date(mtd.to * 1000).toISOString() },
      mom: { from: new Date(mom.from * 1000).toISOString(), to: new Date(mom.to * 1000).toISOString() },
      yoy: { from: new Date(yoy.from * 1000).toISOString(), to: new Date(yoy.to * 1000).toISOString() },
    },
  };
}

/** MTD / MoM / YoY date ranges per weekly_digest.py.
 *  Reference yesterday so running on Jun 1 reports May (avoids Jun 31 issues). */
export function mtdMomYoyRanges(now: Date): {
  mtd: { from: number; to: number };
  mom: { from: number; to: number };
  yoy: { from: number; to: number };
} {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yesterday = new Date(today.getTime() - 86_400_000);
  const refYear = yesterday.getUTCFullYear();
  const refMonth = yesterday.getUTCMonth();
  const dayNum = yesterday.getUTCDate();

  const mtdStart = new Date(Date.UTC(refYear, refMonth, 1));
  const mtdEnd = new Date(Date.UTC(refYear, refMonth, dayNum, 23, 59, 59));

  const prevYear = refMonth === 0 ? refYear - 1 : refYear;
  const prevMonth = refMonth === 0 ? 11 : refMonth - 1;
  const prevLastDay = new Date(Date.UTC(prevYear, prevMonth + 1, 0)).getUTCDate();
  const prevDay = Math.min(dayNum, prevLastDay);
  const momStart = new Date(Date.UTC(prevYear, prevMonth, 1));
  const momEnd = new Date(Date.UTC(prevYear, prevMonth, prevDay, 23, 59, 59));

  const yoyYear = refYear - 1;
  const yoyLastDay = new Date(Date.UTC(yoyYear, refMonth + 1, 0)).getUTCDate();
  const yoyDay = Math.min(dayNum, yoyLastDay);
  const yoyStart = new Date(Date.UTC(yoyYear, refMonth, 1));
  const yoyEnd = new Date(Date.UTC(yoyYear, refMonth, yoyDay, 23, 59, 59));

  return {
    mtd: { from: Math.floor(mtdStart.getTime() / 1000), to: Math.floor(mtdEnd.getTime() / 1000) },
    mom: { from: Math.floor(momStart.getTime() / 1000), to: Math.floor(momEnd.getTime() / 1000) },
    yoy: { from: Math.floor(yoyStart.getTime() / 1000), to: Math.floor(yoyEnd.getTime() / 1000) },
  };
}

// ─────────────────────────────── helpers ──────────────────────────────────

function sum(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

function aggregateBy<K>(
  rows: any[],
  keyFn: (r: any) => K,
  valFn: (r: any) => number,
): Array<[K, number]> {
  const map = new Map<K, number>();
  for (const r of rows) {
    const k = keyFn(r);
    map.set(k, (map.get(k) ?? 0) + valFn(r));
  }
  return [...map.entries()];
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000);
}

const FNB_KEYWORDS = ["food", "drink", "beverage", "bar", "kitchen", "menu", "f&b"];

function isFnb(category: string): boolean {
  if (!category) return false;
  const c = category.toLowerCase();
  return FNB_KEYWORDS.some((k) => c.includes(k));
}
