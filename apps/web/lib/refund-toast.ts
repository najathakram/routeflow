import type { ProcessRefundResult } from "@/lib/api/returns";

/**
 * B959: what the refund-success toast says. An item that was NOT billed on the order got no refund and is named (never a silent
 * $0); a credit note is claimed only when one was actually minted.
 */
export function refundSuccessToast(
  method: "CREDIT_NOTE" | "EXTERNAL_REFUND",
  res: Pick<ProcessRefundResult, "unbilledItems"> & { creditNoteId?: string | null },
): { title: string; description: string } {
  const unbilled = res?.unbilledItems ?? [];
  const minted = method === "CREDIT_NOTE" && !!res?.creditNoteId;
  return {
    title:
      unbilled.length > 0
        ? "Refunded, but not every item"
        : method === "CREDIT_NOTE"
          ? "Store credit issued"
          : "Refund recorded",
    description: [
      minted
        ? "A credit note has been minted for the customer."
        : method === "CREDIT_NOTE"
          ? "No credit note was needed."
          : "The return has been marked as refunded outside RouteFlow.",
      ...unbilled.map((u) => u.message),
    ].join(" "),
  };
}
