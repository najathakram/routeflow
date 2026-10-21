// ─── Invoices / payments / finance (wave E / imp-10b) ───────────────────────────

import type { CheckStatus } from "./enums";
import type { API_ERROR_CODES } from "./error-codes";

export interface CreatePartialInvoiceItem {
  orderItemId: string;
  qty: number;
}

export interface CreatePartialInvoiceDto {
  orderId: string;
  items: CreatePartialInvoiceItem[];
  dueDate?: string;
  /** Long-form Terms & Conditions text — NEVER a "Net N" label. */
  terms?: string;
  /** Structured "Net N" label describing dueDate. */
  paymentTermsLabel?: string;
  notes?: string;
  send?: boolean;
}

export interface CreateInvoiceItem {
  /** Free-text label. For an unlisted (non-catalog) line, omit productId. */
  description: string;
  productId?: string;
  qty: number;
  unitPrice: number;
  /** Optional box/piece split for boxed products. Server prorates the line. */
  boxes?: number;
  pieces?: number;
  /** BUY_N_GET_M: whole free SELLING units on this line (boxes for a boxed line).
   *  Server subtracts them before pricing — MUST round-trip on an items PATCH. */
  promoFreeUnits?: number;
  /** Flat dollars off this line — server: lineSub = roundMoney(subtotal − discount). */
  discount?: number;
  /** Tax FRACTION (0.08 = 8%), charged on the POST-discount line subtotal. */
  taxRate?: number;
  /** Buyer-visible line note — prints under the description on the PDF (≤2000). */
  notes?: string;
  unitLabel?: string;
  /** H3b: why this price moves off the customer's tier price (≤200). The server requires it off a
   *  SPECIAL (tier) price, as on POST /orders/sell; stored on the line with the acting user. */
  overrideReason?: string;
}

/** An invoice PATCH line: a create line plus the stored row it edits (SA-186) and
 *  an operator-attested pack for an unrecoverable legacy box line (SA-189). */
export interface UpdateInvoiceItem extends CreateInvoiceItem {
  /** Stored line id — the server matches THIS row; unknown/foreign ids are a 400. */
  id?: string;
  /** Integer >= 2, only from an operator who set the box/piece count explicitly. */
  unitsPerBox?: number;
}

export interface SendInvoiceEmailResult {
  success: boolean;
  sentTo: string;
  /**
   * Non-blocking warning: the tenant's own SMTP failed but Resend (RouteFlow's
   * platform mail service) rescued the send, so `success` is still true. Set by
   * `email.service.ts#send()`'s `smtpFallbackReason` (mapped, human-readable —
   * e.g. the STARTTLS-unavailable or M365 Authenticated-SMTP message).
   */
  warning?: string;
  /** The platform address the email actually went out from when `warning` is set. */
  fromAddress?: string;
}

export interface SetCheckStatusDto {
  invoiceId: string;
  paymentId: string;
  status: CheckStatus;
  /** NSF fee billed onto the invoice when status = BOUNCED (omit/0 = no fee). */
  nsfFeeAmount?: number;
  /** True bank landing date — meaningful with CLEARED; sets clearedAt AND
   *  settledAt. Web's own DTO omits this optionally; the server supports it and
   *  cash-basis reporting windows on it. */
  settledAt?: string;
}

/** `TMethod` lets each app plug in its own local payment-method literal union
 *  (web `SelectablePaymentMethod`, mobile `EditablePaymentMethod`) — deliberately
 *  NOT the shared `PaymentMethod` enum (see `packages.md`: apps intentionally
 *  keep their own hand-curated "enterable" subsets of it). */
export interface StandalonePaymentDto<TMethod = string> {
  customerId: string;
  totalAmount: number;
  method: TMethod;
  paidAt?: string;
  /** Bank landing date applied to every allocation row of the group. */
  settledAt?: string | null;
  bankCharges?: number;
  reference?: string;
  notes?: string;
  /** DRAFT records the rows without touching invoice statuses. */
  status?: "DRAFT" | "PAID";
  allocations: { invoiceId: string; amount: number }[];
}

