import { VENUE_CONFIG, type Venue } from "./venues.ts";

// VAT division rules — mirror the legacy dashboard's payment-stream logic.
//
// Stripe online payments arrive incl. VAT and need division by the venue's divisor.
// POS subtotals (Odoo) are already pre-tax — never divide.
// Invoice "Untaxed Amount Signed Currency" is already pre-tax — never divide.
// Tips are VAT-exempt — never divide.

export function vatDivisor(venue: Venue): number {
  return VENUE_CONFIG[venue].vatDivisor;
}

/** Amount excl. VAT for Stripe online (excl. tip — tip is VAT-exempt). */
export function stripeOnlineExVat(amount: number, tip: number, venue: Venue): number {
  const exVatBase = (amount - tip) / vatDivisor(venue);
  return exVatBase + tip;
}

/** Generic ex-VAT helper — only call this on incl-VAT amounts. */
export function exVat(amount: number, venue: Venue): number {
  return amount / vatDivisor(venue);
}
