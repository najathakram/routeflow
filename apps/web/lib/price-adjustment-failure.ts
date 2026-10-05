import { API_ERROR_CODES } from "@routeflow/types";

/**
 * B1058 (SA-683, B980): the two structured refusals of the bulk price adjustment (ALL_CUSTOMER_SINCE), as FIXED
 * copy for the invoice page. Every sentence below is built from the body's STRUCTURED fields (counts, invoice
 * numbers, cents), never from `body.message`. `null` for anything else, which keeps the page's existing error path.
 *
 *   - 409 PRICE_ADJUSTMENT_PARTIAL: the run stopped after >= 1 invoice committed. `committed` is true: whatever
 *     the page holds for invoices is stale until it is invalidated.
 *   - 400 PRICE_ADJUSTMENT_OVERPAYS: the pre-flight found invoices the change would leave overpaid; nothing was
 *     written (`committed` false).
 * Body shapes: `PriceAdjustmentPartialBody` / `PriceAdjustmentOverpaysBody` in `@routeflow/types`.
 */
export interface PriceAdjustmentFailure {
  title: string;
  lines: string[];
  committed: boolean;
}

/** An invoice number from a structured field: shown only when it looks like one (the server sends tenant text). */
const INVOICE_NUMBER = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/;
const numberOf = (n: unknown): string | null =>
  typeof n === "string" && INVOICE_NUMBER.test(n) ? n : null;
const usd = (n: unknown): string | null =>
  typeof n === "number" && Number.isFinite(n) && n > 0 ? `$${n.toFixed(2)}` : null;
const countOf = (a: unknown): number => (Array.isArray(a) ? a.length : 0);
const invoices = (n: number, verb: string): string =>
  `${n} ${n === 1 ? "invoice" : "invoices"} ${n === 1 ? "was" : "were"} ${verb}`;

const MAX_ROWS = 20;

function partial(data: Record<string, any>): PriceAdjustmentFailure {
  const lines = [`${invoices(countOf(data.applied), "updated")}.`];
  const who = numberOf(data.refused?.invoiceNumber) ?? "One invoice";
  const refusedCode = data.refused?.code;
  if (data.refused) {
    lines.push(
      refusedCode === API_ERROR_CODES.PRICE_ADJUSTMENT_OVERPAYS
        ? `${who} would now be overpaid, so it was not updated. Issue a credit note instead.`
        : refusedCode === API_ERROR_CODES.INVOICE_CHANGED_CONCURRENTLY
          ? `${who} changed while saving and was not updated.`
          : `${who} could not be updated.`,
    );
  }
  if (data.syncFailed) {
    const syncWho = numberOf(data.syncFailed.invoiceNumber) ?? "One invoice";
    lines.push(
      `${syncWho} was updated, but its order totals could not be refreshed. Check its order.`,
    );
  }
  const skipped = countOf(data.skipped);
  if (skipped > 0) lines.push(`${invoices(skipped, "not attempted")}.`);
  lines.push("Review them, then apply the change again to finish the rest.");
  return { title: "Prices partly updated", lines, committed: true };
}

function overpays(data: Record<string, any>): PriceAdjustmentFailure {
  const rows: unknown[] = Array.isArray(data.overpaid) ? data.overpaid : [];
  const shown = rows.slice(0, MAX_ROWS).map((r: any) => {
    const amount = usd(r?.overpaidBy);
    return `${numberOf(r?.invoiceNumber) ?? "An invoice"} would be overpaid${amount ? ` by ${amount}` : ""}`;
  });
  if (rows.length > MAX_ROWS) shown.push(`and ${rows.length - MAX_ROWS} more`);
  return {
    title: "Prices not changed",
    lines: [
      `This change would leave ${rows.length} ${rows.length === 1 ? "invoice" : "invoices"} overpaid, so nothing was updated.`,
      ...shown,
      "Issue a credit note on each of them instead.",
    ],
    committed: false,
  };
}

export function priceAdjustmentFailure(err: unknown): PriceAdjustmentFailure | null {
  const response = (err as { response?: { status?: number; data?: unknown } } | null)?.response;
  const data = response?.data;
  if (!data || typeof data !== "object") return null;
  const code = (data as { code?: unknown }).code;
  if (response?.status === 409 && code === API_ERROR_CODES.PRICE_ADJUSTMENT_PARTIAL)
    return partial(data as Record<string, any>);
  if (response?.status === 400 && code === API_ERROR_CODES.PRICE_ADJUSTMENT_OVERPAYS)
    return overpays(data as Record<string, any>);
  return null;
}
