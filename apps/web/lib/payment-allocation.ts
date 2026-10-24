import { roundMoney } from "@routeflow/pricing";

/**
 * B313: mobile's record.tsx caps each row at the invoice's balance ("Cap at the invoice's
 * balance — the server would happily over-pay it"); the web modals edited the raw string with
 * no cap at all, so an operator could type more than an invoice's `amountDue` while mobile
 * silently clamped the same input. Blank/unparseable input passes through untouched so the
 * field stays editable (matching mobile's `value == null` passthrough).
 *
 * Shared by finance/payments/page.tsx and CustomerRecordPaymentModal (REG-B1002: the page had
 * no copy at all) — keep ONE implementation.
 *
 * Opus review (F39): an EARLIER version of this reformatted every keystroke through
 * `roundMoney`/`String`, which rewrites "12.50" to "12.5" mid-type — an in-range value now
 * passes through EXACTLY as typed (decimal in progress, trailing zero and all); only an
 * out-of-range value gets replaced, and only then with a clean rounded string.
 */
export function clampAllocationInput(raw: string, amountDue: number): string {
  const parsed = parseFloat(raw);
  if (raw === "" || Number.isNaN(parsed)) return raw;
  if (parsed < 0) return "0";
  if (parsed > amountDue) return String(roundMoney(amountDue));
  return raw;
}
