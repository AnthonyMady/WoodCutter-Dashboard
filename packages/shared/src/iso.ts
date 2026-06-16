// ISO week + month helpers. Pure functions, deterministic on input date —
// no Date.now() so the same row always produces the same week label.

/** ISO 8601 week number (Mon=1..Sun=7). */
export function isoWeekOf(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

/** ISO week year (handles year boundaries). */
export function isoWeekYearOf(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  return d.getUTCFullYear();
}

/** "2026-W23" key. */
export function isoWeekKey(date: Date): string {
  return `${isoWeekYearOf(date)}-W${String(isoWeekOf(date)).padStart(2, "0")}`;
}

/** "2026-05" month key. */
export function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Previous *completed* calendar month relative to `now`.
 * On June 1 returns "2026-05". On June 15 also returns "2026-05".
 *
 * The legacy dashboard uses this for the "city tips previous month" and
 * "city F&B previous month" charts — auto-advances on month rollover.
 */
export function prevMonthKey(now: Date): string {
  const firstOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastOfPrevMonth = new Date(firstOfThisMonth.getTime() - 86_400_000);
  return monthKey(lastOfPrevMonth);
}

export function prevMonthLabel(now: Date): string {
  const firstOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastOfPrevMonth = new Date(firstOfThisMonth.getTime() - 86_400_000);
  return lastOfPrevMonth.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** YTD start = Jan 1 of `now`'s year (UTC). */
export function ytdStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
}
