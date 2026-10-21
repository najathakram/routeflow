import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import type { ImportFamilyRowInfo, ImportFamilySummary } from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { calendarStampFromInput } from "../common/calendar-date";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { CustomersService } from "../customers/customers.service";
import { customerNameViolation } from "../customers/customer-name-guard";
import { excludeWalkIn } from "../customers/walk-in-protected";
import {
  addressViolation,
  licenseViolation,
  productCategoryViolation,
  personNameViolation,
  productNameViolation,
} from "../common/text-cell-guards";
import { NumberingService } from "./numbering.service";
import { ExternalRefService } from "./external-ref.service";
import { ProductsService } from "../products/products.service";
import {
  ProductFamilyImportService,
  type FamilyPlan,
  type FamilyRowInput,
} from "./product-family-import.service";
import { roundMoney, roundUnitCost } from "@routeflow/pricing";
import {
  ImportRowRefused,
  importPaymentRefusal,
  importPaymentStatus,
} from "./import-payment-status";
import { parseImportMoney, parseImportNumber } from "./parse-import-number";
import { parse } from "csv-parse/sync";
import { ImportEntityType, InvoiceStatus, MovementType, Prisma, UserRole } from "@prisma/client";
import { lockProductsForStock, STOCK_TX_OPTIONS } from "../common/product-locks";
import { retryStockTx } from "../common/tx-retry";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";
import { addressStateFields } from "../customers/address-state";
import {
  PRODUCT_COLUMNS,
  CUSTOMER_COLUMNS,
  resolveColumns,
  parseRow,
  parseStrictMoneyCell,
} from "./import-columns";
import type { CustomerComplianceInput } from "../customers/customer-compliance-input";

/** B858/B859: money fields in PRODUCT_COLUMNS that get rounded-value diff comparison. */
const PRODUCT_MONEY_FIELDS = new Set([
  "pricePerUnit",
  "priceTier2",
  "priceTier3",
  "priceTier4",
  "priceTier5",
  "standardCost",
  "msrp",
]);

/** Lowercase + collapse whitespace — the "unique within the file" key for name-only matching. */
function normalizeNameKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * B858/B859 file-level entitlement gate (import.service.ts's `importProducts`): tells a genuine
 * entitlement DENIAL apart from an entitlement-check OUTAGE, so the gate's catch never turns an
 * outage into a false "needs the flag" 403.
 *
 * The three asserts this backs (`ProductsService.assertMsrpAllowed` / `assertCanFlagTobacco` /
 * `assertReorderAllowed`) only ever throw a `ForbiddenException` for an actual denial — a plain
 * message (tobacco/msrp) or `buildPlanGateBody`'s `{ code: "PLAN_GATE", ... }` (msrp/reorder).
 * `assertReorderAllowed` can ALSO throw a `ForbiddenException` shaped by `buildPlanFlagDenial` as
 * `{ code: "PLAN_GATE_UNAVAILABLE", ... }` when entitlement resolution itself failed — that is an
 * outage wearing a `ForbiddenException`, not a denial, and must never be relabelled. Any other
 * thrown value (a DB/network error, or anything not a `ForbiddenException`) is unambiguously an
 * outage too.
 */
function isEntitlementDenial(e: unknown): boolean {
  if (!(e instanceof ForbiddenException)) return false;
  const body = e.getResponse();
  const code =
    typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
  return code !== API_ERROR_CODES.PLAN_GATE_UNAVAILABLE;
}

export interface ImportRowPlan {
  row: number;
  label: string;
  action: "create" | "update" | "skip";
  /** field -> { from, to }; `from` is null on a create. */
  changes?: Record<string, { from: unknown; to: unknown }>;
  reason?: string;
  warnings?: string[];
  /** SA-823: the family detail of a row that carried a Family cell. */
  family?: ImportFamilyRowInfo;
}
import { defaultSaleFulfilmentKind } from "../orders/default-sale-fulfilment";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import {
  assertBarcodeAvailable,
  lockBarcodeCodes,
  mapBarcodeUniqueViolation,
  syncProductBarcodesFromLegacy,
} from "../products/product-catalog-sync";
import { claimCodes, codeClaims } from "../products/product-code-release";
import {
  flagRestrictedLines,
  writeRestrictedLinesAudit,
} from "../selling-restrictions/restricted-lines-flag";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { columnEntitlementDenied } from "./import-column-entitlement";

/**
 * F9-008: hard row-count cap on any CSV import. The byte-size caps on the upload
 * interceptors bound the raw payload, but a densely-packed file can still expand
 * into a huge in-memory record array + per-row DB work. Reject past this so a
 * single upload can't exhaust memory / stall the worker.
 */
const MAX_IMPORT_ROWS = 20_000;

/**
 * B268/D4: the external-ref source recorded for invoice CSV rows that carry NO
 * source "Invoice Number". Such a row's only durable identity is the CSV's
 * "Invoice ID" group key, so it is recorded against this source when the invoice
 * is created and looked up before any mint — otherwise every re-upload of the
 * same file reserves a fresh number and duplicates the invoice (and its
 * synthetic payment).
 */
const IMPORT_INVOICE_REF_SOURCE = "import";

/** Category name substrings (lower-cased) that map to the INVENTORY_PURCHASE system code */
const INVENTORY_PURCHASE_KEYWORDS = [
  "inventor", // "inventory", "inventory purchase", "inventory purchases"
  "stock purchase",
  "purchase of stock",
  "purchase of goods",
  "cost of goods",
  "goods purchase",
];

/**
 * #2493: a CSV date cell → the UTC-midnight stamp of the calendar day it names. A `YYYY-MM-DD…`
 * value keeps its literal first ten characters (the #2197 rule); any other format a Zoho export
 * may use ("09/25/2026", "25 Sep 2026") takes the day it names as parsed, read back from the same
 * parse's own calendar fields so neither the value's offset nor the server zone moves it. A value
 * naming no day is null (no due date), never an Invalid Date.
 */
export function importCalendarDay(
  raw: string | null | undefined,
  // The non-ISO parse, injectable so a spec can hand in a Date whose LOCAL and UTC days differ
  // (the only way to pin "local getters" on a UTC CI host; TZ can't be set inside jest).
  parse: (value: string) => Date = (value) => new Date(value),
): Date | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return calendarStampFromInput(value);
  const parsed = parse(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()));
}

type InvoiceMoney =
  | {
      ok: true;
      total: number;
      subtotal: number;
      discount: number;
      shippingFee: number;
      /** NaN = the Balance Due cell is absent (the status logic relies on that). */
      balanceDue: number;
      lines: Map<
        Record<string, string>,
        { unitPrice: number; discount: number; itemTotal: number }
      >;
    }
  | { ok: false; reason: string };

/**
 * #2190: read every money cell of one invoice group with the strict cell check shared with the
 * products/customers path. A blank cell is absent (today's default: 0, or NaN for Balance Due); a
 * non-blank cell that is not a number (or overflows Decimal(10,2)) fails the group with a reason
 * naming the column header as it was read. Negative values are legitimate on an invoice.
 */
