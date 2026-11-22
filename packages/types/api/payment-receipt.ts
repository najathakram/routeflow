/**
 * SA-1208 D1 (M1-02): what ONE payment covered, read-only. One contract for the api and the web: the server builds the
 * whole view (`readReceiptGroup` in apps/api/src/invoices/payment-receipt-group.ts), a screen prints it as given and
 * never re-adds, re-sorts or picks a number (L-119). Types only, so the api may import it (no-runtime-types-import.spec.ts).
 *
 * The shape is the read shape of a future receipt header (B2), so B2 swaps only the reader's internals. A date or
 * amount that was never recorded reads null, never 0 and never a guess.
 *
 * Staff screens only: `number` and `reference` are staff-typed, so a buyer-facing screen never prints them (SA-1208 D2).
 */
export type ReceiptKind =
  /** Store credit used (CREDIT_NOTE / ADVANCE): never a receipt, never a tender. */
  | "CREDIT_USE"
  /** A null group: one row, keyed by its own id, never merged with anything. */
  | "SINGLE"
  /** A pickup hand-over's tenders: one view per order, never a "check". */
  | "PICKUP_TENDERS"
  /** A split-tender leg (SA-749r2, not on this base): falls back to its own row until its grain is ruled. */
  | "SPLIT_LEG"
  /** Every other non-null group: the rows one office-recorded check or payment covered. */
  | "OFFICE_GROUP";

export interface ReceiptHeader {
  /** The group id, or the row's own id for a one-row view. */
  key: string;
  /** The lowest live `paymentNumber` (compared numerically), else the reference, else null. Never from a VOID row. */
  number: string | null;
  reference: string | null;
  method: string | null;
  /** ISO instant the head row's money was collected (`settledAt ?? paidAt`), null when never recorded. */
  receivedAt: string | null;
  customerId: string;
  /** Pickup views only: the order the tenders belong to. */
  orderId: string | null;
  orderNumber: string | null;
  /** The CONFIRMED (PAID) rows only, rounded. VOID, PENDING and DRAFT rows never count. */
  total: number;
  /** False when no row is PAID: the screen reads "not confirmed". */
  confirmed: boolean;
  /** At least one VOID row beside a live one: the screen adds "check partly voided". */
  partlyVoided: boolean;
}

/** One instrument: the rows of one (method, reference), live and VOID kept apart. */
export interface ReceiptTender {
  method: string;
  reference: string | null;
  amount: number;
  /** True: every row of this entry is VOID (shown struck through, not in the total). */
  voided: boolean;
  paymentIds: string[];
}

/** One row's application to an invoice. */
export interface ReceiptApplication {
  paymentId: string;
  paymentNumber: string | null;
  invoiceId: string;
  invoiceNumber: string;
  amount: number;
  status: string;
  checkStatus: string | null;
  /** Credit uses only: the credit this row consumed, so a screen can link to it. */
  creditNoteId: string | null;
  advancePaymentId: string | null;
}

/** Unused credit: the ORIGINAL amount of the advance linked by `sourcePaymentId`. `amount` null = "not recorded". */
export interface ReceiptUnapplied {
  amount: number | null;
  advancePaymentId: string | null;
}

export interface ReceiptGroupView {
  kind: ReceiptKind;
  /** Null for CREDIT_USE: it is not a receipt. */
  header: ReceiptHeader | null;
  tenders: ReceiptTender[];
  applications: ReceiptApplication[];
  unapplied: ReceiptUnapplied;
}

/**
 * M1-03 (SA-1211 BF-6): the tag a staff payments-LIST row carries when it is one row of an office check. The server reads it
 * from the one receipt reader, so the list prints `total` and never adds rows up. Null on every other row.
 */
export interface PaymentListReceipt {
  key: string;
  number: string | null;
  /** The check's confirmed total (header.total). */
  total: number;
  /** Every invoice the confirmed rows of this check were applied to, in receipt order. */
  invoices: { id: string; invoiceNumber: string }[];
}