export interface PaymentListParams {
  page?: number;
  limit?: number;
  customerId?: string;
  method?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  sortBy?: string;
  /** Web passes a plain `string` state variable here; mobile's own call site
   *  narrows to `"asc" | "desc"` — kept as the wider `string` so neither caller
   *  needs a cast (near-identical resolution: widen, don't narrow). */
  sortDir?: string;
}

/** `TPayment` is each app's own (divergent) `AllPayment` row shape — this type
 *  only pins the pagination/summary envelope around it. */
export interface PaymentListResponse<TPayment = unknown> {
  data: TPayment[];
  meta: { total: number; page: number; limit: number; totalPages: number };
  summary: { totalReceived: number; count: number; advanceBalance: number };
}

export interface ExpenseCategory {
  id: string;
  name: string;
  code?: string;
  isCustom?: boolean;
}

export interface CreateRecurringInvoiceItem {
  description: string;
  productId?: string;
  qty: number;
  unitPrice: number;
  discount?: number;
  taxRate?: number;
}

export interface RecurringInvoiceItem extends CreateRecurringInvoiceItem {
  id?: string;
}

export interface CreateRecurringInvoiceDto {
  customerId: string;
  frequency: import("./enums").RecurringFrequency;
  /** 0–6, sent only for WEEKLY/BIWEEKLY. */
  dayOfWeek?: number;
  /** 1–28, sent only for MONTHLY. */
  dayOfMonth?: number;
  autoSend?: boolean;
  notes?: string;
  terms?: string;
  discount?: number;
  shippingFee?: number;
  /** Full ISO datetime for the first run (NOT bare YYYY-MM-DD). */
  nextRunAt: string;
  items: CreateRecurringInvoiceItem[];
}

export interface RecurringInvoice {
  id: string;
  customerId: string;
  customer?: { id: string; businessName: string };
  frequency: import("./enums").RecurringFrequency;
  dayOfWeek?: number;
  dayOfMonth?: number;
  isActive: boolean; // state is a boolean, not a status enum
  autoSend: boolean;
  notes?: string;
  terms?: string;
  discount?: number;
  shippingFee?: number;
  nextRunAt: string;
  lastRunAt?: string;
  /** F13/#612: outcome of the last scheduled run. Plain `String?` in Prisma, not an enum. */
  lastRunStatus?: "SUCCESS" | "FAILED" | null;
  /**
   * F13/#612: failure text of the last run. A value starting with
   * `RUN_UNFINALIZED_PREFIX` (see `apps/web/lib/api/invoices.ts`) means the invoice WAS
   * created and only the run bookkeeping failed — never offer that as a retry.
   */
  lastError?: string | null;
  items: RecurringInvoiceItem[];
  createdAt: string;
}

// ─── Vendor-bill scan / AP identical DTOs ──────────────────────────────────────

export interface UnlinkedItemsError {
  code: typeof API_ERROR_CODES.UNLINKED_ITEMS;
  message: string;
  unlinkedItems: { id: string; description: string; qty: number; unitCost: number }[];
}

/**
 * B743: a bill line's pack size wasn't stated (or was left at 0/1, which
 * never means "confirmed one piece") for a product the catalog already
 * knows is sold by the case. Mirrors `UnlinkedItemsError`'s warn-and-confirm
 * shape — retry with `acknowledgePackSizeUnknown: true` (receive) or
 * `acknowledgePackSizeUnknown: true` (create's raise-PO path) to record the
 * line as loose pieces anyway.
 */
export interface PackSizeUnknownError {
  code: typeof API_ERROR_CODES.PACK_SIZE_UNKNOWN;
  message: string;
  packSizeUnknownItems: {
    /** The existing VendorBillItem id; null for a line not yet saved. */
    id: string | null;
    lineIndex: number;
    description: string;
    productId: string;
    productName: string;
    qty: number;
    unitCost: number;
    /** The product's own known pack — a HINT only, never applied automatically. */
    productPack: number;
  }[];
}

/** An already-recorded bill that matches the one being entered. */
export interface DuplicateVendorBillInfo {
  billId: string;
  billNumber: string;
  status: string;
  /** The existing bill is still DRAFT — finishing it beats creating a second one. */
  resumable: boolean;
  totalOwed: number;
  billDate: string | null;
  receivedDate: string | null;
  supplierName: string | null;
  itemCount: number;
  /** "number" = the supplier's own invoice number matched; "fuzzy" = supplier + date + total. */
  matchedBy: "number" | "fuzzy";
  totalMatches: boolean;
}

