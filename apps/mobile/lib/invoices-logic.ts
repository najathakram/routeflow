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

export interface InvoiceActionInput {
  status: string;
  /** ALL payment rows INCLUDING VOID ones — the server's revert-to-draft gate is
   *  an unfiltered `invoicePayment.count()` (invoices.service.ts:2872), so a
   *  fully-voided payment history still blocks. (Web gates on the non-void sum
   *  and gets a guaranteed error toast in that state; we mirror the server.) */
  paymentCount: number;
  isOrderLinked: boolean;
}

export interface InvoiceActionFlags {
  /** PATCH /invoices/:id items path — "Only DRAFT invoices can be edited". */
  canEdit: boolean;
  /** Server blocks only VOID/PAID; surfaced on the "waiting on money" statuses
   *  (DRAFT has Send already — a reminder there would be a second send control). */
  canSendReminder: boolean;
  /** RF-011: order-linked invoices can't be duplicated (server guard). */
  canDuplicate: boolean;
  /** PAID → DRAFT (payments stay attached; server clears paidAt only). */
  canReopen: boolean;
  /** VOID → DRAFT (re-claims OrderItem.invoicedQty server-side). */
  canUnvoid: boolean;
  canRevertToDraft: boolean;
  /** POST /credit-notes/:id/apply rejects PAID/VOID/WRITTEN_OFF invoices. */
  canApplyCredit: boolean;
}

/** Detail-screen action gating, mirroring the server guards exactly so a
 *  visible tile never earns a guaranteed error toast. */
export function invoiceActionFlags(i: InvoiceActionInput): InvoiceActionFlags {
  const s = i.status;
  return {
    canEdit: s === "DRAFT",
    canSendReminder: s === "SENT" || s === "VIEWED" || s === "OVERDUE" || s === "PARTIAL",
    canDuplicate: !i.isOrderLinked,
    canReopen: s === "PAID",
    canUnvoid: s === "VOID",
    canRevertToDraft: (s === "SENT" || s === "VIEWED" || s === "OVERDUE") && i.paymentCount === 0,
    canApplyCredit: s !== "PAID" && s !== "VOID" && s !== "WRITTEN_OFF",
  };
}

/**
 * An order-linked DRAFT with no delivery batch whose order hasn't been delivered
 * is a "pending mirror" — the order is the source of truth and the server
 * refuses to edit/send the invoice (assertOrderInvoiceUnlocked,
 * invoices.service.ts:2438). Edit the ORDER instead; the invoice follows.
 */
export function isPendingOrderMirror(inv: {
  orderId?: string | null;
  deliveryBatchId?: string | null;
  orderStatus?: string | null;
}): boolean {
  if (!inv.orderId) return false;
  if (inv.deliveryBatchId != null) return false;
  return inv.orderStatus !== "DELIVERED" && inv.orderStatus !== "PARTIALLY_DELIVERED";
}
