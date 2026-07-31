/**
 * TX Comptroller (TX_COMPTROLLER report template) row builder — pure, no
 * Prisma/Nest dependency. Consumed by `regulated-report.service.ts` (the
 * stateless preview/CSV endpoints) and `regulated-filing.service.ts`
 * (`prepareFiling`'s persisted TX filing).
 *
 * Item type and unit of measure are resolved PER PRODUCT (`Product.regItemType`/
 * `regUomCase`/`regUomUnit`), not per category — a single regulated section can
 * legitimately hold cigarettes, cigars and loose tobacco products at once, and a
 * product's selling unit (case vs. loose) determines which UoM bucket its
 * quantity lands in. See `./template-registry.ts` for the vocabulary this report
 * validates item types/UoMs against.
 *
 * Ledger rows are pre-signed (REVERSAL rows are negative and carry the sibling
 * invoice's `invoiceId`), so summing signed `unitBasisQty`/`netSales` per
 * (invoice, item type, UoM[, product]) bucket nets credit notes and returns
 * automatically — no separate reversal-matching logic is needed here.
 *
 * BACK-COMPAT INVARIANT: when a product's `regUomCase` is null, its ledger rows'
 * signed `unitBasisQty` passes through RAW and UNCONVERTED into a single bucket
 * per invoice — never multiplied by `unitsPerBox`. This is what makes backfilled
 * tenants (whose products all have `regUomCase` NULL) reproduce today's report
 * numbers byte-for-byte. Case/unit splitting is strictly a per-product opt-in.
 *
 * IDs (wholesaler license, retailer license, taxpayer ID) are emitted DIGITS-ONLY
 * AS STORED — never zero-padded, never fabricated. A wrong length raises a
 * warning but the value is still written as stored (a human fixes the source
 * data; this report never guesses).
 */

import { ReportColumn, RegulatedReport, ReportWarning, ReportWarningCode } from "./report-types";
import { itemTypeLabel } from "./template-registry";

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
  /** Ledger rows carry the invoice line they were booked from; may dangle (no FK). */
  invoiceItemId: string | null;
  /** Signed: REVERSAL rows are negative. */
  unitBasisQty: number;
  netSales: number;
}

/** The invoice line a ledger row was booked from — the case/unit split lives here. */
export interface TxLineInfo {
  id: string;
  productId: string | null;
  /** Line total in the LINE'S qty basis: pieces when boxes != null, else cases/units. */
  qty: number;
  boxes: number | null;
  pieces: number | null;
  /** Sale-time snapshot of the product's box size. */
  unitsPerBox: number | null;
}

