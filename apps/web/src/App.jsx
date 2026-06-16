import React, { Suspense, lazy } from "react";
import { Routes, Route, NavLink, Navigate } from "react-router-dom";
import { useMeta } from "./lib/api.js";

const Revenue = lazy(() => import("./routes/Revenue.jsx"));
const Marketing = lazy(() => import("./routes/Marketing.jsx"));

const NAV = [
  { to: "/",          label: "Revenue"   },
  { to: "/marketing", label: "Marketing" },
];

export default function App() {
  const meta = useMeta();

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      {/* Sidebar */}
      <aside style={{
        width: 220, position: "fixed", top: 0, bottom: 0, left: 0,
        background: "#fff", borderRight: "1px solid #e5e7eb",
        display: "flex", flexDirection: "column", zIndex: 10,
      }}>
        <div style={{ padding: "24px 24px 20px", borderBottom: "1px solid #f3f4f6" }}>
          <p style={{ fontSize: 15, fontWeight: 700, color: "#111827", letterSpacing: "-0.3px" }}>
            Wood<span style={{ color: "#2563eb" }}>Cutter</span>
          </p>
        </div>
        <nav style={{ padding: 12, flex: 1, overflowY: "auto" }}>
          <p style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.07em", padding: "8px 12px 4px" }}>
            Dashboards
          </p>
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === "/"}
              style={({ isActive }) => ({
                display: "block", padding: "8px 12px", borderRadius: 8,
                fontSize: 13.5, fontWeight: 500,
                color: isActive ? "#2563eb" : "#6b7280",
                background: isActive ? "#eff6ff" : "transparent",
                marginBottom: 1, textDecoration: "none",
              })}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div style={{ padding: "12px 16px", borderTop: "1px solid #f3f4f6", fontSize: 11, color: "#9ca3af" }}>
          {meta.data?.email ?? "—"}
          <FreshnessRow freshness={meta.data?.sourceFreshness} />
        </div>
      </aside>

      <main style={{ marginLeft: 220, flex: 1, padding: "24px 32px" }}>
        <Suspense fallback={<div style={{ padding: 48, color: "#9ca3af" }}>Loading…</div>}>
          <Routes>
            <Route path="/"          element={<Revenue meta={meta.data} />} />
            <Route path="/marketing" element={<Marketing meta={meta.data} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}

function FreshnessRow({ freshness }) {
  if (!freshness) return null;
  const sources = Object.entries(freshness);
  if (sources.length === 0) return null;
  return (
    <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 4 }}>
      {sources.map(([id, f]) => {
        const stale = f?.errorAt != null;
        return (
          <span key={id}
            title={`${id}: ${stale ? "stale" : "ok"} (last ok: ${f?.okAt ?? "never"}${f?.error ? `; ${f.error}` : ""})`}
            style={{
              fontSize: 9, padding: "1px 6px", borderRadius: 4,
              background: stale ? "#fef3c7" : "#dcfce7",
              color: stale ? "#92400e" : "#166534",
              cursor: "help",
            }}>
            {id.replace("supermetrics_", "")}
          </span>
        );
      })}
    </div>
  );
}
