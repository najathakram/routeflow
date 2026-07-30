/**
 * WP11: TX Comptroller (TX_COMPTROLLER report template) row builder — pure,
 * no Prisma/Nest dependency. Consumed by `regulated-report.service.ts` (the
 * stateless preview/CSV endpoints) and `regulated-filing.service.ts`
 * (`prepareFiling`'s persisted TX filing).
 *
 * Ledger rows are pre-signed (REVERSAL rows are negative and carry the sibling
 * invoice's `invoiceId`), so grouping+summing signed `unitBasisQty`/`netSales` per
 * `invoiceId` nets credit notes and returns automatically — no separate
 * reversal-matching logic is needed here.
 *
 * IDs (wholesaler license, retailer license, taxpayer ID) are emitted DIGITS-ONLY
 * AS STORED — never zero-padded, never fabricated. A wrong length raises a
 * warning but the value is still written as stored (a human fixes the source
 * data; this report never guesses).
 */

import { ReportColumn, RegulatedReport, ReportWarning, ReportWarningCode } from "./report-types";

/** TX Comptroller unit-of-measure codes, keyed by item type. */
export const TX_UOM_CODES = {
  1: ["CP", "CS", "CC"], // cigarettes: packs, sticks, cartons
  2: ["SB", "SC", "SD", "SF"], // cigars: class B/C/D/F sticks
  3: ["WO", "WN"], // tobacco: ounces, number (cans/packages)
} as const;

export const TX_ITEM_TYPE_LABELS: Record<number, string> = {
  1: "Cigarettes",
  2: "Cigars",
  3: "Tobacco",
};

export interface TxLedgerRow {
  invoiceId: string | null;
  /** Signed: REVERSAL rows are negative. */
  unitBasisQty: number;
  netSales: number;
}
export interface TxInvoiceInfo {
  id: string;
  invoiceNumber: string;
  issueDate: Date;
  customerId: string;
}
export interface TxCustomerAddress {
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  zip: string;
  isDefault: boolean;
  addressType: string | null;
}
export interface TxCustomerInfo {
  id: string;
  businessName: string;
  taxId: string | null;
  tobaccoLicenseNo: string | null;
  /** CustomerAuthorization.licenseNumber for THIS tracked category, when present. */
  authLicenseNumber: string | null;
  addresses: TxCustomerAddress[];
}
export interface TxCategoryConfig {
  id: string;
  name: string;
  wholesalerLicenseNo: string | null;
  txItemType: number | null;
  txUom: string | null;
}

const WHOLESALER_LICENSE_LEN = 8;
const TAXPAYER_ID_LEN = 11;
const RETAILER_LICENSE_LEN = 8;
const NAME_MAX = 50;
const STREET_MAX = 50;
const CITY_MAX = 30;
const STATE_MAX = 2;
const ZIP_MAX = 5;

const TX_COLUMNS: ReportColumn[] = [
  { key: "wholesalerPermit", label: "Wholesaler Permit #" },
  { key: "retailerTaxpayerId", label: "Retailer Taxpayer ID" },
  { key: "retailerName", label: "Retailer Name" },
  { key: "retailerStreet", label: "Retailer Street Address" },
  { key: "retailerCity", label: "Retailer City" },
  { key: "state", label: "State" },
  { key: "zip", label: "ZIP" },
  { key: "retailerPermit", label: "Retailer Permit #" },
  { key: "itemType", label: "Item Type" },
  { key: "uom", label: "Unit of Measure" },
  { key: "quantity", label: "Quantity", align: "right" },
  { key: "invoiceAmount", label: "Invoice Amount", align: "right" },
];

/** Digits only — IDs are emitted as stored, never padded or invented. */
export function digitsOnly(v: string | null | undefined): string {
  return (v ?? "").replace(/\D/g, "");
}

/** default+BILLING -> any BILLING -> any default -> first -> null. */
export function pickReportAddress(addresses: TxCustomerAddress[]): TxCustomerAddress | null {
  if (!addresses || addresses.length === 0) return null;
  const defaultBilling = addresses.find((a) => a.isDefault && a.addressType === "BILLING");
  if (defaultBilling) return defaultBilling;
  const anyBilling = addresses.find((a) => a.addressType === "BILLING");
  if (anyBilling) return anyBilling;
  const anyDefault = addresses.find((a) => a.isDefault);
  if (anyDefault) return anyDefault;
  return addresses[0];
}

