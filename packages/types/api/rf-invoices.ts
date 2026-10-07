// RouteFlow's own invoices to manual-pay tenants ("manual invoices due"). The platform-admin wire
// shapes for `/platform-admin/rf-invoices…`; the API side lives in apps/api/src/billing/rf-invoice
// and apps/api/src/platform-admin. The API may not value-import this package, so it MIRRORS the
// const arrays in apps/api/src/billing/rf-invoice/rf-invoice.constants.ts; rf-invoice-constants-parity.spec.ts
// pins the two equal. Dates arrive as ISO strings, money as numbers rounded to cents.

/** `RfInvoice.status` - a plain string column, not a Prisma enum. The legacy FAILED is never written. */
export const RF_INVOICE_STATUS_VALUES = ["OPEN", "PAID", "VOID"] as const;
export type RfInvoiceStatus = (typeof RF_INVOICE_STATUS_VALUES)[number];

/** The queue's tabs. `overdue` / `due_soon` are derived from `dueDate` (UTC) over OPEN rows. */
export const RF_INVOICE_VIEW_VALUES = [
  "overdue",
  "due_soon",
  "open",
  "paid",
  "void",
  "all",
] as const;
export type RfInvoiceView = (typeof RF_INVOICE_VIEW_VALUES)[number];

export const RF_INVOICE_LINE_KINDS = ["PLAN", "ADDON"] as const;
export type RfInvoiceLineKind = (typeof RF_INVOICE_LINE_KINDS)[number];

/** One line of `RfInvoice.lines`. Exactly these six keys; there is deliberately no price-unknown flag. */
export interface RfInvoiceLine {
  kind: RfInvoiceLineKind;
  /** Plan key, or the add-on SKU / legacy key. */
  code: string;
  label: string;
  quantity: number;
  unitAmount: number;
  amount: number;
}

export type RfInvoiceDueState = "overdue" | "due_soon" | "upcoming";

export type RfInvoiceCycle = "MONTHLY" | "ANNUAL";

/** One queue row. No paidNote / voidReason / actor ids: those stay on the detail path. */
export interface RfInvoiceRow {
  id: string;
  number: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  tenantStatus: string;
  /** True when the tenant has since moved to a card subscription (a Stripe sub id exists). */
  tenantPaysByCard: boolean;
  amount: number;
  currency: string;
  cycle: RfInvoiceCycle;
  periodStart: string | null;
  periodEnd: string | null;
  issuedAt: string;
  dueDate: string | null;
  status: RfInvoiceStatus;
  /** Null for a PAID or VOID invoice: only an OPEN one is ever due. */
  dueState: RfInvoiceDueState | null;
  daysOverdue: number;
  lastSentAt: string | null;
  sendCount: number;
  paidAt: string | null;
  paidMethod: string | null;
  paidRef: string | null;
  lines: RfInvoiceLine[];
  needsReview: boolean;
}

export interface RfInvoiceListQuery {
  view?: RfInvoiceView;
  q?: string;
  tenantId?: string;
  sort?: "due" | "amount" | "tenant";
  dir?: "asc" | "desc";
  page?: number;
  limit?: number;
}

export interface RfInvoiceListResponse {
  rows: RfInvoiceRow[];
  meta: { total: number; page: number; limit: number };
}

export interface RfInvoiceMoneyBucket {
  count: number;
  amount: number;
}

export interface RfInvoiceSummary {
  overdue: RfInvoiceMoneyBucket;
  dueSoon: RfInvoiceMoneyBucket;
  paid30d: RfInvoiceMoneyBucket;
  viewCounts: Record<RfInvoiceView, number>;
  /** Manual-pay tenants whose price cannot be resolved, so no invoice could be issued. */
  unpricedTenants: { tenantId: string; name: string; slug: string }[];
  /** Manual-pay tenants whose subscription period ended over a day ago and was never rolled: no invoice is issued for them. */
  staleTenants: { tenantId: string; name: string; slug: string }[];
  mode: "off" | "silent" | "live";
}

export interface RfInvoiceMarkPaidDto {
  paidAt?: string;
  method: string;
  reference?: string;
  note?: string;
}

export interface RfInvoiceReasonDto {
  reason: string;
}
