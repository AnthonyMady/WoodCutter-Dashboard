import { describe, expect, it } from "vitest";
import { buildBelgiumPaymentMap, splitBelgium } from "../src/split.ts";

describe("buildBelgiumPaymentMap", () => {
  it("maps pi_ ids to Brussels (Belgium) or Anvers based on POS name", () => {
    const map = buildBelgiumPaymentMap([
      { paymentTransactionId: "pi_111", pointOfSale: "WoodCutter - Brussels" },
      { paymentTransactionId: "pi_222", pointOfSale: "WoodCutter - Anvers" },
      { paymentTransactionId: "pi_333", pointOfSale: "WoodCutter - Brussels" },
    ]);
    expect(map.get("pi_111")).toBe("Belgium");
    expect(map.get("pi_222")).toBe("Anvers");
    expect(map.get("pi_333")).toBe("Belgium");
    expect(map.size).toBe(3);
  });

  it("ignores rows with no payment_transaction_id", () => {
    const map = buildBelgiumPaymentMap([
      { paymentTransactionId: null, pointOfSale: "WoodCutter - Brussels" },
    ]);
    expect(map.size).toBe(0);
  });

  it("Antwerp spelling also resolves to Anvers", () => {
    const map = buildBelgiumPaymentMap([
      { paymentTransactionId: "pi_x", pointOfSale: "WoodCutter - Antwerp" },
    ]);
    expect(map.get("pi_x")).toBe("Anvers");
  });
});

describe("splitBelgium", () => {
  const map = new Map<string, "Belgium" | "Anvers">([
    ["pi_anvers", "Anvers"],
    ["pi_brussels", "Belgium"],
  ]);

  it("matches Anvers when pi_ in POS map → Anvers", () => {
    expect(splitBelgium("pi_anvers", map)).toBe("Anvers");
  });

  it("matches Brussels (Belgium) when pi_ in POS map → Belgium", () => {
    expect(splitBelgium("pi_brussels", map)).toBe("Belgium");
  });

  // Default-to-Brussels rule for unmatched Belgium Stripe rows is INTENTIONAL.
  // Online tips come through with no Odoo POS record. Treating them as Brussels
  // is correct — it's the same physical entity. Removing this rule would
  // under-count Brussels revenue.
  it("default-to-Brussels when pi_ not in POS map (online tips)", () => {
    expect(splitBelgium("pi_unknown", map)).toBe("Belgium");
  });

  it("default-to-Brussels when no pi_ at all", () => {
    expect(splitBelgium(null, map)).toBe("Belgium");
    expect(splitBelgium(undefined, map)).toBe("Belgium");
    expect(splitBelgium("", map)).toBe("Belgium");
  });
});
