import { describe, expect, it } from "vitest";
import { exVat, stripeOnlineExVat, vatDivisor } from "../src/vat.ts";

describe("vat", () => {
  it("Belgium uses 1.21 divisor", () => {
    expect(vatDivisor("Belgium")).toBe(1.21);
  });

  it("Berlin uses 1.19 divisor", () => {
    expect(vatDivisor("Berlin")).toBe(1.19);
  });

  it("exVat divides amount by divisor", () => {
    expect(exVat(121, "Belgium")).toBeCloseTo(100, 5);
  });

  it("stripeOnlineExVat — VAT only applies to non-tip portion", () => {
    // €121 total in Belgium with €11 tip:
    // VAT applies to €110 → €110 / 1.21 = €90.909...
    // Plus the €11 tip (VAT-exempt) = €101.909...
    expect(stripeOnlineExVat(121, 11, "Belgium")).toBeCloseTo(11 + 110 / 1.21, 5);
  });

  it("stripeOnlineExVat — €0 tip behaves like exVat", () => {
    expect(stripeOnlineExVat(121, 0, "Belgium")).toBeCloseTo(100, 5);
  });

  it("stripeOnlineExVat — no negative amounts from rounding", () => {
    // Edge case: tip exactly equal to amount
    expect(stripeOnlineExVat(10, 10, "Belgium")).toBeCloseTo(10, 5);
  });
});