function readInvoiceMoney(invoiceRows: Record<string, string>[]): InvoiceMoney {
  let reason: string | null = null;
  const read = (row: Record<string, string>, headers: string[], absent: number): number => {
    for (const header of headers) {
      const raw = row[header];
      if (raw == null || String(raw).trim() === "") continue;
      const r = parseStrictMoneyCell(String(raw), { allowNegative: true });
      if (r.ok) return r.value;
      reason ??= `${header}: ${r.reason}`;
      return absent;
    }
    return absent;
  };
  const first = invoiceRows[0];
  const total = read(first, ["Total"], 0);
  const subtotal = read(first, ["SubTotal", "Sub Total"], 0);
  const discount = read(first, ["Entity Discount Amount", "Discount Amount"], 0);
  const shippingFee = read(first, ["Shipping Charge"], 0);
  const balanceDue = read(first, ["Balance Due", "Balance", "Outstanding Amount"], NaN);
  const lines: Map<
    Record<string, string>,
    { unitPrice: number; discount: number; itemTotal: number }
  > = new Map();
  for (const row of invoiceRows) {
    lines.set(row, {
      unitPrice: read(row, ["Item Price"], 0),
      discount: read(row, ["Discount Amount"], 0),
      itemTotal: read(row, ["Item Total"], 0),
    });
  }
  if (reason) return { ok: false, reason };
  return { ok: true, total, subtotal, discount, shippingFee, balanceDue, lines };
}

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vendorBillsService: VendorBillsService,
    private readonly customersService: CustomersService,
    private readonly numbering: NumberingService,
    private readonly externalRefs: ExternalRefService,
    private readonly productsService: ProductsService,
    private readonly sellingRestrictions: SellingRestrictionsService,
    // SA-823 (row 655): the Family / Variant name / Product ID columns of the product import.
    @Optional() private readonly familyImport?: ProductFamilyImportService,
  ) {}

  private parseCsv(buffer: Buffer): any[] {
    let records: any[];
    try {
      records = parse(buffer.toString("utf8"), {
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        relax_quotes: true,
        trim: true,
        bom: true,
      });
    } catch (e) {
      this.logger.error("CSV parse error", e);
      return [];
    }
    // F9-008: enforce the row cap OUTSIDE the try so it surfaces as a clear 400
    // instead of being swallowed into the empty-result path.
    if (records.length > MAX_IMPORT_ROWS) {
      throw new BadRequestException(
        `This file has ${records.length} rows, above the ${MAX_IMPORT_ROWS}-row import limit. Split it into smaller files.`,
      );
    }
    return records;
  }

  /**
   * F8-003: record a per-row import failure without leaking DB/exception
   * internals (Prisma error text discloses table/column names). The real error
   * is logged server-side; the client sees a generic, row-scoped message.
   */
  private pushRowError(errors: string[], label: string, e: unknown): void {
    const detail = e instanceof Error ? e.message : String(e);
    this.logger.warn(`Import row failed [${label}]: ${detail}`);
    errors.push(`${label}: import failed`);
  }

  private generateTempPassword(): string {
    return crypto.randomBytes(6).toString("hex");
  }

  private mapPaymentMethod(method: string): string {
    const m = (method || "").toLowerCase().trim();
    if (m === "cash") return "CASH";
    if (m === "check" || m === "cheque") return "CHECK";
    if (m === "zelle") return "ZELLE";
    if (m === "ach" || m === "wire") return "ACH";
    return "OTHER";
  }

  private mapInvoiceStatus(zohoStatus: string): InvoiceStatus {
    const s = (zohoStatus || "").toLowerCase().trim();
    if (s === "closed" || s === "paid") return InvoiceStatus.PAID;
    if (s === "overdue") return InvoiceStatus.OVERDUE;
    if (s === "draft") return InvoiceStatus.DRAFT;
    if (s.includes("partial")) return InvoiceStatus.PARTIAL;
    if (s === "void" || s === "voided") return InvoiceStatus.VOID;
    if (s === "write off" || s === "write-off" || s === "written off" || s === "written-off")
      return InvoiceStatus.WRITTEN_OFF;
    if (s === "sent" || s === "open") return InvoiceStatus.SENT;
    return InvoiceStatus.SENT;
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 30);
  }

  /**
   * Extracts the vendor/supplier name from a CSV row, checking all common
   * Zoho column names in priority order:
   * Zoho Expense → "Merchant Name"
   * Zoho Books   → "Vendor Name" | "Customer Name"
   * Generic      → "Payee" | "Supplier Name" | "Company Name"
   */
  private getVendorName(row: any): string {
    return (
      row["Merchant Name"] ||
      row["Vendor Name"] ||
      row["Customer Name"] ||
      row["Payee"] ||
      row["Supplier Name"] ||
      row["Company Name"] ||
      ""
    ).trim();
  }

  /**
   * Builds a complete supplier data object for a given vendor name by:
   * 1. Extracting whatever detail columns are present in the CSV row
   * 2. Looking up a matching Customer contact by name (case-insensitive)
   * 3. Filling any remaining gaps from the customer record
   *
   * CSV columns always take priority over customer contact data.
   */
  private async buildSupplierData(name: string, csvRow: any): Promise<Record<string, any>> {
    const data: Record<string, any> = { name };

    // ── Layer 1: CSV columns ─────────────────────────────────────────────────
    const csv = {
      email: (csvRow["Vendor Email"] || csvRow["Email"] || "").trim(),
      phone: (csvRow["Vendor Phone"] || csvRow["Phone"] || "").trim(),
      mobile: (csvRow["Vendor Mobile"] || csvRow["Mobile"] || "").trim(),
      website: (csvRow["Vendor Website"] || csvRow["Website"] || "").trim(),
      contactName: (csvRow["Contact Name"] || csvRow["Vendor Contact"] || "").trim(),
      addressLine1: (
        csvRow["Vendor Address"] ||
        csvRow["Billing Address"] ||
        csvRow["Address"] ||
        ""
      ).trim(),
      city: (csvRow["Vendor City"] || csvRow["City"] || "").trim(),
      state: (csvRow["Vendor State"] || csvRow["State"] || "").trim(),
      zip: (csvRow["Vendor Zip"] || csvRow["Vendor ZIP"] || csvRow["Zip"] || "").trim(),
      country: (csvRow["Vendor Country"] || csvRow["Country"] || "").trim(),
    };
    for (const [k, v] of Object.entries(csv)) {
      if (v) data[k] = v;
    }

    // ── Layer 2: Customer contact match (fills gaps left by CSV) ─────────────
    const matchingCustomers = await this.prisma.forTenant().customer.findMany({
      where: {
        OR: [
          { businessName: { equals: name, mode: "insensitive" } },
          { displayName: { equals: name, mode: "insensitive" } },
          { contactName: { equals: name, mode: "insensitive" } },
        ],
      },
      include: { addresses: true },
    });

    if (matchingCustomers.length > 0) {
      const c = matchingCustomers[0];
      if (!data.phone && c.phone) data.phone = c.phone;
      if (!data.mobile && c.mobile) data.mobile = c.mobile;
      if (!data.email && c.email) data.email = c.email;
      if (!data.contactName && c.contactName) data.contactName = c.contactName;
      if (c.notes && !data.notes) data.notes = c.notes;

      // Address — only if CSV didn't provide one
      if (!data.addressLine1) {
        const addr = c.addresses.find((a) => a.addressType === "BILLING") ?? c.addresses[0];
        if (addr) {
          if (addr.line1) data.addressLine1 = addr.line1;
          if (addr.line2) data.addressLine2 = addr.line2;
          if (addr.city) data.city = addr.city;
          if (addr.state) data.state = addr.state;
          if (addr.zip) data.zip = addr.zip;
        }
      }
    }

    return data;
  }

  /**
   * B964: the readable refusal for a commercial TEXT cell of a contacts row (the tobacco license number), change-only against the
   * existing customer. A method of its own: importContacts' raw writes must not name a commercial field (SA-284 binding pin).
   */
  private commercialTextViolation(
    values: Record<string, unknown>,
    existing: Record<string, unknown> | null | undefined,
  ): string | null {
    return licenseViolation(
      { tobaccoLicenseNo: values.tobaccoLicenseNo as string | undefined },
      existing ? { tobaccoLicenseNo: existing.tobaccoLicenseNo as string | null } : null,
    );
  }

  /**
   * B858/B859 FIX4: builds the `Partial<UpdateCustomerDto>` + `CustomerComplianceInput` diff for
   * one contacts row's commercial columns, applies it through `CustomersService.update` (the ONE
   * write path, SA-284 a), and records consent-change audit evidence. Never touches identity or
   * address fields — those stay on the pre-existing raw code path (SA-284 binding).
   */
  private async applyCustomerCommercialFields(params: {
    customerId: string;
    values: Record<string, unknown>;
    existing: Record<string, unknown>;
    userId: string;
    rowNumber: number;
    fileName?: string;
    dryRun: boolean;
    warnings: string[];
    label: string;
  }): Promise<Record<string, { from: unknown; to: unknown }>> {
    const { customerId, values, existing, userId, rowNumber, fileName, dryRun, warnings, label } =
      params;

    const diff: Record<string, unknown> = {};
    const DIFF_FIELDS = [
      "defaultPaymentTerms",
      "pricingTier",
      "creditLimit",
      "isTaxExempt",
      "taxId",
      "deliveryWindowStart",
      "deliveryWindowEnd",
    ] as const;
    for (const field of DIFF_FIELDS) {
      const newVal = values[field];
      if (newVal === undefined) continue;
      const existingVal = existing[field];
      const differs =
        field === "creditLimit"
          ? // null means "no limit"; a 0 limit is a real value and must still be written
            existingVal == null ||
            roundMoney(Number(existingVal)) !== roundMoney(Number(newVal as number))
          : typeof newVal === "string"
            ? (typeof existingVal === "string" ? existingVal.trim() : "") !== newVal.trim()
            : existingVal !== newVal;
      if (differs) diff[field] = newVal;
    }

    const compliance: CustomerComplianceInput = {};
    if (values.tobaccoLicenseNo !== undefined) {
      const existingVal = existing.tobaccoLicenseNo as string | null | undefined;
      const newVal = values.tobaccoLicenseNo as string;
      if ((existingVal ?? "").trim() !== newVal.trim()) compliance.tobaccoLicenseNo = newVal;
    }
    if (values.tobaccoLicenseExpiry !== undefined) {
      const newDate = values.tobaccoLicenseExpiry as Date;
      const existingVal = existing.tobaccoLicenseExpiry as Date | null | undefined;
      const differs = !existingVal || new Date(existingVal).getTime() !== newDate.getTime();
      if (differs) compliance.tobaccoLicenseExpiry = newDate;
      if (newDate.getTime() < Date.now()) {
        warnings.push(
          `Row ${rowNumber} (${label}): tobacco licence expired ${newDate.toISOString().slice(0, 10)}`,
        );
      }
    }

    // SA-305 (2): consent no longer rides `compliance` into `customersService.update` (that write
    // and the evidence insert were two independent statements — a DB hiccup between them could
    // leave consent granted with no evidence row). It goes through `setCustomerConsent`, which
    // writes the consent column(s) AND the evidence row in ONE tenantTransaction.
    const consentChannels: { field: "smsConsent" | "waConsent"; channel: "sms" | "wa" }[] = [
      { field: "smsConsent", channel: "sms" },
      { field: "waConsent", channel: "wa" },
    ];
    const consentInput: { smsConsent?: boolean; waConsent?: boolean } = {};
    const consentChanges: { field: "smsConsent" | "waConsent"; value: boolean }[] = [];
    for (const { field, channel } of consentChannels) {
      const newVal = values[field];
      if (newVal === undefined) continue;
      const existingVal = existing[field];
      if (Boolean(existingVal) !== Boolean(newVal)) {
        consentInput[field] = newVal as boolean;
        consentChanges.push({ field, value: newVal as boolean });
      }
      void channel; // kept for the meta shape read below
    }

    const planned: Record<string, { from: unknown; to: unknown }> = {};
    for (const [field, to] of Object.entries({ ...diff, ...compliance })) {
      planned[field] = { from: existing[field] ?? null, to };
    }
    for (const { field, value } of consentChanges) {
      planned[field] = { from: existing[field] ?? null, to: value };
    }
    const hasDiff = Object.keys(diff).length > 0;
    const hasCompliance = Object.keys(compliance).length > 0;
    const hasConsent = consentChanges.length > 0;
    if (!hasDiff && !hasCompliance && !hasConsent) return planned;
    if (dryRun) return planned;

    if (hasDiff || hasCompliance) {
      await this.customersService.update(customerId, diff as any, {
        compliance: hasCompliance ? compliance : undefined,
      });
    }

    if (hasConsent) {
      try {
        await this.customersService.setCustomerConsent(customerId, consentInput, {
          userId,
          source: "import",
          fileName,
          row: rowNumber,
        });
      } catch {
        // SA-305 (2): a failing consent tx skips ONLY that row's consent — the rest of the row
        // (identity + other commercial fields, already committed above) still stands. Never
        // report a consent change that was not actually persisted.
        for (const { field } of consentChanges) delete planned[field];
        warnings.push(
          `Row ${rowNumber} (${label}): consent evidence could not be recorded — consent left unchanged`,
        );
      }
    }
    return planned;
  }

  async importContacts(
    buffer: Buffer,
    userId: string,
    opts?: { dryRun?: boolean; fileName?: string },
  ): Promise<{
    created: number;
    updated: number;
    skipped: number;
    errors: string[];
    unchanged: number;
    rows: ImportRowPlan[];
    skippedRows: { row: number; label: string; reason: string }[];
    warnings: string[];
    unknownColumns: string[];
    dryRun: boolean;
  }> {
    const dryRun = !!opts?.dryRun;
    // Same CUSTOMERS soft-cap gate as the single-create path: a no-op unless the
    // tenant is over cap AND its grace window already expired. Checked once up
    // front rather than per row — an import is one user action, and the gate
    // blocks only brand-new customers (updates to existing ones stay allowed).
    await this.customersService.assertCustomerCapNotExceeded();

    const rows = this.parseCsv(buffer);
    const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
    const resolvedColumns = resolveColumns(headers, CUSTOMER_COLUMNS);
    const unknownColumns = resolvedColumns.unknownColumns;

    let created = 0,
      updated = 0,
      skipped = 0;
    // A matched contact always re-patches its identity fields (pre-existing block, kept raw
    // this PR per SA-284), so every match counts as `updated`; `unchanged` stays 0 here.
    const unchanged = 0;
    const errors: string[] = [];
    const rowPlans: ImportRowPlan[] = [];
    const skippedRows: { row: number; label: string; reason: string }[] = [];
    const warnings: string[] = [];
    // In-file claims, so a later row that resolves to the same customer is a "duplicate of row N"
    // in BOTH dryRun and a real run (a real run would otherwise name-match the customer an
    // earlier row just created, while the preview — which wrote nothing — planned two creates).
    const claimedZohoIds = new Map<string, number>();
    const claimedNames = new Map<string, { row: number; zohoContactId: string | null }>();
    // The walk-in customer's name and Customer ID are reserved: a row carrying either is skipped.
    const walkIn = await this.prisma
      .forTenant()
      .customer.findFirst({ where: { isWalkIn: true, deletedAt: null } });
    const claimedCustomerIds = new Map<string, number>();
    let rowNumber = 0;

    for (const row of rows) {
      rowNumber++;

      // B858/B859: any unparseable commercial cell skips the WHOLE row before any write —
      // never a partial identity write for a row with a bad commercial cell.
      const parsedCommercial = parseRow(row, resolvedColumns, CUSTOMER_COLUMNS);
      const preliminaryLabel =
        (row["Customer Name"] || row["Display Name"] || row["Company Name"] || "").trim() ||
        `row ${rowNumber}`;
      if (parsedCommercial.badCells.length > 0) {
        const first = parsedCommercial.badCells[0];
        const reason = `${first.column}: ${first.reason}`;
        skipped++;
        skippedRows.push({ row: rowNumber, label: preliminaryLabel, reason });
        errors.push(`${preliminaryLabel}: ${reason}`);
        rowPlans.push({ row: rowNumber, label: preliminaryLabel, action: "skip", reason });
        continue;
      }
      // SA-305 (1): a per-row warning for a cell that dropped its value without failing the row
      // (today, only an unmapped bare "Payment Terms" integer) — surfaced in both dryRun/real.
      for (const w of parsedCommercial.warnings) {
        warnings.push(`Row ${rowNumber} (${preliminaryLabel}): ${w.message}`);
      }

      // Only import customer-type contacts (skip vendors etc.) — I4: record the skip so it's
      // visible in `rows`/`skippedRows`, not just the summary count.
      const contactType = (row["Contact Type"] || "customer").toLowerCase().trim();
      if (contactType && contactType !== "customer") {
        const reason = `Contact Type: not a customer (${contactType})`;
        skipped++;
        skippedRows.push({ row: rowNumber, label: preliminaryLabel, reason });
        rowPlans.push({ row: rowNumber, label: preliminaryLabel, action: "skip", reason });
        continue;
      }

      const name = (
        row["Customer Name"] ||
        row["Display Name"] ||
        row["Company Name"] ||
        ""
      ).trim();
      if (!name) {
        const reason = "Name is required";
        skipped++;
        skippedRows.push({ row: rowNumber, label: preliminaryLabel, reason });
        rowPlans.push({ row: rowNumber, label: preliminaryLabel, action: "skip", reason });
        continue;
      }

      const zohoContactId = (row["Customer ID"] || "").trim() || null;
      const skipContact = (reason: string) => {
        skipped++;
        skippedRows.push({ row: rowNumber, label: preliminaryLabel, reason });
        errors.push(`${preliminaryLabel}: ${reason}`);
        rowPlans.push({ row: rowNumber, label: preliminaryLabel, action: "skip", reason });
      };
      if (zohoContactId && claimedZohoIds.has(zohoContactId)) {
        skipContact(`duplicate of row ${claimedZohoIds.get(zohoContactId)}`);
        continue;
      }
      if (
        walkIn?.isWalkIn === true &&
        ((zohoContactId && zohoContactId === walkIn.zohoContactId) ||
          normalizeNameKey(name) === normalizeNameKey(walkIn.businessName))
      ) {
        skipContact(`Row ${rowNumber} skipped: this name is reserved for walk-in sales.`);
        continue;
      }

      // Extract all fields from CSV
      const displayName = (row["Display Name"] || "").trim() || null;
      const salutation = (row["Salutation"] || "").trim() || null;
      const firstName = (row["First Name"] || "").trim() || null;
      const lastName = (row["Last Name"] || "").trim() || null;
      // Main phone from Phone column (preferred), fallback to Billing Phone
      const phone =
        (row["Phone"] || row["Billing Phone"] || "").replace(/^'+/, "").replace(/'+/g, "").trim() ||
        null;
      // Mobile from MobilePhone column
      const mobile =
        (row["MobilePhone"] || "").replace(/^'+/, "").replace(/'+/g, "").trim() || null;
      const csvEmail = (row["EmailID"] || row["Email"] || "").trim().toLowerCase() || null;
      const currency = (row["Currency Code"] || "USD").trim() || "USD";
      const notes = (row["Notes"] || "").trim() || null;

      // Contact name: First+Last, or Billing Attention, or business name
      const contactName =
        [firstName, lastName].filter(Boolean).join(" ").trim() ||
        (row["Billing Attention"] || "").trim() ||
        name;

      // Billing address fields
      const billingLine1 = [row["Billing Address"], row["Billing Street2"]]
        .filter(Boolean)
        .join(", ")
        .trim();
      const billingCity = (row["Billing City"] || "").trim();
      const billingState = (row["Billing State"] || "").trim();
      const billingZip = (row["Billing Code"] || "").trim();
      const billingLatRaw = parseFloat(row["Billing Latitude"] || "");
      const billingLngRaw = parseFloat(row["Billing Longitude"] || "");
      const billingLat = isNaN(billingLatRaw) ? null : billingLatRaw;
      const billingLng = isNaN(billingLngRaw) ? null : billingLngRaw;
      const hasBilling = !!(billingLine1 || billingCity);

      // Shipping address fields
      const shippingLine1 = [row["Shipping Address"], row["Shipping Street2"]]
        .filter(Boolean)
        .join(", ")
        .trim();
      const shippingCity = (row["Shipping City"] || "").trim();
      const shippingState = (row["Shipping State"] || "").trim();
      const shippingZip = (row["Shipping Code"] || "").trim();
      const shippingLatRaw = parseFloat(row["Shipping Latitude"] || "");
      const shippingLngRaw = parseFloat(row["Shipping Longitude"] || "");
      const shippingLat = isNaN(shippingLatRaw) ? null : shippingLatRaw;
      const shippingLng = isNaN(shippingLngRaw) ? null : shippingLngRaw;
      // Only create shipping if it has data and differs from billing
      const hasShipping =
        !!(shippingLine1 || shippingCity) &&
        (shippingLine1 !== billingLine1 ||
          shippingCity !== billingCity ||
          shippingZip !== billingZip);

      // Find existing customer: prefer Zoho ID match, then fall back to
      // case-insensitive businessName match for customers imported before
      // zohoContactId tracking was wired up.
      // Both lookups also skip the walk-in customer, so a row naming it is handled like an unmatched row.
      // I2: both lookups exclude soft-deleted customers — a deleted match would otherwise run
      // the raw identity/address writes below, THEN throw "Restore the customer first" out of
      // `applyCustomerCommercialFields`, leaving a partial row (identity written, commercial not).
      let existing = zohoContactId
        ? await this.prisma.forTenant().customer.findFirst({
            where: excludeWalkIn({ zohoContactId, deletedAt: null }),
            include: { addresses: true, contactPersons: true },
          })
        : null;
      if (!existing && zohoContactId) {
        // W5: a Customer ID that belongs to a SOFT-DELETED customer is that customer — never a
        // reason to fall through to a name match or to create a second one. Same in both modes.
        const deleted = await this.prisma.forTenant().customer.findFirst({
          where: { zohoContactId, deletedAt: { not: null } },
          select: { id: true },
        });
        if (deleted) {
          skipContact("matches a deleted customer; restore it first");
          continue;
        }
      }
      if (!existing) {
        // A name an earlier row of THIS file already claimed decides the row before the DB is
        // asked — identical in dryRun (nothing written yet) and a real run.
        const claimedName = claimedNames.get(normalizeNameKey(name));
        if (claimedName) {
          if (
            zohoContactId &&
            claimedName.zohoContactId &&
            claimedName.zohoContactId !== zohoContactId
          ) {
            skipContact(
              `Customer ID ${zohoContactId} not found; name matches a customer with Customer ID ${claimedName.zohoContactId}`,
            );
          } else {
            skipContact(`duplicate of row ${claimedName.row}`);
          }
          continue;
        }
        // I2: ambiguity must be decided BEFORE any write — `findMany(take 2)` + skip, the same
        // rule and "same normalization" (case-insensitive exact) as the product name match.
        const byName = await this.prisma.forTenant().customer.findMany({
          where: excludeWalkIn({
            businessName: { equals: name, mode: "insensitive" as const },
            deletedAt: null,
          }),
          include: { addresses: true, contactPersons: true },
          take: 2,
        });
        if (byName.length > 1) {
          skipContact(`ambiguous name (${byName.length} matches)`);
          continue;
        }
        const nameMatch = byName[0] ?? null;
        // Same rule as products' SKU (I1): the name fallback exists for customers imported
        // before Customer ID tracking. A name match carrying a DIFFERENT Customer ID is another
        // Zoho contact — never merge the two.
        if (
          nameMatch &&
          zohoContactId &&
          nameMatch.zohoContactId &&
          nameMatch.zohoContactId !== zohoContactId
        ) {
          skipContact(
            `Customer ID ${zohoContactId} not found; name matches a customer with Customer ID ${nameMatch.zohoContactId}`,
          );
          continue;
        }
        existing = nameMatch;
      }

      if (existing && claimedCustomerIds.has(existing.id)) {
        skipContact(`duplicate of row ${claimedCustomerIds.get(existing.id)}`);
        continue;
      }
      // B956: a formula-led name rejects THIS row (never the batch, never a half-write); only a
      // CHANGED name is checked, so a legacy value re-imported unchanged still updates its row.
      const nameViolation = customerNameViolation(
        { businessName: name, contactName, displayName },
        existing,
      );
      if (nameViolation) {
        skipContact(nameViolation);
        continue;
      }
      // B964: the same rule for the row's billing/shipping address text and its tobacco license number (change-only for the
      // license against an existing customer): reject THIS row before any write; the importer never reads or rewrites stored rows.
      // Change-only (lead Opus on #3010): an address cell is checked only when the importer WILL write it: always for a new
      // customer, and for an existing one only when that address type is missing AND the row has that address to write (shipping equal to billing writes no shipping row).
      const hasStoredBilling = (existing?.addresses ?? []).some((a) => a.addressType === "BILLING");
      const hasStoredShipping = (existing?.addresses ?? []).some(
        (a) => a.addressType === "SHIPPING",
      );
      const textViolation =
        (hasStoredBilling || !hasBilling
          ? null
          : addressViolation({
              line1: billingLine1,
              city: billingCity,
              state: billingState,
              zip: billingZip,
            })) ??
        (hasStoredShipping || !hasShipping
          ? null
          : addressViolation({
              line1: shippingLine1,
              city: shippingCity,
              state: shippingState,
              zip: shippingZip,
            })) ??
        this.commercialTextViolation(parsedCommercial.values, existing) ??
        // B984: the row's person name (salutation / first / last name). A ContactPerson is created only for a row with a first or last
        // name, for a new customer or an existing one with none: that write is verbatim, so it is checked WITHOUT a stored row.
        // Otherwise only a CHANGED value is checked, against the customer's own copy.
        personNameViolation(
          { salutation, firstName, lastName },
          (firstName || lastName) && (!existing || (existing.contactPersons?.length ?? 0) === 0)
            ? null
            : (existing as never),
        );
      if (textViolation) {
        skipContact(textViolation);
        continue;
      }
      const claimZohoId = zohoContactId ?? existing?.zohoContactId ?? null;
      if (existing) claimedCustomerIds.set(existing.id, rowNumber);
      if (claimZohoId) claimedZohoIds.set(claimZohoId, rowNumber);
      claimedNames.set(normalizeNameKey(name), { row: rowNumber, zohoContactId: claimZohoId });
      if (existing?.businessName) {
        claimedNames.set(normalizeNameKey(existing.businessName), {
          row: rowNumber,
          zohoContactId: claimZohoId,
        });
      }

      if (existing) {
        // Update the existing customer with any missing/new fields
        let contactDetailsWritten = false;
        try {
          if (!dryRun) {
            await this.prisma.forTenant().customer.update({
              where: { id: existing.id },
              data: {
                ...(zohoContactId && !existing.zohoContactId && { zohoContactId }),
                ...(displayName !== null && { displayName }),
                ...(salutation !== null && { salutation }),
                ...(firstName !== null && { firstName }),
                ...(lastName !== null && { lastName }),
                ...(phone !== null && !existing.phone && { phone }),
                ...(mobile !== null && { mobile }),
                ...(csvEmail !== null && { email: csvEmail }),
                ...(notes !== null && { notes }),
                currency,
                contactName:
                  existing.contactName === existing.businessName
                    ? contactName || existing.contactName
                    : existing.contactName,
              },
            });
            contactDetailsWritten = true; // from here on, a throw leaves part of the row written

            // Add billing address if not already present
            const existingBilling = existing.addresses.find((a) => a.addressType === "BILLING");
            if (!existingBilling && hasBilling) {
              await this.prisma.forTenant().customerAddress.create({
                data: {
                  customerId: existing.id,
                  label: "Billing",
                  line1: billingLine1 || billingCity || "Unknown",
                  city: billingCity || "Unknown",
                  state: billingState || "Unknown",
                  ...addressStateFields(billingState, billingZip),
                  zip: billingZip || "00000",
                  lat: billingLat,
                  lng: billingLng,
                  addressType: "BILLING",
                  isDefault: true,
                },
              });
            }

            // Add shipping address if not already present and differs from billing
            const existingShipping = existing.addresses.find((a) => a.addressType === "SHIPPING");
            if (!existingShipping && hasShipping) {
              await this.prisma.forTenant().customerAddress.create({
                data: {
                  customerId: existing.id,
                  label: "Shipping",
                  line1: shippingLine1 || shippingCity || "Unknown",
                  city: shippingCity || "Unknown",
                  state: shippingState || "Unknown",
                  ...addressStateFields(shippingState, shippingZip),
                  zip: shippingZip || "00000",
                  lat: shippingLat,
                  lng: shippingLng,
                  addressType: "SHIPPING",
                  isDefault: false,
                },
              });
            }

            // Add contact person if we have a name and none exists yet
            if ((firstName || lastName) && existing.contactPersons.length === 0) {
              await this.prisma.forTenant().contactPerson.create({
                data: {
                  customerId: existing.id,
                  salutation: salutation || null,
                  firstName: firstName || contactName,
                  lastName: lastName || null,
                  email: csvEmail || null,
                  phone: phone || null,
                  mobile: mobile || null,
                  isPrimary: true,
                },
              });
            }
          }

          // B858/B859 FIX4: commercial columns (payment terms, pricing tier, credit limit, tax,
          // tobacco licence, consent) go through CustomersService.update for BOTH matched and
          // created rows — the identity/address code above is unchanged (SA-284 binding).
          const commercialChanges = await this.applyCustomerCommercialFields({
            customerId: existing.id,
            values: parsedCommercial.values,
            existing,
            userId,
            rowNumber,
            fileName: opts?.fileName,
            dryRun,
            warnings,
            label: preliminaryLabel,
          });

          updated++;
          rowPlans.push({
            row: rowNumber,
            label: preliminaryLabel,
            action: "update",
            changes: commercialChanges,
          });
        } catch (e: any) {
          // I2b: nothing on this row is silent. Before any write, a throw is a clean skip. After
          // the (pre-existing, raw) contact-details write, the row is NOT a skip — those details
          // are saved — so it stays an update and carries the failure as a warning + error;
          // re-importing the row applies the rest (the importer is idempotent).
          const reason = e instanceof HttpException ? e.message : "import failed";
          if (e instanceof HttpException) {
            errors.push(`${preliminaryLabel}: ${reason}`);
          } else {
            this.pushRowError(errors, `${name} (update)`, e);
          }
          if (contactDetailsWritten) {
            const message = `commercial columns not saved (${reason}) — re-import this row to apply them`;
            updated++;
            warnings.push(`Row ${rowNumber} (${preliminaryLabel}): ${message}`);
            rowPlans.push({
              row: rowNumber,
              label: preliminaryLabel,
              action: "update",
              changes: {},
              warnings: [message],
            });
          } else {
            skipped++;
            skippedRows.push({ row: rowNumber, label: preliminaryLabel, reason });
            rowPlans.push({ row: rowNumber, label: preliminaryLabel, action: "skip", reason });
          }
        }
        continue;
      }

      // Generate a unique username from business name
      const baseUsername = this.slugify(name);
      let username = baseUsername;
      let suffix = 1;
      while (await this.prisma.forTenant().user.findFirst({ where: { username } })) {
        username = `${baseUsername}_${suffix++}`;
      }

      // Determine user email: use CSV email if not taken, otherwise synthetic
      let userEmail: string;
      if (csvEmail) {
        const emailTaken = await this.prisma
          .forTenant()
          .user.findFirst({ where: { email: csvEmail } });
        userEmail = emailTaken ? `${username}@imported.local` : csvEmail;
      } else {
        userEmail = `${username}@imported.local`;
      }

      let customerCreated = false;
      try {
        let createdChanges: Record<string, { from: unknown; to: unknown }> = {};
        if (!dryRun) {
          const hashedPassword = await bcrypt.hash(this.generateTempPassword(), 10);
          let newCustomerId = "";

          await this.prisma.tenantTransaction(async (tx) => {
            const user = await tx.user.create({
              data: {
                email: userEmail,
                username,
                password: hashedPassword,
                role: UserRole.CUSTOMER,
                forcePasswordChange: true,
              },
            });

            const customer = await tx.customer.create({
              data: {
                userId: user.id,
                businessName: name,
                contactName: contactName || name,
                displayName: displayName || null,
                salutation: salutation || null,
                firstName: firstName || null,
                lastName: lastName || null,
                phone: phone || null,
                mobile: mobile || null,
                email: csvEmail || null,
                currency,
                notes: notes || null,
                zohoContactId: zohoContactId || null,
              },
            });
            newCustomerId = customer.id;

            // Billing address
            if (hasBilling) {
              await tx.customerAddress.create({
                data: {
                  customerId: customer.id,
                  label: "Billing",
                  line1: billingLine1 || billingCity || "Unknown",
                  city: billingCity || "Unknown",
                  state: billingState || "Unknown",
                  ...addressStateFields(billingState, billingZip),
                  zip: billingZip || "00000",
                  lat: billingLat,
                  lng: billingLng,
                  addressType: "BILLING",
                  isDefault: true,
                },
              });
            }

            // Shipping address (only if different from billing)
            if (hasShipping) {
              await tx.customerAddress.create({
                data: {
                  customerId: customer.id,
                  label: "Shipping",
                  line1: shippingLine1 || shippingCity || "Unknown",
                  city: shippingCity || "Unknown",
                  state: shippingState || "Unknown",
                  ...addressStateFields(shippingState, shippingZip),
                  zip: shippingZip || "00000",
                  lat: shippingLat,
                  lng: shippingLng,
                  addressType: "SHIPPING",
                  isDefault: false,
                },
              });
            }

            // Create contact person entry if we have a name
            if (firstName || lastName) {
              await tx.contactPerson.create({
                data: {
                  customerId: customer.id,
                  salutation: salutation || null,
                  firstName: firstName || contactName,
                  lastName: lastName || null,
                  email: csvEmail || null,
                  phone: phone || null,
                  mobile: mobile || null,
                  isPrimary: true,
                },
              });
            }
          });
          customerCreated = true;

          // B858/B859 FIX4: commercial columns for a brand-new row go through the same
          // CustomersService.update path as a matched row (SA-284 a) — never folded into the
          // raw tx.customer.create data above.
          createdChanges = await this.applyCustomerCommercialFields({
            customerId: newCustomerId,
            values: parsedCommercial.values,
            existing: {},
            userId,
            rowNumber,
            fileName: opts?.fileName,
            dryRun,
            warnings,
            label: preliminaryLabel,
          });
        } else {
          // Preview: plan the commercial fields for the would-be customer; nothing is written.
          createdChanges = await this.applyCustomerCommercialFields({
            customerId: "",
            values: parsedCommercial.values,
            existing: {},
            userId,
            rowNumber,
            fileName: opts?.fileName,
            dryRun,
            warnings,
            label: preliminaryLabel,
          });
        }

        created++;
        rowPlans.push({
          row: rowNumber,
          label: preliminaryLabel,
          action: "create",
          changes: createdChanges,
        });
      } catch (e: any) {
        if (customerCreated) {
          // The customer (user, addresses, contact person) committed in its own transaction;
          // only the commercial columns that follow failed. It is a created row with a visible
          // failure, never a "skip" (that would claim nothing was written).
          const reason = e instanceof HttpException ? e.message : "import failed";
          if (e instanceof HttpException) errors.push(`${preliminaryLabel}: ${reason}`);
          else this.pushRowError(errors, name, e);
          const message = `commercial columns not saved (${reason}) — re-import this row to apply them`;
          created++;
          warnings.push(`Row ${rowNumber} (${preliminaryLabel}): ${message}`);
          rowPlans.push({
            row: rowNumber,
            label: preliminaryLabel,
            action: "create",
            changes: {},
            warnings: [message],
          });
          continue;
        }
        // P2002 = unique constraint violation — the customer (or their user account)
        // already exists in the database. Treat as a skip rather than an error so
        // re-importing the same CSV doesn't flood the UI with noise.
        // I4: every skip reason lands in `rows`/`skippedRows` — previously a failed create
        // never appeared there at all (invisible except for the summary's "skipped" count).
        skipped++;
        const reason = e?.code === "P2002" ? "already exists" : "import failed";
        if (e?.code === "P2002") {
          errors.push(`${preliminaryLabel}: ${reason}`);
        } else {
          this.pushRowError(errors, name, e);
        }
        skippedRows.push({ row: rowNumber, label: preliminaryLabel, reason });
        rowPlans.push({ row: rowNumber, label: preliminaryLabel, action: "skip", reason });
      }
    }

    // The import ALWAYS succeeds — this only opens a grace window when the rows
    // just written pushed the tenant over cap. Never throws. dryRun writes nothing,
    // so it never opens a grace window either.
    if (!dryRun && created > 0) await this.customersService.maybeStartCustomerGrace();

    return {
      created,
      updated,
      skipped,
      errors,
      unchanged,
      rows: rowPlans,
      skippedRows,
      warnings,
      unknownColumns,
      dryRun,
    };
  }

  async importInvoices(
    buffer: Buffer,
    userId: string,
  ): Promise<{
    imported: number;
    updated: number;
    skipped: number;
    errors: string[];
    restrictedLines: Array<{
      invoiceNumber: string;
      productId: string;
      productName: string;
      message: string;
    }>;
  }> {
    const rows = this.parseCsv(buffer);
    let imported = 0,
      updated = 0,
      skipped = 0;
    // F-05 (#2093): IMPORT IS EXEMPT — every row imports unchanged; flag only. Collected as we go
    // (customer + catalog productIds per newly-created invoice), checked in ONE batch per
    // customer AFTER the loop (never per row) so a 500-row file issues a handful of reads, not
    // hundreds.
    const flagCandidates: Array<{
      customerId: string;
      invoiceNumber: string;
      productIds: string[];
    }> = [];
    // Invoice import auto-creates missing customers as a side effect; track that so
    // the CUSTOMERS grace window still opens if those rows push the tenant over cap.
    // No pre-check here — the soft cap blocks only a deliberate new-customer create,
    // never a finance import.
    let autoCreatedCustomers = false;
    const errors: string[] = [];

    // Group by Invoice ID
    const groups: Record<string, any[]> = {};
    const groupFirstRow = new Map<any[], number>();
    let rowIndex = 0;
    for (const row of rows) {
      rowIndex++;
      // F5 (REG-B268-E, cause-ruling.md §2 D2 follow-up): normalize with
      // `.trim()` AT GROUPING TIME, not just later at `importRef` (:663). A
      // whitespace-only "Invoice ID"/"Invoice Number" cell (a space, a tab, a
      // stray quoted blank) was truthy before the trim, so it grouped and
      // reached the fallback branch with an empty `importRef` — the exact
      // shape that skips the idempotency lookup entirely and mints a fresh
      // number on every re-upload of the same row (B268/D4). Reject it HERE
      // instead, as a reported error row, so it is never silently dropped
      // (the old `if (!id) continue`) nor silently duplicated.
      // Opus re-check fix: trim EACH source BEFORE the `||` fallback — trimming
      // only the joined result let a whitespace-only "Invoice ID" (truthy pre-trim)
      // win the `||` and shadow a perfectly valid "Invoice Number", turning a
      // healthy row into a spurious "missing invoice id" error. Only a row where
      // BOTH sources are blank after their own trim is actually missing.
      const id =
        (row["Invoice ID"] ?? "").toString().trim() ||
        (row["Invoice Number"] ?? "").toString().trim();
      if (!id) {
        skipped++;
        errors.push(`Row ${rowIndex}: missing invoice id`);
        continue;
      }
      if (!groups[id]) {
        groups[id] = [];
        groupFirstRow.set(groups[id], rowIndex);
      }
      groups[id].push(row);
    }

    const year = new Date().getFullYear();

    // B268/D4: every group carrying a source "Invoice Number" is processed BEFORE
    // any group without one (a stable partition — `filter` keeps file order inside
    // each half), so a fallback mint can never take a number that a later
    // source-numbered row in the SAME file will claim verbatim.
    const groupEntries = Object.entries(groups);
    const hasSourceNumber = (rows: any[]) => Boolean((rows[0]["Invoice Number"] || "").trim());
    const orderedGroups = [
      ...groupEntries.filter(([, rows]) => hasSourceNumber(rows)),
      ...groupEntries.filter(([, rows]) => !hasSourceNumber(rows)),
    ];

    // The walk-in customer's name is reserved: an invoice naming it is skipped, never attached to it.
    const walkInRow = await this.prisma
      .forTenant()
      .customer.findFirst({ where: { isWalkIn: true, deletedAt: null } });
    const walkInName = walkInRow?.isWalkIn === true ? walkInRow.businessName : null;

    for (const [, invoiceRows] of orderedGroups) {
      const first = invoiceRows[0];
      const customerName = (first["Customer Name"] || first["Company Name"] || "").trim();
      if (!customerName) {
        skipped++;
        continue;
      }
      if (walkInName && normalizeNameKey(customerName) === normalizeNameKey(walkInName)) {
        skipped++;
        errors.push(
          `Row ${groupFirstRow.get(invoiceRows)} skipped: this name is reserved for walk-in sales.`,
        );
        continue;
      }

      // #2190: a present-but-unparseable money cell skips the WHOLE invoice group before any write
      // (never a silent $0). Blank/absent cells keep today's defaults.
      const money = readInvoiceMoney(invoiceRows);
      if (!money.ok) {
        skipped++;
        errors.push(
          `${(first["Invoice Number"] || "").trim() || (first["Invoice ID"] || "").trim() || customerName}: ${money.reason}`,
        );
        continue;
      }

      // Try to find existing customer
      let customer = await this.prisma.forTenant().customer.findFirst({
        where: excludeWalkIn({
          businessName: { contains: customerName, mode: "insensitive" as const },
        }),
      });

      // Auto-create customer if not found
      if (!customer) {
        // B956: same rule as the contact importer: reject this invoice group, never half-write.
        const nameViolation = customerNameViolation({
          businessName: customerName,
          contactName: customerName,
        });
        if (nameViolation) {
          skipped++;
          errors.push(`${customerName}: ${nameViolation}`);
          continue;
        }
        // B964: the auto-created customer's billing address text, same rule, before any user or customer write
        const addressText = addressViolation({
          line1: (first["Billing Address"] || first["Billing Street"] || "").trim(),
          city: (first["Billing City"] || "").trim(),
          state: (first["Billing State"] || "").trim(),
          zip: (first["Billing Code"] || "").trim(),
        });
        if (addressText) {
          skipped++;
          errors.push(`${customerName}: ${addressText}`);
          continue;
        }
        const baseUsername = this.slugify(customerName);
        let username = baseUsername;
        let usernameSeq = 1;
        while (await this.prisma.forTenant().user.findFirst({ where: { username } })) {
          username = `${baseUsername}_${usernameSeq++}`;
        }
        const userEmail = `${username}@imported.local`;
        const existingUser = await this.prisma.forTenant().user.findFirst({
          where: { OR: [{ email: userEmail }, { username }] },
        });
        if (existingUser) {
          skipped++;
          errors.push(`${customerName}: user conflict, skipped`);
          continue;
        }
        try {
          const hashedPassword = await bcrypt.hash(this.generateTempPassword(), 10);
          const street = (first["Billing Address"] || first["Billing Street"] || "").trim();
          const city = (first["Billing City"] || "").trim();
          const state = (first["Billing State"] || "").trim();
          const zip = (first["Billing Code"] || "").trim();
          const phone = (first["Billing Phone"] || "").replace(/['+]/g, "").trim();

          await this.prisma.tenantTransaction(async (tx) => {
            const user = await tx.user.create({
              data: {
                email: userEmail,
                username,
                password: hashedPassword,
                role: UserRole.CUSTOMER,
                forcePasswordChange: true,
              },
            });
            customer = await tx.customer.create({
              data: {
                userId: user.id,
                businessName: customerName,
                contactName: customerName,
                phone: phone || null,
              },
            });
            if (street || city) {
              await tx.customerAddress.create({
                data: {
                  customerId: customer!.id,
                  label: "default",
                  line1: street || city || "Unknown",
                  city: city || "Unknown",
                  state: state || "Unknown",
                  ...addressStateFields(state, zip),
                  zip: zip || "00000",
                  isDefault: true,
                },
              });
            }
          });
          autoCreatedCustomers = true;
        } catch (e: any) {
          skipped++;
          this.pushRowError(errors, customerName, e);
          continue;
        }
      }

      if (!customer) {
        skipped++;
        continue;
      }

      const total = money.total;
      const subtotal = money.subtotal || total;
      const discount = money.discount;
      const shippingFee = money.shippingFee;
      // B268/D4: a row carrying a source number keeps it verbatim (the upsert-by-number
      // branch below repairs status drift on re-import). A row with NO source number is a
      // live mint, not a preserved import — reserved further down, inside the try, via
      // NumberingService so it never collides with a real tenant invoice.
      const numberFromSource = (first["Invoice Number"] || "").trim();
      // The CSV's own group key. For a source-numberless row this is the ONLY
      // durable identity the created invoice has (nothing else from the row is
      // persisted), so re-import idempotency keys on it (B268/D4).
      const importRef = (first["Invoice ID"] || "").trim();
      const notes = first["Notes"] || null;
      const terms = first["Terms & Conditions"] || null;

      let issueDate = new Date();
      let dueDate: Date | null = null;
      let paidDate: Date | null = null;
      try {
        if (first["Invoice Date"]) issueDate = new Date(first["Invoice Date"]);
      } catch (_e) {
        /* ignore */
      }
      // #2493: the literal calendar day the CSV names, never `new Date(raw)` (whose offset or
      // server zone can move the day); see importCalendarDay.
      if (first["Due Date"]) dueDate = importCalendarDay(first["Due Date"]);
      try {
        const pd = first["Payment Date"] || first["Last Payment Date"];
        if (pd) paidDate = new Date(pd);
      } catch (_e) {
        /* ignore */
      }

      // Determine status using Zoho's "Balance Due" field, which is more reliable
      // than the status label (Zoho may show "Overdue" for invoices paid in cash outside the system)
      const zohoStatus = this.mapInvoiceStatus(first["Invoice Status"]);
      const balanceDue = money.balanceDue;

      let status: InvoiceStatus;
      if (zohoStatus === InvoiceStatus.DRAFT) {
        status = InvoiceStatus.DRAFT;
      } else if (zohoStatus === InvoiceStatus.VOID) {
        status = InvoiceStatus.VOID;
      } else if (zohoStatus === InvoiceStatus.WRITTEN_OFF) {
        status = InvoiceStatus.WRITTEN_OFF;
      } else if (!isNaN(balanceDue) && total > 0 && balanceDue <= 0.01) {
        // Balance is effectively zero → fully paid, regardless of what Zoho shows
        status = InvoiceStatus.PAID;
      } else if (!isNaN(balanceDue) && total > 0 && balanceDue < total - 0.01) {
        // Partial payment recorded
        status = InvoiceStatus.PARTIAL;
      } else {
        // No balance info available — trust the Zoho status label
        status = zohoStatus;
      }

      const paidAt = status === InvoiceStatus.PAID ? paidDate || dueDate || issueDate : null;

      // Build line items; try to match product by SKU
      const itemsData: any[] = [];
      for (const row of invoiceRows) {
        const description = (row["Item Name"] || "").replace(/[\n\r]+/g, " ").trim() || "Item";
        const qty = parseImportNumber(row["Quantity"] || "1") || 1;
        if (qty <= 0) continue;
        const line = money.lines.get(row)!;
        const unitPrice = line.unitPrice;
        const itemDiscount = line.discount;
        // scan-ok: money-rederive — an imported CSV line has no case pack: the file's Item Total wins; the plain qty x price fallback is what the row states (unchanged by #2190).
        const sub = roundMoney(line.itemTotal || qty * unitPrice - itemDiscount);
        const sku = (row["SKU"] || "").trim();

        let productId: string | undefined;
        if (sku) {
          const product = await this.prisma.forTenant().product.findFirst({
            where: { sku: { equals: sku, mode: "insensitive" } },
          });
          if (product) productId = product.id;
        }
        if (!productId && sku) {
          const product = await this.prisma.forTenant().product.findFirst({
            where: { unitSku: { equals: sku, mode: "insensitive" } },
          });
          if (product) productId = product.id;
        }
        if (!productId && description && description !== "Item") {
          const product = await this.prisma.forTenant().product.findFirst({
            where: { name: { equals: description, mode: "insensitive" } },
          });
          if (product) productId = product.id;
        }

        itemsData.push({
          description,
          qty,
          unitPrice,
          discount: itemDiscount,
          taxRate: 0,
          subtotal: sub,
          ...(productId ? { productId } : {}),
          tenantId: this.prisma.getTenantId(), // nested creates bypass forTenant() extension
        });
      }

      if (itemsData.length === 0) {
        itemsData.push({
          description: "Services",
          qty: 1,
          unitPrice: total,
          discount: 0,
          taxRate: 0,
          subtotal: total,
          tenantId: this.prisma.getTenantId(), // nested creates bypass forTenant() extension
        });
      }

      let invoiceNumber = numberFromSource;
      // A fallback row has no number until `reserveNext` returns, so a failure
      // before that would otherwise be reported with an empty identifier.
      const rowLabel = numberFromSource
        ? numberFromSource
        : importRef
          ? `import-ref ${importRef}`
          : `${customerName} (no invoice number)`;
      // Opus re-check fix (REG-B268-F): hoisted above the try/else so the
      // external-ref record() call below (outside the `else` block's scope)
      // can see whether THIS row's prior lookup was a mismatch and choose the
      // composite key instead of repointing the plain one.
      let priorMismatch = false;
      try {
        if (numberFromSource) {
          // If the invoice already exists, only sync the Zoho-authoritative status
          // and dueDate. Totals/items/customer assignment are preserved so any
          // local edits aren't clobbered, but re-importing the same CSV will
          // repair any status drift (e.g. a Draft that got auto-flipped to
          // Overdue by an earlier buggy recalc). This upsert-by-number branch is
          // ONLY for rows carrying their ORIGINAL source number — never for a
          // synthesized fallback number (B268/D4).
          const existing = await this.prisma
            .forTenant()
            .invoice.findFirst({ where: { invoiceNumber } });
          if (existing) {
            // #2468 / SA-468: the sync runs under the invoice's row lock and re-reads it there — an
            // invoice the app VOIDed or WROTE OFF is never resurrected by the external file (a
            // row error, no write), even when the void lands while this import waits.
            const wrote = await this.prisma.tenantTransaction(async (tx) => {
              await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${existing.id} FOR UPDATE`;
              const locked = await tx.invoice.findFirst({ where: { id: existing.id } });
              const cur = locked ?? existing;
              const needsUpdate =
                cur.status !== status ||
                (cur.dueDate?.getTime() ?? 0) !== (dueDate?.getTime() ?? 0) ||
                (cur.paidAt?.getTime() ?? 0) !== (paidAt?.getTime() ?? 0);
              // #2478: nothing would change (e.g. an already-VOID invoice re-imported as void) ⇒ a
              // silent no-op skip, every run. Only a re-import that WOULD write is refused below.
              if (!needsUpdate) return false;
              const refused = locked ? importPaymentRefusal(locked.status) : null;
              if (refused) throw new ImportRowRefused(`${refused} — re-import skipped`);
              await tx.invoice.update({
                where: { id: existing.id },
                data: { status, dueDate, paidAt },
              });
              return true;
            });
            if (wrote) updated++;
            else skipped++;
            continue;
          }
        } else {
          // No source number: this row is a live mint, not a preserved import.
          // Re-import idempotency therefore keys on the CSV's own "Invoice ID"
          // rather than on a number (B268/D4) — the invoice this row would mint may
          // already have been created by an earlier run of the SAME file, and
          // reserving a fresh number unconditionally is what duplicates it (and its
          // synthetic payment). The ref is recorded on create below, so a hit here
          // is always THIS row's own prior invoice, never a number-keyed match
          // against an unrelated live one.
          //
          // Opus re-check fix (REG-B268-F): a customer/total MISMATCH (below)
          // records its new invoice under a composite key
          // `${importRef}|${customerId}|${total}` instead of the plain
          // `importRef` key, so it never repoints the plain key away from the
          // ORIGINAL invoice. Look up the composite key for THIS row's own
          // customer/total FIRST — that's the exact key a prior mismatched
          // re-import of this same file would have recorded under — and fall
          // back to the plain key only when no composite hit exists (the
          // normal, never-mismatched path).
          const compositeRef = importRef ? `${importRef}|${customer.id}|${total.toFixed(2)}` : null;
          const compositePriorId = compositeRef
            ? await this.externalRefs.findLocalId(
                ImportEntityType.INVOICE,
                IMPORT_INVOICE_REF_SOURCE,
                compositeRef,
              )
            : null;
          const priorId =
            compositePriorId ||
            (importRef
              ? await this.externalRefs.findLocalId(
                  ImportEntityType.INVOICE,
                  IMPORT_INVOICE_REF_SOURCE,
                  importRef,
                )
              : null);
          const prior = priorId
            ? await this.prisma.forTenant().invoice.findFirst({ where: { id: priorId } })
            : null;
          // F3 (REG-B268-D): the ("import", CSV "Invoice ID") key has no
          // file/job scope, so an unrelated document from a DIFFERENT file
          // whose "Invoice ID" cell happens to collide with a prior import
          // must never silently overwrite that prior invoice. Compare the
          // prior's customer AND total against THIS row before treating it as
          // a re-import; either differing means a NEW invoice, not an update.
          priorMismatch =
            !!prior &&
            (prior.customerId !== customer.id || Math.abs(Number(prior.total) - total) > 0.01);
          if (priorMismatch) {
            errors.push(
              `${rowLabel}: Invoice ID "${importRef}" is already used by a different invoice ` +
                `(customer or total mismatch) — imported as a new invoice instead of updating it`,
            );
          } else if (prior) {
            // Same status/dueDate/paidAt sync as the source-numbered branch above.
            // #2262 / SA-404b: the status write and its synthetic payment are ONE tx that updates the
            // Invoice row (the void invariant; invoice + payment atomic). #2468 / SA-468: that tx locks
            // the row first and re-reads it — a VOID / WRITTEN_OFF prior is skipped with a row error,
            // never resurrected to PAID/PARTIAL with a synthetic payment.
            const wrote = await this.prisma.tenantTransaction(async (tx) => {
              await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${prior.id} FOR UPDATE`;
              const locked = await tx.invoice.findFirst({ where: { id: prior.id } });
              const cur = locked ?? prior;
              const needsUpdate =
                cur.status !== status ||
                (cur.dueDate?.getTime() ?? 0) !== (dueDate?.getTime() ?? 0) ||
                (cur.paidAt?.getTime() ?? 0) !== (paidAt?.getTime() ?? 0);
              // #2478: nothing would change (e.g. an already-VOID invoice re-imported as void) ⇒ a
              // silent no-op skip, every run. Only a re-import that WOULD write is refused below.
              if (!needsUpdate) return false;
              const refused = locked ? importPaymentRefusal(locked.status) : null;
              if (refused) throw new ImportRowRefused(`${refused} — re-import skipped`);
              await tx.invoice.update({
                where: { id: prior.id },
                data: { status, dueDate, paidAt },
              });
              // F2 (REG-B268-C): a re-import that flips the prior invoice to
              // PAID/PARTIAL must get the SAME synthetic-payment treatment a
              // brand-new PAID/PARTIAL invoice gets on create (:897-915) —
              // otherwise the invoice is PAID with zero InvoicePayment rows,
              // which reconciliation/balance-due math reads as unpaid. Guarded
              // on "no payment already exists" so a SECOND re-import of an
              // already-synthesized-payment row doesn't duplicate it.
              if (status === InvoiceStatus.PAID || status === InvoiceStatus.PARTIAL) {
                const existingPayment = await tx.invoicePayment.findFirst({
                  where: { invoiceId: prior.id },
                });
                if (!existingPayment) {
                  // B779: total/balanceDue are individually rounded (parseImportMoney), but
                  // their subtraction can still land off-cent in float (24.30 - 10.10 =
                  // 14.200000000000001) — round every monetary write.
                  const paidAmount = !isNaN(balanceDue)
                    ? roundMoney(total - balanceDue)
                    : status === InvoiceStatus.PAID
                      ? total
                      : 0;
                  if (paidAmount > 0.01) {
                    await tx.invoicePayment.create({
                      data: {
                        invoiceId: prior.id,
                        amount: paidAmount,
                        method: "OTHER",
                        reference: "zoho-import",
                        notes: "Imported from Zoho",
                        createdAt: paidAt || issueDate,
                      },
                    });
                  }
                }
              }
              return true;
            });
            if (wrote) updated++;
            else skipped++;
            continue;
          }
          // Reserve a fresh number through NumberingService (standalone — no
          // transaction is open here) instead of a local `seq` counter, so it can
          // never collide with (and silently overwrite) a real tenant invoice. A
          // collision here is a genuine error, not an update — it falls through
          // to the catch below and is reported as a row error.
          invoiceNumber = await this.numbering.reserveNext("INVOICE", { year });
        }

        // #2262 / SA-404b: the invoice and its synthetic payment are ONE tx — a partial import can
        // never leave a payment without its invoice (or an invoice without the payment its status
        // implies). The number was reserved above, outside (NumberingService is standalone).
        const customerId = customer.id; // narrowed here; the tx callback below cannot see that
        const newInvoice = await this.prisma.tenantTransaction(async (tx) => {
          const created = await tx.invoice.create({
            data: {
              invoiceNumber,
              customerId,
              status,
              subtotal,
              taxAmount: 0,
              discount,
              shippingFee,
              total,
              issueDate,
              dueDate,
              paidAt,
              notes,
              terms,
              items: { create: itemsData },
            },
          });
          // For PAID/PARTIAL invoices, create a synthetic payment record so
          // balance-due calculations are correct without a separate payments import
          if (status === InvoiceStatus.PAID || status === InvoiceStatus.PARTIAL) {
            // B779: round every monetary write — see the sibling branch's comment above.
            const paidAmount = !isNaN(balanceDue)
              ? roundMoney(total - balanceDue)
              : status === InvoiceStatus.PAID
                ? total
                : 0;
            if (paidAmount > 0.01) {
              await tx.invoicePayment.create({
                data: {
                  invoiceId: created.id,
                  amount: paidAmount,
                  method: "OTHER",
                  reference: "zoho-import",
                  notes: "Imported from Zoho",
                  createdAt: paidAt || issueDate,
                },
              });
            }
          }
          return created;
        });

        // Durable identity for a source-numberless row (B268/D4) — recorded right after the
        // invoice + payment tx commits (no write follows it), so a re-upload of the same file
        // finds THIS invoice instead of minting a second one.
        //
        // Opus re-check fix (REG-B268-F): a customer/total MISMATCH must NOT
        // repoint the plain `importRef` key — that key belongs to the ORIGINAL
        // invoice forever. Record this new, different invoice under the
        // customer+total-scoped composite key instead, so re-importing the
        // mismatched file again finds THIS invoice (via the composite lookup
        // above) while re-importing the original file again still finds the
        // original via the plain key — alternating files are both idempotent.
        if (!numberFromSource && importRef) {
          const refToRecord = priorMismatch
            ? `${importRef}|${customer.id}|${total.toFixed(2)}`
            : importRef;
          await this.externalRefs.record(
            ImportEntityType.INVOICE,
            newInvoice.id,
            IMPORT_INVOICE_REF_SOURCE,
            refToRecord,
          );
        }

        // F-05 (#2093): collected, not checked here — see the batched check after the loop.
        const importedProductIds = itemsData
          .map((it: any) => it.productId)
          .filter((id: any): id is string => !!id);
        if (importedProductIds.length > 0) {
          flagCandidates.push({
            customerId,
            invoiceNumber: newInvoice.invoiceNumber,
            productIds: importedProductIds,
          });
        }

        imported++;
      } catch (e: any) {
        // #2468: a deliberate refusal is reported by its reason, not the generic "import failed".
        if (e instanceof ImportRowRefused)
          errors.push(`${invoiceNumber || rowLabel}: ${e.message}`);
        else this.pushRowError(errors, invoiceNumber || rowLabel, e);
        skipped++;
      }
    }
    // Never throws — opens a grace window only if the auto-created customers took
    // the tenant over cap, so the next deliberate create is gated as it should be.
    if (autoCreatedCustomers) await this.customersService.maybeStartCustomerGrace();

    // F-05 (#2093): IMPORT IS EXEMPT — every row above already imported unchanged. ONE
    // checkLinesSellable call per customer (never per row), then ONE audit row for the
    // whole run — written here, outside every per-invoice transaction above, and never
    // throwing or retroactively touching a row that already committed.
    const tenantId = this.prisma.getTenantId() ?? "";
    const restrictedLines: Array<{
      invoiceNumber: string;
      productId: string;
      productName: string;
      message: string;
    }> = [];
    const byCustomer = new Map<string, typeof flagCandidates>();
    for (const c of flagCandidates)
      byCustomer.set(c.customerId, [...(byCustomer.get(c.customerId) ?? []), c]);
    for (const [customerId, entries] of byCustomer) {
      const flagged = await flagRestrictedLines(
        { restrictions: this.sellingRestrictions, warn: (m) => this.logger.warn(m) },
        {
          tenantId,
          customerId,
          productIds: entries.flatMap((e) => e.productIds),
          fulfilmentKind: await defaultSaleFulfilmentKind(this.prisma, tenantId, customerId), // no order: how the next order would go
        },
      );
      const byProduct = new Map(flagged.map((f) => [f.productId, f]));
      for (const e of entries)
        for (const pid of e.productIds) {
          const f = byProduct.get(pid);
          if (f)
            restrictedLines.push({
              invoiceNumber: e.invoiceNumber,
              productId: pid,
              productName: f.productName,
              message: f.message,
            });
        }
    }
    if (restrictedLines.length > 0) {
      await writeRestrictedLinesAudit(
        { prisma: this.prisma, warn: (m) => this.logger.warn(m) },
        {
          tenantId,
          action: "invoice.import.restricted_lines",
          entityType: "invoices",
          entityId: "import",
          meta: {
            invoiceNumbers: [...new Set(restrictedLines.map((r) => r.invoiceNumber))],
            productIds: [...new Set(restrictedLines.map((r) => r.productId))],
          },
        },
      );
    }

    return { imported, updated, skipped, errors, restrictedLines };
  }

  async importPayments(
    buffer: Buffer,
    userId: string,
  ): Promise<{ imported: number; skipped: number; duplicates: number; errors: string[] }> {
    const rows = this.parseCsv(buffer);
    let imported = 0,
      skipped = 0,
      duplicates = 0;
    const errors: string[] = [];

    // Snapshot of payments that existed BEFORE this run's inserts, per invoice —
    // dedupe compares against history only, so identical legit rows within one
    // file still both import while a re-upload of the same file creates nothing.
    const preRunPayments = new Map<string, { amount: number; method: string; createdAt: Date }[]>();

    for (const row of rows) {
      const invoiceNumber = row["Invoice Number"];
      if (!invoiceNumber) {
        skipped++;
        continue;
      }

      const invoice = await this.prisma.forTenant().invoice.findFirst({ where: { invoiceNumber } });
      if (!invoice) {
        skipped++;
        continue;
      }

      if (!preRunPayments.has(invoice.id)) {
        const existing = await this.prisma
          .forTenant()
          .invoicePayment.findMany({ where: { invoiceId: invoice.id } });
        preRunPayments.set(
          invoice.id,
          existing
            // Not every existing row is history a new payment can duplicate:
            // the synthetic "zoho-import" placeholder importInvoices writes for
            // PAID/PARTIAL invoices is meant to be REPLACED by the real payment
            // (it is deleted just below every create), so counting it would make
            // the FIRST payments import after an invoices import "dedupe" the
            // real row away — dropping its method/reference/notes and leaving the
            // placeholder standing. VOID rows (e.g. a bounced check) are likewise
            // not something a legitimately re-recorded payment collides with.
            // scan-ok: draft-payment-not-void — a dedup candidate list (does this
            // new row collide with an existing one), never summed into a paid/
            // status figure.
            .filter((p) => p.reference !== "zoho-import" && p.status !== "VOID")
            .map((p) => ({
              amount: Number(p.amount),
              method: p.method,
              createdAt: p.createdAt,
            })),
        );
      }

      const amount = parseImportMoney(row["Amount Applied to Invoice"] || row["Amount"] || "0");
      if (amount <= 0) {
        skipped++;
        continue;
      }

      const method = this.mapPaymentMethod(row["Mode"]) as any;
      const reference = row["Reference Number"] || null;
      let createdAt = new Date();
      try {
        if (row["Date"]) createdAt = new Date(row["Date"]);
      } catch (_e) {
        /* ignore */
      }

      // Zoho's InvoicePayment ID used as zohoId for deduplication
      const zohoPaymentId = (row["InvoicePayment ID"] || "").trim();

      try {
        // Skip if already imported (check by zohoId reference, or amount+date combo)
        if (zohoPaymentId) {
          const dup = await this.prisma.forTenant().invoicePayment.findFirst({
            where: { invoiceId: invoice.id, reference: zohoPaymentId },
          });
          if (dup) {
            skipped++;
            continue;
          }
        } else {
          // Fallback dedupe: no external reference to key off, so compare
          // against payments that existed before this run — cent-equal
          // amount, same method, created within ±1 day. Catches a re-upload
          // of the same payments file without double-counting two identical
          // legit rows from ONE file (those are compared against the same
          // pre-run snapshot, not against each other).
          //
          // CONSUME ON MATCH: each snapshot entry may dedupe AT MOST ONE
          // incoming row, so the matched entry is spliced out. Without that,
          // ONE history row absorbs MANY incoming rows — a file holding two
          // identical legitimate payments (e.g. two $500 CASH rows the same
          // day) where only the first persisted would, on the operator's
          // documented re-upload, report both as duplicates and lose the
          // second real payment. The array held in `preRunPayments` is this
          // run's own private copy of history, so mutating it is safe and is
          // exactly how the at-most-once rule is enforced.
          const snapshot = preRunPayments.get(invoice.id) || [];
          const duplicateIndex = snapshot.findIndex(
            (p) =>
              Math.abs(p.amount - amount) < 0.005 &&
              p.method === method &&
              Math.abs(p.createdAt.getTime() - createdAt.getTime()) <= 86_400_000,
          );
          if (duplicateIndex !== -1) {
            snapshot.splice(duplicateIndex, 1);
            duplicates++;
            continue;
          }
        }

        // Also remove any synthetic "zoho-import" placeholder payment for this invoice
        // now that we have the real payment record
        // #2262 / SA-404b: the payment and its invoice's status are ONE tx that locks and UPDATES
        // the Invoice row (touched even when the status stays), so a concurrent void serializes
        // against it and a failure leaves neither half.
        await this.prisma.tenantTransaction(async (tx) => {
          await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${invoice.id} FOR UPDATE`;
          // SA-424 N1: refuse a VOID / WRITTEN_OFF invoice on the LOCKED row, before any write —
          // no payment, and the zoho-import placeholder is kept.
          const current = await tx.invoice.findFirst({
            where: { id: invoice.id },
            select: { status: true },
          });
          const refused = current ? importPaymentRefusal(current.status) : null;
          if (refused) throw new ImportRowRefused(refused);
          await tx.invoicePayment.deleteMany({
            where: { invoiceId: invoice.id, reference: "zoho-import" },
          });
          await tx.invoicePayment.create({
            data: {
              invoiceId: invoice.id,
              amount,
              method,
              reference: zohoPaymentId || reference || null,
              notes: reference && reference !== zohoPaymentId ? reference : null,
              createdAt,
            },
          });
          const locked = await tx.invoice.findFirst({
            where: { id: invoice.id },
            include: { payments: true },
          });
          const change = locked
            ? importPaymentStatus(locked, locked.payments ?? [], new Date())
            : null;
          await tx.invoice.update({
            where: { id: invoice.id },
            data: change ?? { status: locked?.status ?? invoice.status },
          });
        });
        imported++;
      } catch (e: any) {
        if (e instanceof ImportRowRefused)
          errors.push(`Payment for ${invoiceNumber}: ${e.message}`);
        else this.pushRowError(errors, `Payment for ${invoiceNumber}`, e);
        skipped++;
      }
    }

    // Sweep every invoice's status from its payments (wrapped in a single transaction) with the
    // same rule the per-row tx applied — see import-payment-status.ts for the rule and its reasons.
    const allInvoices = await this.prisma
      .forTenant()
      .invoice.findMany({ include: { payments: true } });
    const now = new Date();
    const statusUpdates: Array<{
      id: string;
      from: InvoiceStatus;
      status: InvoiceStatus;
      paidAt: Date | null;
    }> = [];
    for (const inv of allInvoices) {
      const change = importPaymentStatus(inv, inv.payments, now); // #2262: the one shared rule
      if (change) statusUpdates.push({ id: inv.id, from: inv.status, ...change });
    }
    if (statusUpdates.length > 0) {
      // SA-424 N2: compare-and-set on the status this sweep READ — an invoice voided (or paid)
      // since the read is left alone (count 0 ⇒ skipped), never written over by a stale verdict.
      await this.prisma.$transaction(
        statusUpdates.map((u) =>
          this.prisma.forTenant().invoice.updateMany({
            where: { id: u.id, status: u.from },
            data: { status: u.status, paidAt: u.paidAt },
          }),
        ),
      );
    }

    return { imported, skipped, duplicates, errors };
  }

  async importExpenses(
    buffer: Buffer,
    userId: string,
  ): Promise<{
    imported: number;
    skipped: number;
    errors: string[];
    suppliersCreated: number;
    suppliersUpdated: number;
    importBatchId: string;
  }> {
    const rows = this.parseCsv(buffer);
    let imported = 0,
      skipped = 0,
      suppliersCreated = 0,
      suppliersUpdated = 0;
    const errors: string[] = [];

    // Generate a unique batch ID for this import run so it can be rolled back later
    const importBatchId = crypto.randomUUID();

    // ── Step 1: Ensure expense categories exist ──────────────────────────────
    const catMap: Record<string, string> = {};
    // Also record which category IDs are INVENTORY_PURCHASE for vendor bill creation later
    const inventoryCatIds = new Set<string>();

    const catNames = [
      ...new Set(rows.map((r: any) => r["Expense Category"]).filter(Boolean)),
    ] as string[];
    for (const catName of catNames) {
      const nameLower = catName.toLowerCase();
      const isInventoryPurchase = INVENTORY_PURCHASE_KEYWORDS.some((kw) => nameLower.includes(kw));

      if (isInventoryPurchase) {
        // Always map to the canonical INVENTORY_PURCHASE system category
        let cat = await this.prisma
          .forTenant()
          .expenseCategory.findFirst({ where: { code: "INVENTORY_PURCHASE" } });
        if (!cat) {
          cat = await this.prisma.forTenant().expenseCategory.create({
            data: { name: "Inventory Purchase", code: "INVENTORY_PURCHASE", isCustom: false },
          });
        }
        catMap[catName] = cat.id;
        inventoryCatIds.add(cat.id);
        continue;
      }

      const code = catName
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "_")
        .slice(0, 20);
      let cat = await this.prisma
        .forTenant()
        .expenseCategory.findFirst({ where: { name: catName } });
      if (!cat) {
        try {
          cat = await this.prisma.forTenant().expenseCategory.create({
            data: { name: catName, code, isCustom: true },
          });
        } catch {
          try {
            cat = await this.prisma.forTenant().expenseCategory.create({
              data: { name: catName, code: code + "_Z", isCustom: true },
            });
          } catch (_e) {
            /* ignore */
          }
        }
      }
      if (cat) catMap[catName] = cat.id;
    }

    // ── Step 2: Auto-upsert suppliers from vendor column ─────────────────────
    // Zoho Expense uses "Merchant Name"; Zoho Books uses "Customer Name" or
    // "Vendor Name". getVendorName() checks all variants in priority order.
    const vendorMap: Record<string, string> = {}; // vendorName (lowercase) → supplierId

    // Group rows by vendor name to extract detail columns
    const vendorRowsMap: Record<string, any> = {};
    for (const row of rows) {
      const n = this.getVendorName(row);
      if (n && !vendorRowsMap[n.toLowerCase()]) {
        vendorRowsMap[n.toLowerCase()] = row; // keep first row per vendor
      }
    }

    const vendorNames = Object.keys(vendorRowsMap).map((k) => this.getVendorName(vendorRowsMap[k]));

    for (const name of vendorNames) {
      try {
        const sampleRow = vendorRowsMap[name.toLowerCase()];
        // Build full supplier profile: CSV columns + customer contact match
        const supplierData = await this.buildSupplierData(name, sampleRow);

        const existing = await this.prisma.forTenant().supplier.findFirst({
          where: { name: { equals: name, mode: "insensitive" } },
        });
        if (existing) {
          // Update — remove the 'name' key (not needed in update) and apply the rest
          const { name: _n, ...updateData } = supplierData;
          if (Object.keys(updateData).length > 0) {
            await this.prisma
              .forTenant()
              .supplier.update({ where: { id: existing.id }, data: updateData });
          }
          vendorMap[name.toLowerCase()] = existing.id;
          suppliersUpdated++;
        } else {
          const created = await this.prisma
            .forTenant()
            .supplier.create({ data: supplierData as any });
          vendorMap[name.toLowerCase()] = created.id;
          suppliersCreated++;
        }
      } catch (e: any) {
        this.pushRowError(errors, `Supplier "${name}"`, e);
      }
    }

    // ── Step 3: Ensure "Other" fallback category exists ─────────────────────
    // Used for rows that have no Expense Category or whose category could not
    // be created (e.g. due to a code-uniqueness clash).
    let otherCategoryId: string | null = null;
    {
      let otherCat = await this.prisma
        .forTenant()
        .expenseCategory.findFirst({ where: { code: "OTHER" } });
      if (!otherCat) {
        otherCat = await this.prisma.forTenant().expenseCategory.create({
          data: { name: "Other", code: "OTHER", isCustom: false },
        });
      }
      otherCategoryId = otherCat.id;
    }

    // ── Step 4: Import expense rows ──────────────────────────────────────────
    for (const row of rows) {
      const catName = row["Expense Category"];
      // Resolve category — fall back to "Other" instead of silently dropping the row
      const categoryId = (catName && catMap[catName]) || otherCategoryId;
      if (!categoryId) {
        skipped++;
        continue;
      }

      const amount = parseImportMoney(row["Total"] || row["Expense Amount"] || "0");
      if (amount <= 0) {
        skipped++;
        continue;
      }

      let date = new Date();
      try {
        if (row["Expense Date"]) date = new Date(row["Expense Date"]);
      } catch (_e) {
        /* ignore */
      }

      const referenceNumber = (row["Reference#"] || row["Reference Number"] || "").trim() || null;
      const description = row["Expense Description"] || referenceNumber || null;
      const notes = row["Notes"] || null;

      // Resolve supplier from the vendor name column (Merchant Name / Vendor Name / Customer Name …)
      const vendorName = this.getVendorName(row);
      const supplierId = vendorName ? (vendorMap[vendorName.toLowerCase()] ?? null) : null;

      // ── Deduplication: skip if an identical expense already exists ──────────
      // Match on same calendar day + amount + category + supplier to avoid
      // double-importing if the same CSV is uploaded more than once.
      const dayStart = new Date(date);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(date);
      dayEnd.setHours(23, 59, 59, 999);
      const duplicate = await this.prisma.forTenant().expense.findFirst({
        where: {
          deletedAt: null,
          date: { gte: dayStart, lte: dayEnd },
          amount,
          categoryId,
          ...(supplierId ? { supplierId } : { supplierId: null }),
        },
        select: { id: true },
      });
      if (duplicate) {
        skipped++;
        continue;
      }

      try {
        const expense = await this.prisma.forTenant().expense.create({
          data: {
            categoryId,
            importBatchId,
            amount,
            date,
            description,
            paymentMethod: "CASH",
            notes,
            referenceNumber,
            performedById: userId,
            ...(supplierId ? { supplierId } : {}),
          },
        });

        // If this is an inventory purchase, create a vendor bill so it appears
        // in the Inventory Purchases tab rather than the Other Expenses tab.
        if (inventoryCatIds.has(categoryId)) {
          try {
            const bill = await this.vendorBillsService.create({
              requireSupplier: false,
              supplierId: supplierId ?? undefined,
              totalOwed: amount,
              billDate: date.toISOString(),
              notes: description ?? undefined,
              items: [],
            });
            await this.prisma.forTenant().expense.update({
              where: { id: expense.id },
              data: { vendorBillId: bill.id },
            });
          } catch (billErr: any) {
            this.logger.warn(
              `Could not create vendor bill for imported expense ${expense.id}: ${billErr.message}`,
            );
          }
        }

        imported++;
      } catch (e: any) {
        this.pushRowError(errors, "Row", e);
        skipped++;
      }
    }
    return { imported, skipped, errors, suppliersCreated, suppliersUpdated, importBatchId };
  }

  // ── Import batch rollback ──────────────────────────────────────────────────

  /**
   * Soft-deletes all expenses that belong to a given import batch.
   * Safe to call multiple times — already-deleted records are ignored.
   */
  async rollbackExpenseBatch(batchId: string): Promise<{ rolledBack: number }> {
    const result = await this.prisma.forTenant().expense.updateMany({
      where: { importBatchId: batchId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return { rolledBack: result.count };
  }

  /**
   * Lists the 20 most recent expense import batches for the current tenant,
   * ordered newest first. Only counts expenses that have not been rolled back.
   */
  async listExpenseBatches() {
    const rows = await this.prisma.forTenant().expense.groupBy({
      by: ["importBatchId"],
      where: { importBatchId: { not: null }, deletedAt: null },
      _count: { id: true },
      _sum: { amount: true },
      _min: { date: true, createdAt: true },
      _max: { date: true },
      orderBy: { _min: { createdAt: "desc" } },
      take: 20,
    });
    return rows.map((r) => ({
      batchId: r.importBatchId,
      expenseCount: r._count.id,
      totalAmount: Number(r._sum.amount ?? 0),
      earliestExpenseDate: r._min.date,
      latestExpenseDate: r._max.date,
      importedAt: r._min.createdAt,
    }));
  }

  // ── Inventory purchase repair ─────────────────────────────────────────────

  /**
   * Retroactively create vendor bills for any INVENTORY_PURCHASE expenses that
   * were imported before this logic existed (i.e. vendorBillId is null).
   * Safe to call multiple times — already-converted expenses are skipped.
   */
  async repairInventoryPurchaseExpenses(): Promise<{ converted: number; skipped: number }> {
    const invCat = await this.prisma
      .forTenant()
      .expenseCategory.findFirst({ where: { code: "INVENTORY_PURCHASE" } });
    if (!invCat) return { converted: 0, skipped: 0 };

    const unconverted = await this.prisma.forTenant().expense.findMany({
      where: { categoryId: invCat.id, vendorBillId: null, deletedAt: null },
    });

    let converted = 0;
    let skipped = 0;
    for (const expense of unconverted) {
      try {
        const bill = await this.vendorBillsService.create({
          requireSupplier: false,
          supplierId: (expense as any).supplierId ?? undefined,
          totalOwed: Number(expense.amount),
          billDate: expense.date?.toISOString(),
          notes: expense.description ?? undefined,
          items: [],
        });
        await this.prisma.forTenant().expense.update({
          where: { id: expense.id },
          data: { vendorBillId: bill.id },
        });
        converted++;
      } catch (e: any) {
        this.logger.warn(`repairInventoryPurchaseExpenses: skipped ${expense.id}: ${e.message}`);
        skipped++;
      }
    }
    return { converted, skipped };
  }

  // ── Orphaned customer repair ────────────────────────────────────────────────

  /**
   * Diagnose: find customers that have a zohoContactId but belong to a
   * different (or null) tenant than the one currently making the request.
   * Returns their count so the caller can decide whether to adopt them.
   */
  async diagnoseOrphanedContacts(tenantId: string) {
    // An "orphan" is a contact with NO tenant (tenantId === null) — e.g. imported
    // by a super-admin without active impersonation. We must NEVER surface another
    // active tenant's records here (that was a cross-tenant disclosure), so we match
    // tenantId: null only, never `NOT: { tenantId }`. The current tenantId is the
    // destination the caller would adopt into, not a filter exclusion.
    const orphans = await this.prisma.customer.findMany({
      where: {
        zohoContactId: { not: null },
        tenantId: null,
      },
      select: { id: true, businessName: true, tenantId: true },
      take: 100,
    });
    return {
      orphanCount: orphans.length,
      tenantId,
      sample: orphans.slice(0, 5),
    };
  }

  /**
   * Repair: reassign all customers (and their User accounts) that have a
   * zohoContactId but belong to a null/wrong tenant, adopting them into
   * the current tenant.
   *
   * This is the fix for the case where contacts were imported under the wrong
   * tenant context (e.g. by a super-admin without active impersonation).
   */
  async adoptOrphanedContacts(tenantId: string): Promise<{ adopted: number }> {
    // SECURITY (F1-001): an "orphan" is strictly a contact with NO tenant
    // (tenantId === null). We must NEVER match `NOT: { tenantId }`, which would
    // pull in OTHER active tenants' customers/users and reassign them to the
    // caller — a cross-tenant data takeover. Match tenantId: null only, and
    // repeat the null guard on every write so a record owned by another tenant
    // can never be reassigned even if an id is supplied/raced.
    const orphans = await this.prisma.customer.findMany({
      where: {
        zohoContactId: { not: null },
        tenantId: null,
      },
      select: { id: true, userId: true },
    });

    if (orphans.length === 0) return { adopted: 0 };

    const customerIds = orphans.map((o) => o.id);
    const userIds = orphans.map((o) => o.userId).filter((id): id is string => !!id);

    // Reassign only genuinely orphaned (null-tenant) Customer records.
    await this.prisma.customer.updateMany({
      where: { id: { in: customerIds }, tenantId: null },
      data: { tenantId },
    });

    // Reassign only the associated User records that are themselves orphaned —
    // never move a User that already belongs to another tenant.
    if (userIds.length > 0) {
      await this.prisma.user.updateMany({
        where: { id: { in: userIds }, tenantId: null },
        data: { tenantId },
      });
    }

    // Reassign only orphaned CustomerAddress records.
    await this.prisma.customerAddress.updateMany({
      where: { customerId: { in: customerIds }, tenantId: null },
      data: { tenantId },
    });

    return { adopted: orphans.length };
  }

  /**
   * Identify customers that have no orders and whose name matches a supplier
   * record — these are vendor/expense contacts that were accidentally imported
   * as customers. Mark them supplierOnly=true to hide from the Customers list.
   * Safe to call multiple times; already-marked records are skipped.
   */
  async markSupplierOnlyCustomers(): Promise<{ marked: number; alreadyMarked: number }> {
    // Find all suppliers for name-matching
    const suppliers = await this.prisma.forTenant().supplier.findMany({
      select: { id: true, name: true },
    });
    const supplierNames = new Set(suppliers.map((s) => s.name.toLowerCase().trim()));

    // Candidates: customers with no orders AND whose businessName matches a supplier
    const candidates = await this.prisma.forTenant().customer.findMany({
      where: { supplierOnly: false },
      select: {
        id: true,
        businessName: true,
        _count: { select: { orders: true } },
      },
    });

    const toMark = candidates.filter((c) => {
      if ((c._count as any).orders > 0) return false; // has orders → real customer
      const name = (c.businessName ?? "").toLowerCase().trim();
      return supplierNames.has(name);
    });

    if (toMark.length === 0) return { marked: 0, alreadyMarked: 0 };

    const ids = toMark.map((c) => c.id);
    await this.prisma.forTenant().customer.updateMany({
      where: { id: { in: ids } },
      data: { supplierOnly: true },
    });

    return { marked: toMark.length, alreadyMarked: 0 };
  }

  /**
   * B858/B859 FIX4 — plan-then-apply product import (cause-ruling.md §2.B, SA-284).
   *
   * Every write goes through `ProductsService.create`/`update` (SA-284 a — no raw
   * `prisma.product.create`), so the addon/plan-flag guards, sku/barcode/unitSku collision
   * checks, and `emitProductChanged` always run. A gated column present in the header (Tobacco /
   * MSRP) refuses the WHOLE file before any write, identically in `dryRun` and real (SA-284 b). A
   * bad cell skips only that ROW with a reason; blank never clears an existing value.
   */
  async importProducts(
    buffer: Buffer,
    userId: string,
    opts?: { dryRun?: boolean; fileName?: string },
  ): Promise<{
    imported: number;
    created: number;
    updated: number;
    unchanged: number;
    skipped: number;
    errors: string[];
    rows: ImportRowPlan[];
    skippedRows: { row: number; label: string; reason: string }[];
    warnings: string[];
    unknownColumns: string[];
    dryRun: boolean;
    /** SA-823: the family header block, present only when the file has a Family column. */
    families?: ImportFamilySummary;
  }> {
    const dryRun = !!opts?.dryRun;
    const rawRows = this.parseCsv(buffer);
    const headers = rawRows.length > 0 ? Object.keys(rawRows[0]) : [];
    const resolved = resolveColumns(headers, PRODUCT_COLUMNS);

    // ── File-level entitlement gate — BEFORE any write-capable query, identical wording and
    // behavior in dryRun and real (SA-284 b) ──────────────────────────────────────────────────
    if (resolved.byField.msrp) {
      try {
        await this.productsService.assertMsrpAllowed();
      } catch (e) {
        if (!isEntitlementDenial(e)) throw e;
        throw columnEntitlementDenied(
          "MSRP",
          resolved.byField.msrp,
          `Column "${resolved.byField.msrp}" needs the MSRP plan flag; remove the column or enable it`,
        );
      }
    }
    if (resolved.byField.isTobacco) {
      try {
        await this.productsService.assertCanFlagTobacco(true);
      } catch (e) {
        if (!isEntitlementDenial(e)) throw e;
        throw columnEntitlementDenied(
          "TOBACCO_DEALER",
          resolved.byField.isTobacco,
          `Column "${resolved.byField.isTobacco}" needs tobacco_dealer add-on; remove the column or enable it`,
        );
      }
    }
    const reorderColumn = resolved.byField.reorderPoint ?? resolved.byField.reorderQty;
    if (reorderColumn) {
      try {
        await this.productsService.assertReorderAllowed();
      } catch (e) {
        if (!isEntitlementDenial(e)) throw e;
        throw columnEntitlementDenied(
          "FORECASTING",
          reorderColumn,
          `Column "${reorderColumn}" needs the forecasting plan flag; remove the column or enable it`,
        );
      }
    }

    // SA-823: a Family column is refused for the WHOLE file (too many rows, or family pricing on) before any lookup.
    const hasFamilyColumn = !!resolved.byField.family;
    if (hasFamilyColumn) {
      if (!this.familyImport) throw new Error("ProductFamilyImportService is not available");
      await this.familyImport.assertAllowed(rawRows.length);
    }

    let created = 0,
      updated = 0,
      unchanged = 0,
      skipped = 0;
    const errors: string[] = [];
    const rowPlans: ImportRowPlan[] = [];
    const skippedRows: { row: number; label: string; reason: string }[] = [];
    const warnings: string[] = [];

    // Parse every row up front so an in-file name-ambiguity pre-scan can run before matching.
    const parsedRows = rawRows.map((raw) => parseRow(raw, resolved, PRODUCT_COLUMNS));
    // SA-823: the id / Family / Variant name cells steer matching and grouping; they are never product fields to diff.
    const famCells = parsedRows.map((p) => {
      const cells = {
        id: p.values.id as string | undefined,
        family: p.values.family as string | undefined,
        variantName: p.values.variantName as string | undefined,
      };
      delete p.values.id;
      delete p.values.family;
      delete p.values.variantName;
      return cells;
    });
    const familyRowNumbers = new Set<number>();
    let famPlan: FamilyPlan | null = null;
    if (hasFamilyColumn) {
      const inputs: FamilyRowInput[] = [];
      parsedRows.forEach((p, i) => {
        if (p.badCells.length > 0 || !famCells[i].family) return;
        familyRowNumbers.add(i + 1);
        inputs.push({
          index: i,
          rowNumber: i + 1,
          family: famCells[i].family as string,
          variantCell: famCells[i].variantName,
          nameCell: (p.values.name as string | undefined)?.trim() || undefined,
          id: famCells[i].id,
          sku: (p.values.sku as string | undefined)?.trim() || undefined,
          barcode: (p.values.barcode as string | undefined)?.trim() || undefined,
          values: p.values,
        });
      });
      famPlan = await this.familyImport!.planRows(inputs);
    }
    const nameCounts = new Map<string, number>();
    for (const [idx, p] of parsedRows.entries()) {
      if (p.badCells.length > 0) continue;
      const sku = (p.values.sku as string | undefined)?.trim();
      const barcode = (p.values.barcode as string | undefined)?.trim();
      if (sku || barcode || famCells[idx].id) continue;
      const name = (p.values.name as string | undefined)?.trim();
      if (!name) continue;
      const key = normalizeNameKey(name);
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    }

    // In-file claims (I1), so dryRun — which writes nothing — plans exactly what a real run does:
    //   claimedKeys:       every SKU/barcode a row carries (a later row repeating one = duplicate)
    //   claimedNames:      the name each create/update row leaves the product with; consulted
    //                      BEFORE the DB name lookup, which in a real run would already see the
    //                      product an earlier row created or renamed
    //   claimedProductIds: the existing product a row matched (a second row reaching it by another
    //                      key is a duplicate, never a second independent update)
    // Name collisions between rows without SKU/barcode are "ambiguous", not "duplicate" (SA-284).
    const claimedKeys = new Map<string, number>();
    const claimedNames = new Map<string, { row: number; sku: string | null }>();
    const claimedProductIds = new Map<string, number>();
    let anyWrite = false;

    for (let i = 0; i < rawRows.length; i++) {
      const rowNumber = i + 1;
      const parsed = parsedRows[i];
      const name = (parsed.values.name as string | undefined)?.trim();
      const sku = (parsed.values.sku as string | undefined)?.trim();
      const barcode = (parsed.values.barcode as string | undefined)?.trim();
      const label = name || sku || `row ${rowNumber}`;
      const fam = famPlan?.decisions.get(i);
      const famCell = famCells[i];

      const skipRow = (reason: string) => {
        skipped++;
        skippedRows.push({ row: rowNumber, label, reason });
        errors.push(`${label}: ${reason}`);
        rowPlans.push({ row: rowNumber, label, action: "skip", reason });
      };
      // I4/W3: a write (real run) or the service's own read-only identity check (preview) that
      // throws turns this row's already-pushed plan into a skip with the service's reason —
      // identical wording in both modes.
      const failPlan = (plan: ImportRowPlan, e: unknown) => {
        const reason = e instanceof HttpException ? e.message : "import failed";
        if (e instanceof HttpException) errors.push(`${label}: ${reason}`);
        else this.pushRowError(errors, label, e);
        skipped++;
        skippedRows.push({ row: rowNumber, label, reason });
        plan.action = "skip";
        plan.reason = reason;
        delete plan.changes;
      };

      if (parsed.badCells.length > 0) {
        const first = parsed.badCells[0];
        skipRow(`${first.column}: ${first.reason}`);
        continue;
      }

      if (famCell.variantName && !famCell.family) {
        warnings.push(`Row ${rowNumber} (${label}): Variant Name is ignored without a Family.`);
      }

      const rowKeys = [
        ...(sku ? [`sku:${sku.toLowerCase()}`] : []),
        ...(barcode ? [`barcode:${barcode.toLowerCase()}`] : []),
      ];
      const claimedBy = rowKeys.map((k) => claimedKeys.get(k)).find((r) => r !== undefined);
      if (claimedBy !== undefined) {
        skipRow(`duplicate of row ${claimedBy}`);
        continue;
      }

      if (!sku && !barcode && !famCell.id && name) {
        const norm = normalizeNameKey(name);
        const count = nameCounts.get(norm) ?? 0;
        if (count >= 2) {
          skipRow(`ambiguous name (${count} matches)`);
          continue;
        }
      }

      for (const k of rowKeys) claimedKeys.set(k, rowNumber);

      // Matching: exact trimmed SKU → exact barcode → normalized name.
      // SKU and barcode are unique per tenant as stored (case-sensitive), so they match exactly.
      let existing: any = null;
      // SA-823: a Family row was matched by id / SKU / barcode in the planner (a name never regroups); a Product ID
      // cell is the strongest key on any row. Either way the SKU / barcode / name fallbacks below are bypassed.
      let keyMatched = false;
      if (fam) {
        if (fam.skip !== undefined) {
          skipRow(fam.skip);
          continue;
        }
        existing = fam.existing;
        keyMatched = true;
      } else if (famCell.id) {
        existing = await this.prisma.forTenant().product.findFirst({ where: { id: famCell.id } });
        if (!existing) {
          skipRow(
            "That Product ID isn't in this business. Check the Product ID column, or use the SKU.",
          );
          continue;
        }
        keyMatched = true;
      }
      if (!keyMatched && sku) {
        existing = await this.prisma.forTenant().product.findFirst({ where: { sku } });
      }
      if (!keyMatched && !existing && barcode) {
        existing = await this.prisma.forTenant().product.findFirst({ where: { barcode } });
        // W1 (mirrors I1): the row's SKU missed, and the product its barcode found carries a
        // DIFFERENT SKU — rewriting it would be an identity change, never an import update.
        if (existing && sku && existing.sku && existing.sku !== sku) {
          skipRow(
            "SKU differs from the product matched by barcode; change SKUs in the product editor",
          );
          continue;
        }
      }
      if (!keyMatched && !existing && name) {
        const claimedName = claimedNames.get(normalizeNameKey(name));
        if (claimedName) {
          if (sku && claimedName.sku && claimedName.sku !== sku) {
            skipRow(`SKU ${sku} not found; name matches a product with SKU ${claimedName.sku}`);
          } else {
            skipRow(`duplicate of row ${claimedName.row}`);
          }
          continue;
        }
        // A name is only a key when exactly one product carries it (variants can share one).
        const byName = await this.prisma.forTenant().product.findMany({
          where: { name: { equals: name, mode: "insensitive" } },
          take: 2,
        });
        if (byName.length > 1) {
          skipRow(`ambiguous name (${byName.length}+ products match)`);
          continue;
        }
        const nameMatch = byName[0] ?? null;
        // I1: a row whose SKU is present but unmatched must NOT silently rewrite a DIFFERENT
        // product's SKU via a name fallback — that is an identity change, not an update.
        if (nameMatch && sku && nameMatch.sku && nameMatch.sku !== sku) {
          skipRow(`SKU ${sku} not found; name matches a product with SKU ${nameMatch.sku}`);
          continue;
        }
        existing = nameMatch;
      }

      if (existing) {
        if (claimedProductIds.has(existing.id)) {
          skipRow(`duplicate of row ${claimedProductIds.get(existing.id)}`);
          continue;
        }
        claimedProductIds.set(existing.id, rowNumber);
        for (const [kind, value] of [
          ["sku", existing.sku],
          ["barcode", existing.barcode],
        ] as const) {
          const key = value ? `${kind}:${String(value).toLowerCase()}` : null;
          if (key && !claimedKeys.has(key)) claimedKeys.set(key, rowNumber);
        }
        const nameAfter = fam ? fam.label : name || existing.name;
        if (nameAfter) {
          claimedNames.set(normalizeNameKey(nameAfter), {
            row: rowNumber,
            sku: sku || existing.sku || null,
          });
        }
        // ── Update: diff only fields with a DEFINED, DIFFERING parsed value ──────────────────
        const changes: Record<string, unknown> = {};
        const rowWarnings: string[] = [];
        let packSkipReason: string | null = null;
        for (const field of Object.keys(parsed.values)) {
          const newVal = parsed.values[field];
          if (newVal === undefined) continue;
          if (field === "unitsPerBox") {
            const existingVal = existing.unitsPerBox;
            if (existingVal === null || existingVal === undefined) {
              changes.unitsPerBox = newVal;
            } else if (Number(existingVal) !== Number(newVal)) {
              // SA-284 (d): a differing pack size skips the WHOLE row, never a partial update.
              packSkipReason = "pack changes are made in the product editor";
              break;
            }
            continue;
          }
          if (field === "msrp") {
            // M1: mirror `normalizeMsrpForWrite` (products.service.ts) BEFORE diffing — a ≤0
            // MSRP is never actually written (it's normalized to null there), so treating it as
            // "different from null" here would call update() every re-import for no real change.
            const normalizedNew = Number(newVal) > 0 ? (newVal as number) : undefined;
            if (normalizedNew === undefined) continue;
            const existingMsrp = existing.msrp;
            const msrpDiffers =
              existingMsrp == null ||
              roundMoney(Number(existingMsrp)) !== roundMoney(Number(normalizedNew));
            if (msrpDiffers) changes.msrp = normalizedNew;
            continue;
          }
          if (field === "category" && existing.trackedSubcategoryId != null) {
            // W2: update() forces a regulated product's category back to its subcategory's
            // name, so never PLAN a change it would override — warn on the cell instead.
            const current = typeof existing.category === "string" ? existing.category.trim() : "";
            if (current !== (newVal as string).trim()) {
              rowWarnings.push("category is set by its regulated subcategory");
            }
            continue;
          }
          const existingVal = (existing as any)[field];
          let differs: boolean;
          if (field === "standardCost") {
            // M2: standardCost is Decimal(10,4) — compare at 4dp, never `roundMoney` (2dp/cents),
            // which would silently drop the 3rd/4th digit and mask a real cost change.
            differs =
              existingVal == null ||
              roundUnitCost(Number(existingVal)) !== roundUnitCost(Number(newVal as number));
          } else if (PRODUCT_MONEY_FIELDS.has(field)) {
            // a null money column (no MSRP/cost yet) differs from any value, 0 included
            differs =
              existingVal == null ||
              roundMoney(Number(existingVal)) !== roundMoney(Number(newVal as number));
          } else if (typeof newVal === "string") {
            differs = (typeof existingVal === "string" ? existingVal.trim() : "") !== newVal.trim();
          } else {
            differs = existingVal !== newVal;
          }
          if (differs) changes[field] = newVal;
        }

        if (packSkipReason) {
          skipRow(packSkipReason);
          continue;
        }
        // SA-823: on a Family row the variant label (not the Item Name cell) is what the name becomes.
        if (fam) delete changes.name;
        const regroup =
          !!fam &&
          !(
            fam.target.id !== null &&
            existing.parentProductId === fam.target.id &&
            existing.name === fam.label
          );

        for (const w of rowWarnings) warnings.push(`Row ${rowNumber} (${label}): ${w}`);
        const withWarnings = rowWarnings.length > 0 ? { warnings: rowWarnings } : {};
        const withFamily = fam ? { family: fam.info } : {};

        if (Object.keys(changes).length === 0 && !regroup) {
          unchanged++;
          rowPlans.push({
            row: rowNumber,
            label,
            action: "update",
            changes: {},
            ...withWarnings,
            ...withFamily,
          });
          continue;
        }

        // B964-2: a RENAME to a formula-led name is a skip in BOTH modes, decided before the dry-run split (update() would refuse
        // it in a real run). `changes.name` is already a DIFFERING value, so this is change-only against the stored name.
        if (typeof changes.name === "string" || typeof changes.category === "string") {
          const renameViolation =
            (typeof changes.name === "string"
              ? productNameViolation(
                  { name: changes.name },
                  { name: existing.name as string | null },
                )
              : null) ??
            // B990: a changed category cell is a DIFFERING value already; refused change-only against the stored text
            (typeof changes.category === "string"
              ? productCategoryViolation(
                  changes.category,
                  (existing.category as string | null) ?? null,
                )
              : null);
          if (renameViolation) {
            skipRow(renameViolation);
            continue;
          }
        }

        const plannedChanges: Record<string, { from: unknown; to: unknown }> = {};
        for (const [field, to] of Object.entries(changes)) {
          plannedChanges[field] = { from: (existing as any)[field] ?? null, to };
        }
        if (fam && regroup) {
          if (existing.name !== fam.label) {
            plannedChanges.name = { from: existing.name ?? null, to: fam.label };
          }
          plannedChanges.family = { from: fam.info.movesFrom, to: fam.target.name };
        }
        const updatePlan: ImportRowPlan = {
          row: rowNumber,
          label,
          action: "update",
          changes: plannedChanges,
          ...withWarnings,
          ...withFamily,
        };
        rowPlans.push(updatePlan);
        try {
          if (dryRun) {
            // W3: the preview asks update()'s own read-only identity questions (name under the
            // parent, sku/barcode vs other products' codes), so a collision the real run would
            // report is a skip in the preview too.
            await this.productsService.assertIdentityAvailable(
              {
                // SA-823: a regroup checks the label under the TARGET family (a new family has no siblings yet)
                name: fam
                  ? regroup && fam.target.id
                    ? fam.label
                    : undefined
                  : (changes.name as string | undefined),
                parentProductId:
                  fam && regroup ? fam.target.id : (existing.parentProductId ?? null),
                sku: changes.sku as string | undefined,
                barcode: changes.barcode as string | undefined,
              },
              existing.id,
            );
          } else if (fam && regroup) {
            // The move and the row's other cells are ONE update() (assignToParent): all-or-nothing, one audit row.
            const familyId = await this.familyImport!.ensureFamily(famPlan!, fam.target, userId);
            await this.productsService.assignToParent(existing.id, familyId, fam.label, {
              via: "import",
              actorId: userId,
              suppressEmit: true,
              extraChanges: changes,
            });
            this.familyImport!.markAssigned(famPlan!, fam.target);
            anyWrite = true;
          } else {
            await this.productsService.update(existing.id, changes as any, {
              packPrecondition: "internal",
              reparentVia: "import",
              suppressEmit: true,
            });
            anyWrite = true;
          }
          updated++;
        } catch (e: unknown) {
          failPlan(updatePlan, e);
        }
        continue;
      }

      // ── Create ──────────────────────────────────────────────────────────────────────────────
      // M3: a blank name would otherwise reach `productsService.create({ name: undefined })` —
      // either a bogus "A product named ... already exists" (nameTaken lookup with
      // `equals: undefined`) or a raw TypeError off `dto.name.replace`. Check before Rate.
      if (!name && !fam) {
        skipRow("Name is required");
        continue;
      }
      // SA-823: a new variant is stored under its bare label
      const createName = fam ? fam.label : (name as string);
      if (parsed.values.pricePerUnit === undefined) {
        skipRow("Rate is required for a new product");
        continue;
      }
      // B964-2: a formula-led NEW name is a skip in BOTH modes, decided before the dry-run split: create() would refuse it in a
      // real run, so a preview that says "create" would disagree with what the import then does.
      const nameViolation =
        productNameViolation({ name: createName }) ??
        productCategoryViolation(parsed.values.category as string | undefined); // B990: the category cell too
      if (nameViolation) {
        skipRow(nameViolation);
        continue;
      }
      const dto: Record<string, unknown> = {
        name: createName,
        unit: (parsed.values.unit as string | undefined) || "unit",
      };
      for (const [k, v] of Object.entries(parsed.values)) {
        if (k === "name" || k === "unit") continue;
        dto[k] = v;
      }

      // I1: a later row's name lookup sees this planned create in dryRun too (nothing is in the
      // DB yet in a preview) — keeps preview and real run identical.
      claimedNames.set(normalizeNameKey(createName), { row: rowNumber, sku: sku || null });

      const createdPlan: Record<string, { from: unknown; to: unknown }> = {};
      for (const [field, to] of Object.entries(dto)) {
        if (to !== undefined) createdPlan[field] = { from: null, to };
      }
      if (fam) createdPlan.family = { from: null, to: fam.target.name };
      const createPlan: ImportRowPlan = {
        row: rowNumber,
        label: name || createName,
        action: "create",
        changes: createdPlan,
        ...(fam ? { family: fam.info } : {}),
      };
      rowPlans.push(createPlan);
      try {
        if (dryRun) {
          // W3: create()'s own read-only identity checks, asked without writing.
          await this.productsService.assertIdentityAvailable({
            // a new variant's label is judged under its family (a new family has no siblings yet)
            name: fam && !fam.target.id ? undefined : createName,
            parentProductId: fam ? fam.target.id : null,
            sku: sku || undefined,
            barcode: barcode || undefined,
          });
        } else if (fam) {
          dto.parentProductId = await this.familyImport!.ensureFamily(famPlan!, fam.target, userId);
          dto.variantName = fam.label;
          await this.productsService.create(dto as any, {
            suppressEmit: true,
            reparentVia: "import",
          });
          this.familyImport!.markAssigned(famPlan!, fam.target);
          anyWrite = true;
        } else {
          await this.productsService.create(dto as any, { suppressEmit: true });
          anyWrite = true;
        }
        created++;
      } catch (e: unknown) {
        failPlan(createPlan, e);
      }
    }

    // SA-823: an empty family this run created is deactivated in the same run and reported.
    let families: ImportFamilySummary | undefined;
    if (famPlan && this.familyImport) {
      const deactivated = dryRun ? [] : await this.familyImport.deactivateEmpty(famPlan);
      for (const d of deactivated) {
        warnings.push(
          `Family "${d.name}" was created and then deactivated: none of its rows could be saved.`,
        );
      }
      if (famPlan.created.size > 0) anyWrite = true;
      families = this.familyImport.summarize(rowPlans, familyRowNumbers, deactivated);
    }
    // SA-823 section 4: ONE import.products.applied summary row per apply (every product import, Family columns or not).
    if (!dryRun && this.familyImport) {
      await this.familyImport.recordApplied({
        actorId: userId,
        fileName: opts?.fileName,
        counts: { created, updated, unchanged, skipped },
        summary: families,
      });
    }

    // One bulk catalog-changed emission per file, never per row (SA-284 / cause-ruling.md §2.B).
    if (!dryRun && anyWrite) this.productsService.emitCatalogBulkChanged();

    return {
      imported: created,
      created,
      updated,
      unchanged,
      skipped,
      errors,
      rows: rowPlans,
      skippedRows,
      warnings,
      unknownColumns: resolved.unknownColumns,
      dryRun,
      ...(families ? { families } : {}),
    };
  }

  /**
   * Import stock levels from Zoho Stock Summary Report CSV.
   * Columns: Item Name, SKU, Opening Stock, Quantity In, Quantity Out, Closing Stock
   *
   * For each row:
   *  - Find product by barcode (SKU) or name
   *  - Create product if not found (using Closing Stock as initial stock)
   *  - Update currentStock to Closing Stock value
   */
  async importInventory(
    buffer: Buffer,
    userId: string,
  ): Promise<{ updated: number; created: number; skipped: number; errors: string[] }> {
    const rows = this.parseCsv(buffer);
    let updated = 0,
      created = 0,
      skipped = 0;
    const errors: string[] = [];

    for (const row of rows) {
      const name = (row["Item Name"] || "").trim();
      if (!name) {
        skipped++;
        continue;
      }

      // Skip summary/header rows (e.g. "Purchase Invoice" with comma-formatted numbers)
      const rawSku = (row["SKU"] || "").trim();
      // If SKU contains commas it's a formatted number (not a real barcode) — skip
      if (rawSku.includes(",")) {
        skipped++;
        continue;
      }

      // Parse closing stock — handle comma-formatted values like "2,100.00"
      const closingStock = parseImportNumber(row["Closing Stock"] || "0");
      if (isNaN(closingStock)) {
        skipped++;
        continue;
      }

      // Detect summary rows: names like "Purchase Invoice" with no barcode and big stock numbers
      const lowerName = name.toLowerCase();
      if (
        !rawSku &&
        (lowerName.includes("invoice") ||
          lowerName.includes("purchase") ||
          lowerName.includes("account"))
      ) {
        skipped++;
        continue;
      }

      try {
        // Try to find existing product by barcode first, then by name
        let product = rawSku
          ? await this.prisma
              .forTenant()
              .product.findFirst({ where: { OR: [{ barcode: rawSku }, { sku: rawSku }] } })
          : null;

        if (!product) {
          product = await this.prisma.forTenant().product.findFirst({
            where: { name: { equals: name, mode: "insensitive" } },
          });
        }

        if (product) {
          // B568: the counter move and its ADJUSTMENT row are ONE stock transaction, taken under the Product row
          // lock, from the LOCKED stock (a sale that committed after the pre-read above must survive: the delta is
          // `closing - locked`, written as an increment). A movement failure rolls the counter back with it.
          // Positive deltas still open no StockLot (unchanged; filed as a follow-up).
          const productId = product.id;
          const syncTenantId = this.prisma.getTenantId();
          await retryStockTx("import.importInventory", () =>
            this.prisma.tenantTransaction(async (tx: any) => {
              await lockProductsForStock(tx, syncTenantId, [productId]);
              const locked = await tx.product.findFirst({
                where: { id: productId },
                select: { currentStock: true, averageCost: true },
              });
              if (!locked) throw new NotFoundException("Product not found");
              const delta = new Prisma.Decimal(closingStock).minus(locked.currentStock);
              if (delta.eq(0)) return;
              const after = await tx.product.update({
                where: { id: productId },
                data: { currentStock: { increment: delta } },
                select: { currentStock: true },
              });
              await tx.stockMovement.create({
                data: {
                  productId,
                  type: MovementType.ADJUSTMENT,
                  quantity: delta,
                  stockAfter: after.currentStock,
                  avgCostAfter: locked.averageCost,
                  notes: "Zoho stock sync",
                  performedById: userId,
                },
              });
            }, STOCK_TX_OPTIONS),
          );
          updated++;
        } else {
          // B964-2: a NEW product's name is written here; a formula-led one rejects THIS row (a matched existing product
          // only has its stock updated above, so a legacy name never blocks a sync).
          const nameViolation = productNameViolation({ name });
          if (nameViolation) {
            skipped++;
            errors.push(`${name}: ${nameViolation}`);
            continue;
          }
          // Create new product with this stock level. B562 follow-up: writing
          // the opening balance straight onto currentStock with no
          // StockMovement would permanently "gap" this product's ledger —
          // inventory.service.ts's replayProduct has no record of where the
          // stock came from, so it would refuse EVERY future backdated
          // purchase/adjustment on it. Model the opening stock as a PURCHASE
          // movement instead (like a real recordPurchase would), atomically
          // with the product create, so the replay treats it as a legitimate
          // baseline rather than a gap. No cost column exists in this CSV, so
          // the movement carries no unitCost — it fixes the quantity gap only.
          const tenantIdForZoho = this.prisma.getTenantId();
          if (!tenantIdForZoho) throw new BadRequestException("No tenant context");
          const zohoBarcode = rawSku || null;
          await this.prisma.tenantTransaction(async (tx: any) => {
            // #2717 M1 (SA-572b Q4/Q6): lock+check BEFORE the create, same pattern as
            // products.service.ts create().
            if (zohoBarcode) {
              await lockBarcodeCodes(tx, tenantIdForZoho, [zohoBarcode]);
              // SA-603a: lock -> claim -> check -> create. A code an INACTIVE product still holds is released here
              // (audited); an ACTIVE holder is a 409. (barcode and sku are the same code on this path.)
              await claimCodes(tx, {
                tenantId: tenantIdForZoho,
                productId: null,
                actorId: null,
                codes: codeClaims({ barcode: zohoBarcode, sku: zohoBarcode }, null),
              });
              await assertBarcodeAvailable(tx, {
                tenantId: tenantIdForZoho,
                productId: null,
                code: zohoBarcode,
              });
            }
            let createdProduct: { id: string };
            try {
              createdProduct = await tx.product.create({
                data: {
                  name,
                  barcode: zohoBarcode,
                  sku: rawSku || null,
                  currentStock: closingStock,
                  pricePerUnit: 0,
                  unit: "unit",
                  isActive: true,
                },
              });
            } catch (e) {
              mapBarcodeUniqueViolation(e, zohoBarcode ?? "");
            }
            if (closingStock !== 0) {
              await tx.stockMovement.create({
                data: {
                  productId: createdProduct.id,
                  type: MovementType.PURCHASE,
                  quantity: closingStock,
                  notes: "Opening stock (Zoho import)",
                  performedById: userId,
                },
              });
            }
            await syncProductBarcodesFromLegacy(tx, {
              tenantId: tenantIdForZoho,
              productId: createdProduct.id,
              barcode: zohoBarcode,
              unitsPerBox: null,
            });
          });
          created++;
        }
      } catch (e: any) {
        this.pushRowError(errors, name, e);
        skipped++;
      }
    }

    return { updated, created, skipped, errors };
  }

  /**
   * Reads unique supplier names from a Zoho Expense CSV ("Customer Name" column),
   * cross-references existing Customer records (incorrectly imported from Zoho),
   * creates/updates proper Supplier records with full info, then removes those
   * Customer records from the database.
   */
  async importExpenseSuppliers(buffer: Buffer): Promise<{
    created: number;
    updated: number;
    removedFromCustomers: number;
    skipped: number;
    errors: string[];
  }> {
    const rows = this.parseCsv(buffer);
    const errors: string[] = [];
    let created = 0,
      updated = 0,
      skipped = 0;
    const removedFromCustomers = 0;

    // Group rows by vendor name — checks Merchant Name / Vendor Name / Customer Name / etc.
    const vendorRowMap: Record<string, any> = {};
    for (const row of rows) {
      const n = this.getVendorName(row);
      if (n && !vendorRowMap[n.toLowerCase()]) vendorRowMap[n.toLowerCase()] = row;
    }

    const supplierNames = Object.keys(vendorRowMap).map((k) => this.getVendorName(vendorRowMap[k]));

    for (const name of supplierNames) {
      try {
        const sampleRow = vendorRowMap[name.toLowerCase()];

        // Build full supplier profile: CSV columns + customer contact match
        const supplierData = await this.buildSupplierData(name, sampleRow);

        // Upsert supplier (match by name case-insensitive)
        const existing = await this.prisma.forTenant().supplier.findFirst({
          where: { name: { equals: name, mode: "insensitive" } },
        });

        if (existing) {
          await this.prisma.forTenant().supplier.update({
            where: { id: existing.id },
            data: supplierData,
          });
          updated++;
        } else {
          await this.prisma.forTenant().supplier.create({ data: supplierData as any });
          created++;
        }
      } catch (e: any) {
        this.pushRowError(errors, name, e);
        skipped++;
      }
    }

    return { created, updated, removedFromCustomers, skipped, errors };
  }
}
