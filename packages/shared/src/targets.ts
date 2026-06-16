import type { City } from "./venues.ts";

// Annual EUR revenue targets per city. Mirrors TARGETS in the legacy index.html.
// Cities without explicit targets render as "no target set" in the dashboard.
export const ANNUAL_TARGETS: Partial<Record<City, number>> = {
  Belgium:   1_050_000, // Brussels (the Belgium venue's "Brussels" half)
  Anvers:    650_000,
  Berlin:    1_050_000,
  Frankfurt: 756_000,
};

export function getAnnualTarget(city: City): number | null {
  return ANNUAL_TARGETS[city] ?? null;
}

/** Linear pace at a given date (EUR target value as of `date`, linear monthly distribution). */
export function linearTargetAtDate(city: City, date: Date): number | null {
  const target = getAnnualTarget(city);
  if (target == null) return null;
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const end = new Date(Date.UTC(date.getUTCFullYear() + 1, 0, 1));
  const elapsed = date.getTime() - start.getTime();
  const total = end.getTime() - start.getTime();
  return (target * elapsed) / total;
}
