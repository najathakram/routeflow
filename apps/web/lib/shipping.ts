/**
 * Shared carrier shipment-tracking helpers.
 *
 * When goods ship via a carrier (instead of being delivered on our own route),
 * the order/invoice carries a free-text carrier label + a tracking number. For
 * the carriers we recognise we can build a public "track your package" URL so
 * the operator (and the customer, on the invoice) can open the carrier's own
 * tracking page. The URL is always DERIVED from (carrier, number) — never stored
 * — so it can't be tampered with and stays correct if templates change.
 *
 * This module is mirrored verbatim across api/web/mobile
 * (`apps/api/src/common/shipping.ts`, `apps/web/lib/shipping.ts`,
 * `apps/mobile/lib/shipping.ts`) — change all three together. It is pure TS with
 * no framework imports so the copies stay identical.
 */

export interface CarrierOption {
  /** Normalised key used for URL lookup. */
  id: string;
  /** Human-facing label shown in the carrier picker. */
  label: string;
}

/**
 * Carriers offered in the picker. The first four have a known tracking URL;
 * "Other" lets an operator type any carrier name (no auto-link).
 */
export const CARRIERS: CarrierOption[] = [
  { id: "ups", label: "UPS" },
  { id: "fedex", label: "FedEx" },
  { id: "usps", label: "USPS" },
  { id: "dhl", label: "DHL" },
  { id: "other", label: "Other" },
];

// Public tracking URL templates keyed by normalised carrier id. `{n}` is
// replaced with the URL-encoded tracking number.
const TRACKING_URL_TEMPLATES: Record<string, string> = {
  ups: "https://www.ups.com/track?loc=en_US&tracknum={n}",
  fedex: "https://www.fedex.com/fedextrack/?trknbr={n}",
  usps: "https://tools.usps.com/go/TrackConfirmAction?tLabels={n}",
  dhl: "https://www.dhl.com/us-en/home/tracking.html?tracking-id={n}",
};

/**
 * Map a free-text carrier label to a known carrier id, or null when we don't
 * recognise it (e.g. "Other" or a custom courier). The picker stores exact
 * labels, so the exact matches below cover the normal case; the fuzzy fallback
 * tolerates legacy/hand-typed values.
 */
export function normalizeCarrier(carrier?: string | null): string | null {
  if (!carrier) return null;
  const c = carrier.trim().toLowerCase();
  if (!c) return null;
  if (c === "ups") return "ups";
  if (c === "fedex" || c === "fed ex") return "fedex";
  if (c === "usps") return "usps";
  if (c === "dhl") return "dhl";
  const k = c.replace(/[^a-z]/g, "");
  if (k.includes("fedex")) return "fedex";
  if (k.includes("usps") || k === "uspostalservice") return "usps";
  if (k.includes("dhl")) return "dhl";
  if (k.includes("ups")) return "ups"; // checked last so "usps" never matches here
  return null;
}

/**
 * Build a clickable carrier tracking URL from a carrier label + tracking number.
 * Returns null when the number is blank or the carrier is unknown (the UI then
 * shows the number as plain text instead of a link).
 */
export function getTrackingUrl(
  carrier?: string | null,
  trackingNumber?: string | null,
): string | null {
  const num = (trackingNumber ?? "").trim();
  if (!num) return null;
  const id = normalizeCarrier(carrier);
  if (!id) return null;
  const tmpl = TRACKING_URL_TEMPLATES[id];
  if (!tmpl) return null;
  return tmpl.replace("{n}", encodeURIComponent(num));
}

/** Display label for a stored carrier value (falls back to the raw string). */
export function carrierLabel(carrier?: string | null): string {
  if (!carrier) return "";
  const id = normalizeCarrier(carrier);
  const found = CARRIERS.find((x) => x.id === id);
  return found ? found.label : carrier;
}
