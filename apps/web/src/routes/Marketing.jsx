// Marketing route — Google Ads / Meta Ads / Blend / Shooters tabs.
// Server pre-aggregates KPIs, daily series, top-N campaigns; this just renders.

import React, { useState } from "react";
import {
  ResponsiveContainer, ComposedChart, Line, Bar, BarChart,
  PieChart, Pie, Cell, XAxis, YAxis, Tooltip, Legend, CartesianGrid,
} from "recharts";
import { useMarketing } from "../lib/api.js";

const COLORS = ["#2563eb", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"];
const money = (n) => `€${Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const num   = (n) => Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
const pct   = (n) => `${(Number(n ?? 0) * 100).toFixed(1)}%`;

const TABS = [
  { id: "google",   label: "Google Ads"  },
  { id: "meta",     label: "Meta Ads"    },
  { id: "blend",    label: "Blend"       },
  { id: "shooters", label: "Shooters",   gated: true },
];

export default function Marketing({ meta }) {
  const venues = meta?.venues ?? [];
  const canSeeShooters = meta?.canSeeShooters ?? false;

  const [venue, setVenue] = useState("All");
  const [tab, setTab]     = useState("google");

  const { data, isLoading, error } = useMarketing(
    tab === "shooters" ? "Shooters Brussels" : venue,
  );

  if (isLoading) return <div style={{ padding: 24 }}>Loading marketing…</div>;
  if (error) return <ErrorCard error={error} />;
  if (!data || data.error) return <ErrorCard error={data?.error ?? "no data"} />;

  return (
    <div>
      <Header
        title={`${TABS.find((t) => t.id === tab)?.label ?? "Marketing"}`}
        sub={`YTD • ${data.meta.dateRange.from.slice(0, 10)} → ${data.meta.dateRange.to.slice(0, 10)}`}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Tabs tab={tab} onChange={setTab} canSeeShooters={canSeeShooters} />
          <select value={venue} onChange={(e) => setVenue(e.target.value)} disabled={tab === "shooters"}
            style={{ padding: "6px 10px", border: "1px solid #e5e7eb", borderRadius: 6, fontSize: 13, background: "#fff" }}>
            {["All", ...venues.filter((v) => v !== "Shooters Brussels")].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
      </Header>

      {tab === "google"   && <GoogleView data={data.google} />}
      {tab === "meta"     && <MetaView   data={data.meta_ads} />}
      {tab === "blend"    && <BlendView  google={data.google} meta={data.meta_ads} />}
      {tab === "shooters" && <GoogleView data={data.google} subtitle="Shooters Brussels — restricted access" />}
    </div>
  );
}

function Tabs({ tab, onChange, canSeeShooters }) {
  return (
    <div style={{ display: "flex", border: "1px solid #e5e7eb", borderRadius: 6, overflow: "hidden" }}>
      {TABS.map((t) => {
        const disabled = t.gated && !canSeeShooters;
        const active = tab === t.id;
        return (
          <button key={t.id} disabled={disabled} onClick={() => onChange(t.id)}
            style={{
              padding: "6px 12px", fontSize: 13, fontWeight: 500,
              background: active ? "#eff6ff" : "#fff",
              color: disabled ? "#d1d5db" : active ? "#2563eb" : "#6b7280",
              border: "none", borderRight: "1px solid #e5e7eb",
              cursor: disabled ? "not-allowed" : "pointer",
            }}>
            {t.label} {disabled && "🔒"}
          </button>
        );
      })}
    </div>
  );
}

function GoogleView({ data, subtitle }) {
  const k = data.kpis;
  return (
    <>
      {subtitle && <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 12 }}>{subtitle}</p>}
      <Grid cols={3}>
        <Kpi label="Spend"       value={money(k.spend)} />
        <Kpi label="Conversions" value={num(k.conversions)} sub={`CPA ${money(k.cpa)}`} />
        <Kpi label="Conv. Value" value={money(k.conversionValue)} />
        <Kpi label="ROAS"        value={k.roas.toFixed(2) + "×"} sub={`CPC ${money(k.cpc)}`} />
        <Kpi label="Clicks"      value={num(k.clicks)} sub={`CTR ${pct(k.ctr)}`} />
        <Kpi label="Impressions" value={num(k.impressions)} />
      </Grid>

      <Card title="Daily spend & conversions">
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={data.daily}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
            <XAxis dataKey="date" stroke="#9ca3af" />
            <YAxis yAxisId="left" stroke="#9ca3af" tickFormatter={money} />
            <YAxis yAxisId="right" orientation="right" stroke="#9ca3af" />
            <Tooltip />
            <Legend />
            <Bar yAxisId="left"  dataKey="spend"        fill={COLORS[0]} />
            <Line yAxisId="right" dataKey="conversions" stroke={COLORS[1]} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </Card>

      <Grid cols={2}>
        <Card title="Spend by country">
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie data={data.byCountry} dataKey="spend" nameKey="country" innerRadius={60} outerRadius={90}>
                {data.byCountry.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip formatter={money} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Top 7 by ROAS">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={data.topByRoas} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis type="number" stroke="#9ca3af" />
              <YAxis type="category" dataKey="campaign" stroke="#9ca3af" width={140} />
              <Tooltip />
              <Bar dataKey="roas" fill={COLORS[0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </Grid>

      <Card title="Top 7 by spend">
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={data.topBySpend} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
            <XAxis type="number" stroke="#9ca3af" tickFormatter={money} />
            <YAxis type="category" dataKey="campaign" stroke="#9ca3af" width={140} />
            <Tooltip formatter={money} />
            <Bar dataKey="spend" fill={COLORS[0]} />
          </BarChart>
        </ResponsiveContainer>
      </Card>
    </>
  );
}

function MetaView({ data }) {
  const k = data.kpis;
  return (
    <>
      <Grid cols={3}>
        <Kpi label="Spend"       value={money(k.spend)} />
        <Kpi label="Actions"     value={num(k.actions)} />
        <Kpi label="Clicks"      value={num(k.clicks)} sub={`CTR ${pct(k.ctr)}`} />
        <Kpi label="CPC"         value={money(k.cpc)} />
        <Kpi label="Impressions" value={num(k.impressions)} />
      </Grid>

      <Card title="Daily spend">
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={data.daily}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
            <XAxis dataKey="date" stroke="#9ca3af" />
            <YAxis stroke="#9ca3af" tickFormatter={money} />
            <Tooltip formatter={money} />
            <Bar dataKey="spend" fill={COLORS[0]} />
          </BarChart>
        </ResponsiveContainer>
      </Card>

      <Grid cols={2}>
        <Card title="Spend by country">
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie data={data.byCountry} dataKey="spend" nameKey="country" innerRadius={60} outerRadius={90}>
                {data.byCountry.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip formatter={money} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Top 7 by spend">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={data.topBySpend} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis type="number" stroke="#9ca3af" tickFormatter={money} />
              <YAxis type="category" dataKey="campaign" stroke="#9ca3af" width={140} />
              <Tooltip formatter={money} />
              <Bar dataKey="spend" fill={COLORS[0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </Grid>
    </>
  );
}

function BlendView({ google, meta }) {
  const totalSpend = google.kpis.spend + meta.kpis.spend;
  const gPct = totalSpend > 0 ? google.kpis.spend / totalSpend : 0;
  const mPct = totalSpend > 0 ? meta.kpis.spend   / totalSpend : 0;

  const dateMap = new Map();
  for (const d of google.daily) {
    const r = dateMap.get(d.date) ?? { date: d.date, google: 0, meta: 0 };
    r.google += d.spend ?? 0;
    dateMap.set(d.date, r);
  }
  for (const d of meta.daily) {
    const r = dateMap.get(d.date) ?? { date: d.date, google: 0, meta: 0 };
    r.meta += d.spend ?? 0;
    dateMap.set(d.date, r);
  }
  const daily = [...dateMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  return (
    <>
      <Grid cols={2}>
        <Card title={`Google Ads — ${pct(gPct)} of spend`}>
          <Grid cols={3}>
            <Kpi label="Spend"       value={money(google.kpis.spend)} />
            <Kpi label="ROAS"        value={google.kpis.roas.toFixed(2) + "×"} />
            <Kpi label="Conversions" value={num(google.kpis.conversions)} />
          </Grid>
        </Card>
        <Card title={`Meta Ads — ${pct(mPct)} of spend`}>
          <Grid cols={3}>
            <Kpi label="Spend"   value={money(meta.kpis.spend)} />
            <Kpi label="Clicks"  value={num(meta.kpis.clicks)} />
            <Kpi label="Actions" value={num(meta.kpis.actions)} />
          </Grid>
        </Card>
      </Grid>

      <Card title="Daily spend (combined)">
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={daily}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
            <XAxis dataKey="date" stroke="#9ca3af" />
            <YAxis stroke="#9ca3af" tickFormatter={money} />
            <Tooltip formatter={money} />
            <Legend />
            <Bar dataKey="google" stackId="a" fill={COLORS[0]} />
            <Bar dataKey="meta"   stackId="a" fill={COLORS[1]} />
          </BarChart>
        </ResponsiveContainer>
      </Card>
    </>
  );
}

function Header({ title, sub, children }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16 }}>
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "#111827", letterSpacing: "-0.3px" }}>{title}</h1>
        <p style={{ fontSize: 12, color: "#9ca3af", marginTop: 2 }}>{sub}</p>
      </div>
      {children}
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
      <p style={{ fontSize: 22, fontWeight: 700, color: "#111827", marginTop: 4 }}>{value}</p>
      {sub && <p style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>{sub}</p>}
    </div>
  );
}

function ErrorCard({ error }) {
  return (
    <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: 16, color: "#991b1b" }}>
      Error loading marketing data: {String(error?.message ?? error)}
    </div>
  );
}
