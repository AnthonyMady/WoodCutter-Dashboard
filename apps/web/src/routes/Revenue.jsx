// Revenue route — KPIs, charts, table, revenue-split section.
// All aggregation done server-side; this just renders.

import React, { useState } from "react";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  PieChart, Pie, Cell, XAxis, YAxis, Tooltip, Legend, CartesianGrid,
} from "recharts";
import { useRevenue } from "../lib/api.js";

const COLORS = ["#2563eb", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#6366f1"];
const GOLD = "#f59e0b";
const STEEL = "#3b82f6";

const money = (n) => `€${Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const pct = (n) => `${(Number(n ?? 0) * 100).toFixed(1)}%`;

export default function Revenue({ meta }) {
  const venues = meta?.venues ?? [];
  const [venue, setVenue] = useState("All");
  const { data, isLoading, error } = useRevenue(venue);

  if (isLoading) return <div style={{ padding: 24 }}>Loading revenue…</div>;
  if (error) return <ErrorCard error={error} />;
  if (!data || data.error) return <ErrorCard error={data?.error ?? "no data"} />;

  const { kpis, charts, rows, partial } = data;

  return (
    <div>
      <Header title="Revenue" sub={`YTD • ${data.meta.dateRange.from.slice(0, 10)} → ${data.meta.dateRange.to.slice(0, 10)}`}>
        <select value={venue} onChange={(e) => setVenue(e.target.value)}
          style={{ padding: "6px 10px", border: "1px solid #e5e7eb", borderRadius: 6, fontSize: 13, background: "#fff", color: "#111827" }}>
          {["All", ...venues].map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </Header>

      {partial?.length > 0 && <PartialBanner partial={partial} />}

      <Grid cols={3}>
        <Kpi label="Total Revenue"   value={money(kpis.totalRevenue)} />
        <Kpi label="Total Tips"      value={money(kpis.totalTips)} sub={`Tip rate ${pct(kpis.tipRate)}`} />
        <Kpi label="Avg Transaction" value={money(kpis.avgTransaction)} />
        <Kpi label="Avg Tip"         value={money(kpis.avgTip)} />
        <Kpi label="In-store %"      value={pct(kpis.inStorePct)} />
      </Grid>

      <Card title="Revenue trend by city">
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={dailyByCityFlat(charts.revenueTrend)}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
            <XAxis dataKey="date" stroke="#9ca3af" />
            <YAxis stroke="#9ca3af" tickFormatter={money} />
            <Tooltip formatter={money} />
            <Legend />
            {citiesFromTrend(charts.revenueTrend).map((city, i) => (
              <Line key={city} type="monotone" dataKey={city} stroke={COLORS[i % COLORS.length]} dot={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </Card>

      <Grid cols={2}>
        <Card title="In-store vs Online"><Donut data={charts.paymentTypeDonut} /></Card>
        <Card title="Tips vs Net"><Donut data={charts.tipDonut} /></Card>
      </Grid>

      <Card title="Revenue by city">
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={charts.revenueByCity}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
            <XAxis dataKey="city" stroke="#9ca3af" />
            <YAxis stroke="#9ca3af" tickFormatter={money} />
            <Tooltip formatter={money} />
            <Bar dataKey="revenue" fill={STEEL} />
          </BarChart>
        </ResponsiveContainer>
      </Card>

      <h2 style={{ fontSize: 18, fontWeight: 600, marginTop: 32, marginBottom: 12, color: "#111827" }}>
        Revenue split
      </h2>

      <Grid cols={2}>
        <Card title="Annual targets (YTD progress)"><Targets data={charts.targets} /></Card>

        <Card title="Revenue stream">
          <Donut data={[
            { label: "Invoices",      value: charts.streamDonut.invoices },
            { label: "POS",           value: charts.streamDonut.pos },
            { label: "Stripe Online", value: charts.streamDonut.stripeOnline },
            { label: "Tips",          value: charts.streamDonut.tips },
          ]} />
        </Card>

        <Card title="Tips per city — previous month">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={charts.cityTipsPrevMonth}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis dataKey="city" stroke="#9ca3af" />
              <YAxis stroke="#9ca3af" tickFormatter={money} />
              <Tooltip formatter={money} />
              <Bar dataKey="tips" fill={GOLD} />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card title="F&B revenue per city — previous month">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={charts.cityFnbPrevMonth}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis dataKey="city" stroke="#9ca3af" />
              <YAxis stroke="#9ca3af" tickFormatter={money} />
              <Tooltip formatter={money} />
              <Bar dataKey="fnb" fill={STEEL} />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card title="YTD pace"><Pace data={charts.pace} /></Card>

        <Card title="Invoice pipeline">
          <Donut data={charts.invoicePipeline.map((p) => ({ label: p.status, value: p.amount }))} />
        </Card>
      </Grid>

      <Card title={`Recent transactions (${rows?.length ?? 0})`}>
        <Table rows={rows ?? []} />
      </Card>
    </div>
  );
}

function Header({ title, sub, children }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16 }}>
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "#111827", letterSpacing: "-0.3px" }}>{title}</h1>
        <p style={{ fontSize: 12, color: "#9ca3af", marginTop: 2 }}>{sub}</p>
      </div>
      <div>{children}</div>
    </div>
  );
}

function Grid({ cols, children }) {
  return <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 12, marginBottom: 12 }}>{children}</div>;
}

function Card({ title, children }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, marginBottom: 12 }}>
      <p style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 12 }}>{title}</p>
      {children}
    </div>
  );
}

function Kpi({ label, value, sub }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: 16 }}>
      <p style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.07em" }}>{label}</p>
      <p style={{ fontSize: 24, fontWeight: 700, color: "#111827", marginTop: 4 }}>{value}</p>
      {sub && <p style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>{sub}</p>}
    </div>
  );
}

function Donut({ data }) {
  return (
    <ResponsiveContainer width="100%" height={250}>
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="label" innerRadius={60} outerRadius={90} paddingAngle={2}>
          {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
        </Pie>
        <Tooltip formatter={money} />
        <Legend />
      </PieChart>
    </ResponsiveContainer>
  );
}

function Targets({ data }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {data.map((t) => {
        const pctVal = t.target ? Math.min(100, (t.ytd / t.target) * 100) : 0;
        return (
          <div key={t.city}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
              <span style={{ fontWeight: 500, color: "#111827" }}>{t.city}</span>
              <span style={{ color: "#6b7280" }}>
                {money(t.ytd)} {t.target ? `/ ${money(t.target)} (${pctVal.toFixed(0)}%)` : "(no target)"}
              </span>
            </div>
            <div style={{ background: "#f3f4f6", borderRadius: 4, height: 8 }}>
              <div style={{ background: STEEL, height: 8, borderRadius: 4, width: `${pctVal}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Pace({ data }) {
  if (!data?.length) return <p style={{ color: "#9ca3af", fontSize: 12 }}>No pace data.</p>;
  const dateMap = new Map();
  for (const series of data) {
    for (const point of series.series) {
      const row = dateMap.get(point.date) ?? { date: point.date };
      row[`${series.city}_actual`] = point.actual;
      row[`${series.city}_target`] = point.target;
      dateMap.set(point.date, row);
    }
  }
  const rows = [...dateMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  return (
    <ResponsiveContainer width="100%" height={250}>
      <LineChart data={rows}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
        <XAxis dataKey="date" stroke="#9ca3af" />
        <YAxis stroke="#9ca3af" tickFormatter={money} />
        <Tooltip formatter={money} />
        <Legend />
        {data.map((s, i) => (
          <Line key={`${s.city}-actual`} type="monotone" dataKey={`${s.city}_actual`} name={`${s.city} (actual)`}
            stroke={i === 0 ? GOLD : STEEL} dot={false} strokeWidth={2} />
        ))}
        {data.map((s, i) => (
          <Line key={`${s.city}-target`} type="monotone" dataKey={`${s.city}_target`} name={`${s.city} (target)`}
            stroke={i === 0 ? GOLD : STEEL} dot={false} strokeDasharray="4 4" />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

function Table({ rows }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid #e5e7eb", color: "#6b7280" }}>
            <Th>Date</Th><Th>City</Th><Th>Status</Th><Th>Type</Th><Th align="right">Amount</Th><Th align="right">Tip</Th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 50).map((r) => (
            <tr key={r.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
              <Td>{r.createdAt.slice(0, 16).replace("T", " ")}</Td>
              <Td>{r.city}</Td>
              <Td>{r.status}</Td>
              <Td>{r.paymentType}</Td>
              <Td align="right">{money(r.amount)}</Td>
              <Td align="right">{r.tipAmount ? money(r.tipAmount) : "—"}</Td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 50 && <p style={{ fontSize: 11, color: "#9ca3af", marginTop: 8 }}>Showing 50 of {rows.length} rows.</p>}
    </div>
  );
}

function Th({ children, align = "left" }) {
  return <th style={{ textAlign: align, padding: "8px 4px", fontWeight: 500, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>{children}</th>;
}

function Td({ children, align = "left" }) {
  return <td style={{ textAlign: align, padding: "8px 4px", color: "#111827" }}>{children}</td>;
}

function PartialBanner({ partial }) {
  return (
    <div style={{ background: "#fef3c7", border: "1px solid #fcd34d", borderRadius: 8, padding: "10px 14px", marginBottom: 12, fontSize: 12, color: "#92400e" }}>
      ⚠ Some sources are stale: {partial.slice(0, 3).map((p) => `${p.source}${p.venue ? ` (${p.venue})` : ""}`).join(", ")}
      {partial.length > 3 ? ` and ${partial.length - 3} more.` : ""}
    </div>
  );
}

function ErrorCard({ error }) {
  return (
    <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: 16, color: "#991b1b" }}>
      Error loading revenue data: {String(error?.message ?? error)}
    </div>
  );
}

function citiesFromTrend(trend) {
  return [...new Set(trend.map((p) => p.city))];
}

function dailyByCityFlat(trend) {
  const map = new Map();
  for (const p of trend) {
    const row = map.get(p.date) ?? { date: p.date };
    row[p.city] = (row[p.city] ?? 0) + p.revenue;
    map.set(p.date, row);
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}