export interface DuplicateVendorBillError {
  code: typeof API_ERROR_CODES.DUPLICATE_VENDOR_BILL;
  message: string;
  duplicate: DuplicateVendorBillInfo;
}

export interface PriorScanSummary {
  scanId: string;
  /** ISO timestamp of the earlier scan. */
  scannedAt: string;
  status: import("./enums").InvoiceScanStatus;
  vendorBillId: string | null;
  billNumber: string | null;
  supplierInvoiceNumber: string | null;
  total: number | null;
}

export interface CheckVendorBillDuplicateDto {
  supplierId?: string;
  supplierInvoiceNumber?: string;
  total?: number;
  billDate?: string;
}

export interface ScanCandidate {
  productId: string;
  /** Composed display name (e.g. "Big Red Chewing Gum - Cinnamon"). */
  name: string;
  sku: string | null;
  /** Weighted-overlap score, 0..1. */
  score: number;
}

// ─── Supplier statements / AP payments ─────────────────────────────────────────

export type SupplierStatementRowType = "BILL" | "PAYMENT" | "CREDIT";

/** One line of the running-balance timeline. `amount` is SIGNED — a BILL is
 *  positive, a PAYMENT/CREDIT negative. A credit's draw-down against a bill is
 *  folded into that bill's `totalPaid` and deliberately omitted as its own row
 *  (it is not new money), so PAYMENT rows are real cash movements only. */
export interface SupplierStatementRow {
  id: string;
  type: SupplierStatementRowType;
  date: string;
  description: string;
  billId?: string;
  billNumber?: string;
  paymentGroupId?: string | null;
  amount: number;
  /** Running balance AFTER this row is applied. */
  balance: number;
}

export interface SupplierStatement {
  supplierId: string;
  timeline: SupplierStatementRow[];
  totalOwed: number;
  totalPaid: number;
  /** Σ(totalOwed − totalPaid) over non-VOID bills — arithmetic, never status. */
  outstanding: number;
  /** Current `SupplierCredit.balance` sum available to draw down. */
  creditBalance: number;
}

export interface SupplierAllocationLine {
  vendorBillId: string;
  /** Cents-rounded CLIENT-side. Server re-rounds and validates: rejects an
   *  allocation to another supplier's bill, one exceeding that bill's remaining
   *  balance, or a set summing past `totalAmount`. */
  amount: number;
}

export interface SupplierPaymentResultLine {
  id: string;
  vendorBillId: string;
  amount: number;
  method: string;
  reference?: string | null;
  notes?: string | null;
  paymentGroupId?: string | null;
  paidAt?: string;
  createdAt?: string;
}

/** `TMethod` lets each app plug in its own local payment-method literal union
 *  (see `StandalonePaymentDto`). */
export interface RecordSupplierPaymentDto<TMethod = string> {
  supplierId: string;
  /** Cash actually paid out. Anything not covered by `allocations` (> 0.001)
   *  becomes a `SupplierCredit` for the supplier, server-side. */
  totalAmount: number;
  method: TMethod;
  paidAt?: string;
  reference?: string;
  notes?: string;
  allocations: SupplierAllocationLine[];
}

export interface RecordSupplierPaymentResult {
  paymentGroupId: string;
  payments: SupplierPaymentResultLine[];
  /** Overpayment that landed on the supplier's account as a SupplierCredit
   *  rather than being rejected — never an error. */
  excess: number;
  bills: { id: string; status: import("./enums").VendorBillStatus; totalPaid: number }[];
}

export type StatementAiErrorCode =
  | typeof API_ERROR_CODES.AI_KEY_INVALID
  | typeof API_ERROR_CODES.AI_SCAN_REJECTED
  | typeof API_ERROR_CODES.AI_UNAVAILABLE
  | typeof API_ERROR_CODES.AI_PARSE_FAILED;

export interface StatementAiError {
  /** null covers both the no-API-key case (a plain, code-less
   *  BadRequestException) and anything genuinely unexpected — callers must
   *  still have a fallback branch, never assume one of the four. */
  code: StatementAiErrorCode | null;
  message: string;
}