function truncate(v: string, max: number): string {
  return v.length > max ? v.slice(0, max) : v;
}

const EPSILON = 1e-9;

export function buildTxReport(input: {
  category: TxCategoryConfig;
  ledgerRows: TxLedgerRow[];
  invoicesById: Map<string, TxInvoiceInfo>;
  customersById: Map<string, TxCustomerInfo>;
  from: string;
  to: string;
}): RegulatedReport {
  const { category, ledgerRows, invoicesById, customersById, from, to } = input;
  const warnings: ReportWarning[] = [];

  // Category-level config issues apply to every row identically — emit each
  // MISSING_*/INVALID_* code exactly once, no matter how many invoices are in range.
  const seenCategoryWarnings = new Set<ReportWarningCode>();
  const addCategoryWarning = (code: ReportWarningCode, message: string) => {
    if (seenCategoryWarnings.has(code)) return;
    seenCategoryWarnings.add(code);
    warnings.push({ code, message });
  };

  // ── 1. Group signed sums by invoiceId; null-invoiceId rows are excluded ────
  const sums = new Map<string, { qty: number; net: number }>();
  let unlinkedCount = 0;
  for (const row of ledgerRows) {
    if (!row.invoiceId) {
      unlinkedCount++;
      continue;
    }
    const cur = sums.get(row.invoiceId) ?? { qty: 0, net: 0 };
    cur.qty += Number(row.unitBasisQty);
    cur.net += Number(row.netSales);
    sums.set(row.invoiceId, cur);
  }
  if (unlinkedCount > 0) {
    warnings.push({
      code: "UNLINKED_LEDGER_ROWS",
      message: `${unlinkedCount} regulated ledger row(s) had no linked invoice and were excluded from this report.`,
    });
  }

  // ── 2. Resolve category config once ─────────────────────────────────────
  const wholesalerLicense = digitsOnly(category.wholesalerLicenseNo);
  if (!wholesalerLicense) {
    addCategoryWarning(
      "MISSING_WHOLESALER_LICENSE",
      "This category has no wholesaler license/permit number configured.",
    );
  } else if (wholesalerLicense.length !== WHOLESALER_LICENSE_LEN) {
    addCategoryWarning(
      "INVALID_WHOLESALER_LICENSE",
      `The configured wholesaler license "${wholesalerLicense}" is not ${WHOLESALER_LICENSE_LEN} digits.`,
    );
  }
  const itemTypeLabel =
    category.txItemType != null ? (TX_ITEM_TYPE_LABELS[category.txItemType] ?? "") : "";
  if (category.txItemType == null) {
    addCategoryWarning("MISSING_ITEM_TYPE", "This category has no TX item type configured.");
  }
  const uom = category.txUom ?? "";
  if (!uom) {
    addCategoryWarning("MISSING_UOM", "This category has no TX unit of measure configured.");
  }

  // ── 3. One row per invoice ───────────────────────────────────────────────
  type BuiltRow = { cells: string[]; issueDate: Date; invoiceNumber: string };
  const built: BuiltRow[] = [];

  for (const [invoiceId, sum] of sums) {
    const roundedQty = Math.round(sum.qty);
    const roundedNet = Math.round(sum.net);
    // A fully reversed invoice (SALE + its own REVERSAL, or credited to zero) nets
    // to nothing on this line — drop it rather than emit a dead $0/0 row.
    if (roundedQty === 0 && roundedNet === 0) continue;

    const invoice = invoicesById.get(invoiceId);
    const customer = invoice ? customersById.get(invoice.customerId) : undefined;
    const customerName = customer?.businessName;

    if (Math.abs(sum.qty - roundedQty) > EPSILON) {
      warnings.push({
        code: "FRACTIONAL_QTY",
        message: `Invoice quantity ${sum.qty} is not a whole number; rounded to ${roundedQty}.`,
        invoiceId,
        customerName,
      });
    }
    if (roundedNet < 0) {
      warnings.push({
        code: "NEGATIVE_NET_INVOICE",
        message: `Invoice ${invoice?.invoiceNumber ?? invoiceId} nets to a negative amount after returns/credits.`,
        invoiceId,
        customerName,
      });
    }

    // Retailer taxpayer ID.
    const taxpayerId = digitsOnly(customer?.taxId ?? null);
    if (!taxpayerId) {
      warnings.push({
        code: "MISSING_TAXPAYER_ID",
        message: `${customerName ?? "This customer"} has no taxpayer ID on file.`,
        invoiceId,
        customerName,
      });
    } else if (taxpayerId.length !== TAXPAYER_ID_LEN) {
      warnings.push({
        code: "INVALID_TAXPAYER_ID",
        message: `${customerName ?? "This customer"}'s taxpayer ID "${taxpayerId}" is not ${TAXPAYER_ID_LEN} digits.`,
        invoiceId,
        customerName,
      });
    }

    // Retailer license: this category's CustomerAuthorization first, else the
    // customer's general tobacco license.
    const retailerLicenseRaw = customer?.authLicenseNumber || customer?.tobaccoLicenseNo || null;
    const retailerLicense = digitsOnly(retailerLicenseRaw);
    if (!retailerLicense) {
      warnings.push({
        code: "MISSING_RETAILER_LICENSE",
        message: `${customerName ?? "This customer"} has no retailer license on file for this category.`,
        invoiceId,
        customerName,
      });
    } else if (retailerLicense.length !== RETAILER_LICENSE_LEN) {
      warnings.push({
        code: "INVALID_RETAILER_LICENSE",
        message: `${customerName ?? "This customer"}'s retailer license "${retailerLicense}" is not ${RETAILER_LICENSE_LEN} digits.`,
        invoiceId,
        customerName,
      });
    }

    // Address: default+BILLING -> any BILLING -> any default -> first.
    const address = customer ? pickReportAddress(customer.addresses) : null;
    if (!address) {
      warnings.push({
        code: "MISSING_ADDRESS",
        message: `${customerName ?? "This customer"} has no address on file.`,
        invoiceId,
        customerName,
      });
    }

    const name = truncate(customer?.businessName ?? "", NAME_MAX);
    const street = truncate(address?.line1 ?? "", STREET_MAX);
    const city = truncate(address?.city ?? "", CITY_MAX);
    const state = (address?.state ?? "").toUpperCase().slice(0, STATE_MAX);
    const zip = digitsOnly(address?.zip ?? "").slice(0, ZIP_MAX);

    built.push({
      cells: [
        wholesalerLicense,
        taxpayerId,
        name,
        street,
        city,
        state,
        zip,
        retailerLicense,
        itemTypeLabel,
        uom,
        String(roundedQty),
        String(roundedNet),
      ],
      issueDate: invoice?.issueDate ?? new Date(0),
      invoiceNumber: invoice?.invoiceNumber ?? "",
    });
  }

  // Rows sort by invoice issue date, then invoice number.
  built.sort((a, b) => {
    const byDate = a.issueDate.getTime() - b.issueDate.getTime();
    if (byDate !== 0) return byDate;
    return a.invoiceNumber.localeCompare(b.invoiceNumber);
  });

  const totalQty = built.reduce((t, r) => t + Number(r.cells[10]), 0);
  const totalAmount = built.reduce((t, r) => t + Number(r.cells[11]), 0);

  return {
    template: "TX_COMPTROLLER",
    title: "TX Comptroller Cigarette/Tobacco Report",
    categoryId: category.id,
    categoryName: category.name,
    from,
    to,
    columns: TX_COLUMNS,
    rows: built.map((b) => b.cells),
    // Per-sale template — no aggregate totals row in the CSV.
    totalsRow: null,
    displayTotals: [
      { label: "Invoices", value: String(built.length) },
      { label: "Total Quantity", value: String(totalQty) },
      { label: "Total Invoice Amount", value: String(totalAmount) },
    ],
    warnings,
    // TX CSV carries no header row and no preamble/footer/totals — commas inside
    // fields (e.g. a retailer name) are double-quoted by report-csv.ts#esc.
    csv: { preamble: [], includeHeader: false, includeTotals: false, footer: [] },
  };
}
