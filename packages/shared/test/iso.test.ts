import { describe, expect, it } from "vitest";
import { isoWeekKey, isoWeekOf, monthKey, prevMonthKey, ytdStart } from "../src/iso.ts";

describe("isoWeekOf", () => {
  it("Jan 1 2026 (Thursday) is ISO week 1", () => {
    expect(isoWeekOf(new Date("2026-01-01T00:00:00Z"))).toBe(1);
  });

  it("week 53 boundary — Dec 30 2024 → ISO week 1 of 2025", () => {
    expect(isoWeekOf(new Date("2024-12-30T00:00:00Z"))).toBe(1);
  });
});

describe("isoWeekKey", () => {
  it("formats as YYYY-W##", () => {
    expect(isoWeekKey(new Date("2026-01-05T00:00:00Z"))).toBe("2026-W02");
  });
});

describe("monthKey", () => {
  it("formats YYYY-MM with zero-pad", () => {
    expect(monthKey(new Date("2026-01-15T12:00:00Z"))).toBe("2026-01");
    expect(monthKey(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12");
  });
});

describe("prevMonthKey", () => {
  // CRITICAL: this is the load-bearing month-rollover behaviour. The dashboard's
  // "previous month" charts (tips, F&B) auto-advance based on this. A regression
  // here means stale charts on the 1st of every month.
  it("June 1 returns May", () => {
    expect(prevMonthKey(new Date("2026-06-01T12:00:00Z"))).toBe("2026-05");
  });

  it("June 15 returns May (within-month is still last completed)", () => {
    expect(prevMonthKey(new Date("2026-06-15T12:00:00Z"))).toBe("2026-05");
  });

  it("January 1 returns previous December (year boundary)", () => {
    expect(prevMonthKey(new Date("2026-01-01T12:00:00Z"))).toBe("2025-12");
  });
});

describe("ytdStart", () => {
  it("returns Jan 1 of input year UTC", () => {
    const start = ytdStart(new Date("2026-08-15T12:00:00Z"));
    expect(start.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});
