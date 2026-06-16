// API client — TanStack Query hooks. Cloudflare Access handles auth at the edge;
// the JWT cookie is sent automatically by the browser to /api/* on the same domain.

import { useQuery } from "@tanstack/react-query";

// VITE_API_BASE lets you point at a separate api Worker URL (e.g. workers.dev)
// when the dashboard is on a different host. Defaults to same-origin /api.
const API_BASE = import.meta.env.VITE_API_BASE
  ? `${import.meta.env.VITE_API_BASE}/api`
  : "/api";

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function get(path) {
  const res = await fetch(`${API_BASE}${path}`, { credentials: "include" });
  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch {}
    const msg = body?.error ?? `HTTP ${res.status}`;
    throw new ApiError(msg, res.status);
  }
  return res.json();
}

export function useMeta() {
  return useQuery({ queryKey: ["meta"], queryFn: () => get("/meta") });
}

export function useRevenue(venue) {
  return useQuery({
    queryKey: ["revenue", venue],
    queryFn: () => get(`/revenue?venue=${encodeURIComponent(venue)}`),
  });
}

export function useMarketing(venue) {
  return useQuery({
    queryKey: ["marketing", venue],
    queryFn: () => get(`/marketing?venue=${encodeURIComponent(venue)}`),
  });
}

export function useDigest() {
  return useQuery({ queryKey: ["digest"], queryFn: () => get("/digest") });
}

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => get("/health"),
    refetchInterval: 60_000,
  });
}
