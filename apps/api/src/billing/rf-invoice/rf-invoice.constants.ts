/**
 * Manual invoices due: constants the API needs at RUNTIME. The API may not value-import
 * `@routeflow/types` (no-runtime-workspace-imports.spec.ts), so the shared arrays in
 * `packages/types/api/rf-invoices.ts` are mirrored here; `rf-invoice-constants-parity.spec.ts`
 * pins the two equal.
 */
import { AdminAuditAction } from "../../platform-admin/audit-actions.constant";

/** `RfInvoice.status` - a plain string column. The legacy FAILED is never written. */
export const RF_INVOICE_STATUS_VALUES = ["OPEN", "PAID", "VOID"] as const;
export type RfInvoiceStatus = (typeof RF_INVOICE_STATUS_VALUES)[number];

export const RF_INVOICE_VIEW_VALUES = [
  "overdue",
  "due_soon",
  "open",
  "paid",
  "void",
  "all",
] as const;

export const RF_INVOICE_LINE_KINDS = ["PLAN", "ADDON"] as const;
export type RfInvoiceLineKind = (typeof RF_INVOICE_LINE_KINDS)[number];

export interface RfInvoiceLine {
  kind: RfInvoiceLineKind;
  code: string;
  label: string;
  quantity: number;
  unitAmount: number;
  amount: number;
}

export const RF_INVOICE_AUDIT_ACTIONS = {
  ISSUED: AdminAuditAction.RF_INVOICE_ISSUED,
  NEEDS_PRICE: AdminAuditAction.RF_INVOICE_NEEDS_PRICE,
  STALE_PERIOD: AdminAuditAction.RF_INVOICE_STALE_PERIOD,
} as const;

/**
 * The exact unique-index names a P2002 is matched against (`uniqueViolationOn(e, name, { exact: true })`,
 * SA M1). Prisma derives them as `<Model>_<fields>_key`; the migration creates them verbatim.
 */
export const RF_INVOICE_PERIOD_INDEX = "RfInvoice_tenantId_periodKey_key";
export const RF_INVOICE_NUMBER_INDEX = "RfInvoice_number_key";

/** RF_INVOICING_MODE: `off` (default) makes the cron do nothing at all; `silent` and `live` issue rows. */
export type RfInvoicingMode = "off" | "silent" | "live";
export function rfInvoicingMode(
  raw: string | undefined = process.env.RF_INVOICING_MODE,
): RfInvoicingMode {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "silent" || v === "live" ? v : "off";
}

/** Issue the next period this many days before it starts. */
export const RF_INVOICE_LEAD_DAYS = 7;

/** A subscription whose period ended more than this many days ago is stale (rollCycles lagging): never invoiced. */
export const RF_INVOICE_STALE_DAYS = 1;
