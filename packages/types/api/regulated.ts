// ─── Tracked categories / regulated reporting / tobacco (wave E / imp-10b) ─────

import type { ReportCadence, RegulatedFilingStatus } from "./enums";

export interface RegulatedFiling {
  id: string;
  trackedCategoryId: string;
  reportTemplate: string;
  cadence: ReportCadence;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  status: RegulatedFilingStatus;
  totalQty: string; // Prisma Decimal serialized as a string
  totalUnitBasisQty: string;
  totalNetSales: string;
  totalCategoryTax: string;
  csvKey: string | null;
  generationCount: number;
  generatedAt: string;
}

export interface RegulatedLedgerRow {
  trackedCategoryId: string;
  categoryName: string;
  periodBucket: string; // "YYYY-MM" (UTC month)
  qty: number;
  unitBasisQty: number;
  netSales: number; // signed net (reversals net it down)
  categoryTax: number; // signed net
}

export interface RegulatedLedgerResponse {
  rows: RegulatedLedgerRow[];
  /** Note: `totals` intentionally omits `unitBasisQty` (sum the rows for that). */
  totals: { qty: number; netSales: number; categoryTax: number };
}

export type RegulatedReportWarningCode =
  | "MISSING_WHOLESALER_LICENSE"
  | "MISSING_ITEM_TYPE"
  | "MISSING_UOM"
  | "MISSING_TAXPAYER_ID"
  | "INVALID_TAXPAYER_ID"
  | "MISSING_RETAILER_LICENSE"
  | "INVALID_RETAILER_LICENSE"
  | "INVALID_WHOLESALER_LICENSE"
  | "MISSING_ADDRESS"
  | "NEGATIVE_NET_INVOICE"
  | "FRACTIONAL_QTY"
  | "UNLINKED_LEDGER_ROWS"
  | "UNMATCHED_LEDGER_LINE"
  | "UNLISTED_PRODUCT_LINE";

export interface RegulatedReportWarning {
  code: RegulatedReportWarningCode;
  /** A complete human sentence, ready to render in the UI. */
  message: string;
  invoiceId?: string;
  customerName?: string;
  productId?: string;
}

export interface RegulatedReportColumn {
  key: string;
  label: string;
  align?: "right";
}

/** Mirrors the API's `RegulatedReport` shape (`apps/api/src/regulated/report-types.ts`).
 *  `rows` holds fully formatted cells in `columns` order, so the preview table and
 *  the downloaded CSV can't drift. */
export interface RegulatedReportPreview {
  template: string;
  title: string;
  categoryId: string;
  categoryName: string;
  /** Inclusive YYYY-MM-DD range, echoed back for display. */
  from: string;
  to: string;
  columns: RegulatedReportColumn[];
  rows: string[][];
  /** Aggregate templates only; null for per-sale templates like TX. */
  totalsRow: string[] | null;
  /** Headline figures for the preview UI (not necessarily in the CSV). */
  displayTotals: { label: string; value: string }[];
  warnings: RegulatedReportWarning[];
  /** True when the column layout deviates from the template's official default. */
  custom?: boolean;
}

// ─── Report templates (registry-driven vocabulary + columns) ──────────────────

export interface TemplateUomOption {
  code: string;
  label: string;
}

export interface TemplateItemType {
  code: string;
  label: string;
  uoms: TemplateUomOption[];
}

export interface TemplateColumn {
  key: string;
  label: string;
  align?: "right";
  /** In the template's official/default layout. Non-default columns make a report "custom". */
  default: boolean;
}

export interface ReportTemplateDef {
  key: string;
  label: string;
  kind: "per-sale" | "aggregate";
  /** null ⇒ this template needs no per-product config. */
  productConfig: { itemTypes: TemplateItemType[]; caseUomSupported: boolean } | null;
  columns: TemplateColumn[];
}

// ─── Tobacco (TOBACCO_ADDON) ────────────────────────────────────────────────────

export interface TobaccoOverview {
  period: { from: string; to: string };
  flaggedProductCount: number;
  inventory: { totalQty: number; totalValue: number };
  purchases: { count: number; totalQty: number; totalValue: number };
  sales: { count: number; totalQty: number; totalValue: number; totalTax: number };
}