/** Per-product regulatory reporting config. */
export interface TxProductConfig {
  id: string;
  name: string;
  unitsPerBox: number | null;
  regItemType: string | null;
  regUomCase: string | null;
  regUomUnit: string | null;
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
  // txItemType / txUom REMOVED — config now lives on the product.
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

/**
 * Non-default columns a caller may opt into via `includeOptionalColumns`, in
 * canonical registry order. Appended after the 12 base columns above, never
 * reordered relative to each other.
 */
const TX_OPTIONAL_COLUMNS: ReportColumn[] = [
  { key: "itemDescription", label: "Item Description" },
  { key: "invoiceNumber", label: "Invoice #" },
  { key: "invoiceDate", label: "Invoice Date" },
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
  linesById: Map<string, TxLineInfo>;
  productsById: Map<string, TxProductConfig>;
  invoicesById: Map<string, TxInvoiceInfo>;
  customersById: Map<string, TxCustomerInfo>;
  from: string;
  to: string;
  /** Optional non-default column keys to append, in canonical registry order. */
  includeOptionalColumns?: string[];
}): RegulatedReport {
  const { category, ledgerRows, linesById, productsById, invoicesById, customersById, from, to } =
    input;
  const warnings: ReportWarning[] = [];

  // ── 1. Resolve category config once ─────────────────────────────────────
  // Category-level config issues apply to every row identically — emit each
  // MISSING_*/INVALID_* code exactly once, no matter how many invoices are in range.
  const seenCategoryWarnings = new Set<ReportWarningCode>();
  const addCategoryWarning = (code: ReportWarningCode, message: string) => {
    if (seenCategoryWarnings.has(code)) return;
    seenCategoryWarnings.add(code);
    warnings.push({ code, message });
  };

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

  // ── 2. Bucket signed ledger rows by (invoice, item type, UoM[, product]) ────
  const optional = new Set(input.includeOptionalColumns ?? []);
  const withItemDescription = optional.has("itemDescription");

  interface Bucket {
    invoiceId: string;
    itemType: string; // code; "" when unconfigured
    uom: string; // code; "" when unconfigured
    productName: string;
    qty: number;
    net: number;
  }
  const buckets = new Map<string, Bucket>();
  let unlinkedCount = 0;
  let unmatchedLineCount = 0;
  const unlistedInvoices = new Set<string>();
  // Product-level config warnings are per product, not per row.
  const seenProductWarnings = new Set<string>();

  const warnProduct = (p: TxProductConfig, code: ReportWarningCode, message: string) => {
    const key = `${code}|${p.id}`;
    if (seenProductWarnings.has(key)) return;
    seenProductWarnings.add(key);
    warnings.push({ code, message, productId: p.id });
  };

  const addBucket = (
    invoiceId: string,
    product: TxProductConfig | undefined,
    itemType: string,
    uom: string,
    qty: number,
    net: number,
  ) => {
    // Adding the product name to the layout means rows must be per product, or the
    // description cell would be ambiguous.
    const key = withItemDescription
      ? `${invoiceId}|${product?.id ?? ""}|${itemType}|${uom}`
      : `${invoiceId}|${itemType}|${uom}`;
    const cur = buckets.get(key);
    if (cur) {
      cur.qty += qty;
      cur.net += net;
      return;
    }
    buckets.set(key, {
      invoiceId,
      itemType,
      uom,
      productName: product?.name ?? "",
      qty,
      net,
    });
  };

  for (const row of ledgerRows) {
    if (!row.invoiceId) {
      unlinkedCount++;
      continue;
    }
    const line = row.invoiceItemId ? linesById.get(row.invoiceItemId) : undefined;
    const product = line?.productId ? productsById.get(line.productId) : undefined;

    const qty = Number(row.unitBasisQty);
    const net = Number(row.netSales);

    const itemType = product?.regItemType ?? "";
    const uomUnit = product?.regUomUnit ?? "";
    const uomCase = product?.regUomCase ?? null;

    if (product) {
      if (!product.regItemType) {
        warnProduct(
          product,
          "MISSING_ITEM_TYPE",
          `"${product.name}" has no regulatory item type configured.`,
        );
      }
      if (!product.regUomUnit) {
        warnProduct(
          product,
          "MISSING_UOM",
          `"${product.name}" has no regulatory unit of measure configured.`,
        );
      }
    }
    if (row.invoiceItemId && !line) unmatchedLineCount++;
    if (line && !line.productId) unlistedInvoices.add(row.invoiceId);

    // ── BACK-COMPAT PATH ──────────────────────────────────────────────────────
    // No case UoM configured ⇒ raw passthrough, one bucket, NO unit conversion.
    // This is what reproduces today's per-invoice numbers exactly. Do not "fix"
    // it by multiplying cases by unitsPerBox — that would restate filed history.
    if (uomCase == null || !line || !(line.qty > 0)) {
      addBucket(row.invoiceId, product, itemType, uomUnit, qty, net);
      continue;
    }

    if (line.boxes != null) {
      // SPLIT LINE: line.qty is TOTAL PIECES; boxes may legitimately be 0.
      const upb = line.unitsPerBox ?? product?.unitsPerBox ?? 1;
      const boxes = line.boxes ?? 0;
      const pieces = line.pieces ?? 0;
      // factor: +1 for a SALE, -1 for a full reversal, ±fraction for a partial return.
      const factor = qty / line.qty;
      const caseQty = factor * boxes;
      const unitQty = factor * pieces;
      // Money splits linearly by piece-equivalents; the unit share takes the
      // remainder so rounding never leaks a cent.
      const rawShare = upb > 0 ? (boxes * upb) / line.qty : 0;
      const caseShare = Math.min(1, Math.max(0, rawShare));
      const caseNet = net * caseShare;
      const unitNet = net - caseNet;
      if (caseQty !== 0 || caseNet !== 0) {
        addBucket(row.invoiceId, product, itemType, uomCase, caseQty, caseNet);
      }
      if (unitQty !== 0 || unitNet !== 0) {
        addBucket(row.invoiceId, product, itemType, uomUnit, unitQty, unitNet);
      }
      continue;
    }

    const effUpb = line.unitsPerBox ?? product?.unitsPerBox ?? 0;
    if (effUpb > 1) {
      // LEGACY NO-SPLIT BOXED LINE: qty is already in CASES — do NOT multiply.
      addBucket(row.invoiceId, product, itemType, uomCase, qty, net);
      continue;
    }
    // Non-boxed product: everything is units.
    addBucket(row.invoiceId, product, itemType, uomUnit, qty, net);
  }

  if (unlinkedCount > 0) {
    warnings.push({
      code: "UNLINKED_LEDGER_ROWS",
      message: `${unlinkedCount} regulated ledger row(s) had no linked invoice and were excluded from this report.`,
    });
  }
  if (unmatchedLineCount > 0) {
    warnings.push({
      code: "UNMATCHED_LEDGER_LINE",
      message: `${unmatchedLineCount} regulated ledger row(s) reference an invoice line that no longer exists; their quantities are reported without case/unit splitting.`,
    });
  }
  for (const invoiceId of unlistedInvoices) {
    warnings.push({
      code: "UNLISTED_PRODUCT_LINE",
      message:
        "This invoice has a regulated line with no catalog product, so it has no item type or unit of measure.",
      invoiceId,
    });
  }

  // ── 3. Emit one row per bucket ───────────────────────────────────────────
  type BuiltRow = {
    cells: string[];
    issueDate: Date;
    invoiceNumber: string;
    invoiceId: string;
    itemType: string;
    uom: string;
    productName: string;
    roundedQty: number;
    roundedNet: number;
  };
  const built: BuiltRow[] = [];

  // Per-invoice warnings must dedupe per invoice now that one invoice can yield
  // several bucket rows.
  const seenInvoiceWarnings = new Set<string>();
  const warnInvoiceOnce = (
    code: ReportWarningCode,
    invoiceId: string,
    message: string,
    customerName?: string,
  ) => {
    const key = `${code}|${invoiceId}`;
    if (seenInvoiceWarnings.has(key)) return;
    seenInvoiceWarnings.add(key);
    warnings.push({ code, message, invoiceId, customerName });
  };

  for (const bucket of buckets.values()) {
    const roundedQty = Math.round(bucket.qty);
    const roundedNet = Math.round(bucket.net);
    // A fully reversed bucket (SALE + its own REVERSAL, or credited to zero) nets
    // to nothing on this line — drop it rather than emit a dead $0/0 row.
    if (roundedQty === 0 && roundedNet === 0) continue;

    const invoice = invoicesById.get(bucket.invoiceId);
    const customer = invoice ? customersById.get(invoice.customerId) : undefined;
    const customerName = customer?.businessName;

    if (Math.abs(bucket.qty - roundedQty) > EPSILON) {
      // Per bucket (it is per row), not deduped per invoice — include the UoM so
      // a fan-out invoice's several fractional buckets are each identifiable.
      const uomSuffix = bucket.uom ? ` ${bucket.uom}` : "";
      warnings.push({
        code: "FRACTIONAL_QTY",
        message: `Invoice quantity ${bucket.qty}${uomSuffix} is not a whole number; rounded to ${roundedQty}.`,
        invoiceId: bucket.invoiceId,
        customerName,
      });
    }
    if (roundedNet < 0) {
      warnInvoiceOnce(
        "NEGATIVE_NET_INVOICE",
        bucket.invoiceId,
        `Invoice ${invoice?.invoiceNumber ?? bucket.invoiceId} nets to a negative amount after returns/credits.`,
        customerName,
      );
    }

    // Retailer taxpayer ID.
    const taxpayerId = digitsOnly(customer?.taxId ?? null);
    if (!taxpayerId) {
      warnInvoiceOnce(
        "MISSING_TAXPAYER_ID",
        bucket.invoiceId,
        `${customerName ?? "This customer"} has no taxpayer ID on file.`,
        customerName,
      );
    } else if (taxpayerId.length !== TAXPAYER_ID_LEN) {
      warnInvoiceOnce(
        "INVALID_TAXPAYER_ID",
        bucket.invoiceId,
        `${customerName ?? "This customer"}'s taxpayer ID "${taxpayerId}" is not ${TAXPAYER_ID_LEN} digits.`,
        customerName,
      );
    }

    // Retailer license: this category's CustomerAuthorization first, else the
    // customer's general tobacco license.
    const retailerLicenseRaw = customer?.authLicenseNumber || customer?.tobaccoLicenseNo || null;
    const retailerLicense = digitsOnly(retailerLicenseRaw);
    if (!retailerLicense) {
      warnInvoiceOnce(
        "MISSING_RETAILER_LICENSE",
        bucket.invoiceId,
        `${customerName ?? "This customer"} has no retailer license on file for this category.`,
        customerName,
      );
    } else if (retailerLicense.length !== RETAILER_LICENSE_LEN) {
      warnInvoiceOnce(
        "INVALID_RETAILER_LICENSE",
        bucket.invoiceId,
        `${customerName ?? "This customer"}'s retailer license "${retailerLicense}" is not ${RETAILER_LICENSE_LEN} digits.`,
        customerName,
      );
    }

    // Address: default+BILLING -> any BILLING -> any default -> first.
    const address = customer ? pickReportAddress(customer.addresses) : null;
    if (!address) {
      warnInvoiceOnce(
        "MISSING_ADDRESS",
        bucket.invoiceId,
        `${customerName ?? "This customer"} has no address on file.`,
        customerName,
      );
    }

    const name = truncate(customer?.businessName ?? "", NAME_MAX);
    const street = truncate(address?.line1 ?? "", STREET_MAX);
    const city = truncate(address?.city ?? "", CITY_MAX);
    const state = (address?.state ?? "").toUpperCase().slice(0, STATE_MAX);
    const zip = digitsOnly(address?.zip ?? "").slice(0, ZIP_MAX);

    const cells = [
      wholesalerLicense,
      taxpayerId,
      name,
      street,
      city,
      state,
      zip,
      retailerLicense,
      itemTypeLabel("TX_COMPTROLLER", bucket.itemType || null),
      bucket.uom,
      String(roundedQty),
      String(roundedNet),
    ];
    // Optional cells, appended after the 12 base cells in canonical registry order.
    if (withItemDescription) cells.push(bucket.productName);
    if (optional.has("invoiceNumber")) cells.push(invoice?.invoiceNumber ?? "");
    if (optional.has("invoiceDate")) {
      cells.push(invoice ? invoice.issueDate.toISOString().slice(0, 10) : "");
    }

    built.push({
      cells,
      issueDate: invoice?.issueDate ?? new Date(0),
      invoiceNumber: invoice?.invoiceNumber ?? "",
      invoiceId: bucket.invoiceId,
      itemType: bucket.itemType,
      uom: bucket.uom,
      productName: bucket.productName,
      roundedQty,
      roundedNet,
    });
  }

  // Rows sort by invoice issue date, then invoice number, then item type code,
  // then UoM code, then product name — so a fan-out invoice's rows are
  // deterministically ordered.
  built.sort((a, b) => {
    const byDate = a.issueDate.getTime() - b.issueDate.getTime();
    if (byDate !== 0) return byDate;
    const byInvoiceNumber = a.invoiceNumber.localeCompare(b.invoiceNumber);
    if (byInvoiceNumber !== 0) return byInvoiceNumber;
    const byItemType = a.itemType.localeCompare(b.itemType);
    if (byItemType !== 0) return byItemType;
    const byUom = a.uom.localeCompare(b.uom);
    if (byUom !== 0) return byUom;
    return a.productName.localeCompare(b.productName);
  });

  const distinctInvoiceIds = new Set(built.map((r) => r.invoiceId));
  const totalQty = built.reduce((t, r) => t + r.roundedQty, 0);
  const totalAmount = built.reduce((t, r) => t + r.roundedNet, 0);

  const optionalColumnDefs = TX_OPTIONAL_COLUMNS.filter((c) => optional.has(c.key));
  const columns = [...TX_COLUMNS, ...optionalColumnDefs];

  return {
    template: "TX_COMPTROLLER",
    title: "TX Comptroller Cigarette/Tobacco Report",
    categoryId: category.id,
    categoryName: category.name,
    from,
    to,
    columns,
    rows: built.map((b) => b.cells),
    // Per-sale template — no aggregate totals row in the CSV.
    totalsRow: null,
    displayTotals: [
      { label: "Invoices", value: String(distinctInvoiceIds.size) },
      { label: "Rows", value: String(built.length) },
      { label: "Total Quantity", value: String(totalQty) },
      { label: "Total Invoice Amount", value: String(totalAmount) },
    ],
    warnings,
    // TX CSV carries no header row and no preamble/footer/totals — commas inside
    // fields (e.g. a retailer name) are double-quoted by report-csv.ts#esc.
    csv: { preamble: [], includeHeader: false, includeTotals: false, footer: [] },
  };
}
