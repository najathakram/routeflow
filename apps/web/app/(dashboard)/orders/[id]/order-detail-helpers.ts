import type { CreditSelection } from "../_components/CreditNotePicker";

/**
 * Render a date-only field (stored midnight UTC) as its calendar day. Parsing the
 * parts by hand avoids the day-behind shift `new Date(iso)` causes west of UTC.
 */
export function formatDateOnly(iso: string): string {
  const [y, m, d] = iso.split("T")[0].split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Map the order's stored credit-note intents into the picker's selection shape. */
export function creditSelectionsFromOrder(o: {
  orderCreditNotes?: Array<{ creditNoteId: string; amount?: number | string | null }>;
}): CreditSelection[] {
  return (o.orderCreditNotes ?? []).map((oc) => ({
    creditNoteId: oc.creditNoteId,
    amount: oc.amount != null ? Number(oc.amount) : undefined,
  }));
}
