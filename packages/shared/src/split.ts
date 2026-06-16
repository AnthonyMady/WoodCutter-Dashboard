import type { City } from "./venues.ts";

/**
 * Belgium → Brussels/Anvers split rule. Mirrors the legacy `parseCSV` logic:
 *
 *   if (isBelgium) {
 *     city = (odooLoaded && piId && odooMap[piId] === 'Anvers') ? 'Anvers' : 'Brussels';
 *   }
 *
 * Belgium Stripe account covers both physical locations. Each Odoo POS order
 * has a Payment Transaction ID (Stripe `pi_…`) and a POS config name. We build
 * a map from pi_id → city from POS data, then look up each Belgium Stripe
 * charge's payment_intent_id.
 *
 * **Default-to-Brussels rule** (intentional): unmatched transactions are
 * predominantly online payments with no Odoo POS record. Online tips count
 * as Brussels real revenue. Brussels total is therefore higher than a pure
 * in-store xlookup — this is correct, not a bug.
 */
export function splitBelgium(
  paymentIntentId: string | null | undefined,
  odooPaymentMap: ReadonlyMap<string, City>,
): "Belgium" | "Anvers" {
  // Note: "Belgium" represents the Brussels half — the dashboard renders it
  // as "Brussels" but data tags it "Belgium" (the venue's own name).
  if (!paymentIntentId) return "Belgium";
  const matched = odooPaymentMap.get(paymentIntentId);
  return matched === "Anvers" ? "Anvers" : "Belgium";
}

/**
 * Build the pi_id → city map from Odoo POS rows.
 * Belgium POS orders carry the city in the `Point of Sale` column:
 *   "WoodCutter - Brussels" → "Belgium"  (Brussels half)
 *   "WoodCutter - Anvers"   → "Anvers"
 */
export function buildBelgiumPaymentMap(
  posRows: Array<{ paymentTransactionId: string | null; pointOfSale: string }>,
): Map<string, City> {
  const map = new Map<string, City>();
  for (const row of posRows) {
    if (!row.paymentTransactionId) continue;
    if (row.pointOfSale.includes("Anvers") || row.pointOfSale.includes("Antwerp")) {
      map.set(row.paymentTransactionId, "Anvers");
    } else if (row.pointOfSale.includes("Brussels")) {
      map.set(row.paymentTransactionId, "Belgium");
    }
  }
  return map;
}
