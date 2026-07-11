/**
 * Pure invoice/payment gating helpers (no api-client/react-query imports so they
 * stay unit-testable in the node Jest env). Mirror the server's guards.
 */

/** An invoice can be written off only from these unpaid-but-live statuses. */
export function canWriteOff(status: string): boolean {
  return status === "SENT" || status === "VIEWED" || status === "PARTIAL" || status === "OVERDUE";
}

/**
 * Whether a recorded payment can be edited/voided: not an Advance/Credit-Note
 * source draw (the server rejects hand-editing those), and not on a terminal
 * payment or invoice state.
 */
export function isPaymentEditable(
  method: string,
  paymentStatus: string | undefined,
  invoiceStatus: string | undefined,
): boolean {
  if (method === "CREDIT_NOTE" || method === "ADVANCE") return false;
  if (paymentStatus === "VOID") return false;
  if (invoiceStatus === "VOID" || invoiceStatus === "WRITTEN_OFF" || invoiceStatus === "PAID")
    return false;
  return true;
}
