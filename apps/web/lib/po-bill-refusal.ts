/**
 * The bill-vs-PO refusal (units/PO step 7). A vendor bill linked to a purchase order may not bill more
 * than the PO authorised; the API answers 409 `BILL_EXCEEDS_PO` with one violation per offending line.
 * A toast vanishes before the operator has matched the lines, so the form keeps this as an inline alert.
 */

export interface PoRefusalViolation {
  reason: string;
  description: string;
  billed: string;
  allowed: string;
}

export interface PoBillRefusal {
  poNumber: string;
  /** One plain-language line per offending bill line. */
  lines: string[];
  /** What to do next — the server's own advice, or ours if it sent none. */
  advice: string;
}

const ADVICE =
  "Edit the purchase order to match the invoice first (or correct the bill), then try again.";

function describe(v: PoRefusalViolation, poNumber: string): string {
  switch (v.reason) {
    case "UNMAPPED_LINE":
      return `“${v.description}” isn't linked to a product on ${poNumber} — freight and other charges belong on their own bill.`;
    case "NOT_ON_PO":
      return `“${v.description}” is not on ${poNumber}.`;
    case "QTY_EXCEEDS_PO":
      return `“${v.description}”: billed ${v.billed} pcs, ${poNumber} allows ${v.allowed}.`;
    case "PRICE_EXCEEDS_PO":
      return `“${v.description}”: billed at ${v.billed} per piece, ${poNumber} allows ${v.allowed}.`;
    default:
      return `The bill totals ${v.billed}, ${poNumber} authorised ${v.allowed}.`;
  }
}

/** The refusal to show inline, or null when `err` is any other error (the caller toasts it). */
export function getPoBillRefusal(err: unknown): PoBillRefusal | null {
  const data = (err as { response?: { data?: Record<string, unknown> } })?.response?.data;
  if (!data || data.code !== "BILL_EXCEEDS_PO") return null;
  const poNumber =
    typeof data.poNumber === "string" && data.poNumber ? data.poNumber : "the purchase order";
  const violations = Array.isArray(data.violations)
    ? (data.violations as PoRefusalViolation[])
    : [];
  const lines = violations.map((v) => describe(v, poNumber));
  if (lines.length === 0) lines.push(`This bill is more than ${poNumber} allows.`);
  return { poNumber, lines, advice: ADVICE };
}
