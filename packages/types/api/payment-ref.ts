/**
 * Row 498 (SA-837): the wire shape of 409 DUPLICATE_PAYMENT_REF, thrown by every InvoicePayment writer that
 * carries a typed reference (POST /invoices/:id/payments, POST /invoices/payments/record,
 * POST /bookkeeping/transactions/:id/payments) when a non-VOID payment of the same customer, method,
 * normalised reference and amount already exists. ONE declaration for the api, the web and the mobile clients.
 */

import { API_ERROR_CODES } from "./error-codes";

/** The existing payment the refusal names. `paidAt` is an ISO instant; `amount` is dollars (the whole payment). */
export interface DuplicatePaymentRefExisting {
  id: string;
  paymentNumber: string | null;
  paidAt: string;
  amount: number;
  /** Null when the existing payment is an AdvancePayment (it belongs to no invoice). */
  invoiceId: string | null;
  invoiceNumber: string | null;
}

export interface DuplicatePaymentRefBody {
  code: typeof API_ERROR_CODES.DUPLICATE_PAYMENT_REF;
  message: string;
  existingPayment: DuplicatePaymentRefExisting;
}
