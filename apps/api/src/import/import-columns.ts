import { PRODUCT_IMPORT_COLUMNS, CUSTOMER_IMPORT_COLUMNS } from "./import-column-aliases";
import { parseImportMoney, parseImportNumber } from "./parse-import-number";
import { roundUnitCost } from "@routeflow/pricing";

/**
 * B858 + B859 — pure column-registry module (FIX1, cause-ruling.md §2.A / SA-284).
 *
 * No Nest decorators, no Prisma import — this module is imported by `ImportService` (FIX4) to
 * resolve CSV headers to canonical fields and to parse each cell, but has NO DI access of its
 * own; the file-level entitlement gate (a "Tobacco"/"MSRP" column present without its addon)
 * happens in `ImportService`, which DOES have access to `ProductsService`'s guard methods.
 *
 * Money parsing reuses `parseImportMoney` (never re-implements number parsing) and rounds
 * through `roundMoney` — this is the fix for the `parseImportMoney(...) || 0` trap (SA-284 (f)):
 * a present-but-unparseable money cell is ALWAYS a bad cell, never a silent $0.
 */

export type ParseResult =
  { ok: true; value: unknown; warning?: string } | { ok: false; reason: string };

export type CellParser = (raw: string) => ParseResult;

export interface ColumnDef {
  field: string;
  canonical: string;
  aliases: string[];
  parse: CellParser;
  /** Entitlement gate key this field is guarded by (checked by ImportService, not here). */
  gate?: "msrp" | "tobacco" | "forecasting";
}

/**
 * Lowercase, strip a leading BOM and quote characters, collapse any run of
 * whitespace/underscore/hyphen/dot/slash into a single space, then trim.
 */
export function normalizeHeader(h: string): string {
  return h
    .replace(/^\uFEFF/, "")
    .replace(/["']/g, "")
    .toLowerCase()
    .replace(/[\s_\-./]+/g, " ")
    .trim();
}

const isBlank = (raw: string | null | undefined): boolean => raw == null || raw.trim() === "";

/** blank input ⇒ always {ok:true, value:undefined} regardless of parser kind (SA-284 pin). */
function withBlankGuard(parse: CellParser): CellParser {
  return (raw: string) => {
    if (isBlank(raw)) return { ok: true, value: undefined };
    return parse(raw);
  };
}

/**
 * Largest value a `Decimal(10,2)` column holds — every price/tier/MSRP column AND
 * `Customer.creditLimit` (I3). `CreateCustomerDto.creditLimit` says `@Max(1_000_000_000)`, but the
 * column overflows above this, so the importer bounds to the column, the tighter of the two.
 */
const MAX_MONEY_10_2 = 99_999_999.99;
/** `standardCost` is `Decimal(10,4)` (6 integer digits) — a distinct, tighter bound (M2). */
const MAX_STANDARD_COST = 999_999.9999;

/**
 * Money cell parser factory. Reuses `parseImportMoney`/`parseImportNumber` for the actual numeric
 * parse, but first validates that the (currency/comma/space-stripped) cell is ENTIRELY numeric —
 * `parseFloat` happily returns 12 for "12abc", so that leading-numeric leniency is rejected here
 * before ever calling into it. A non-blank, unparseable cell is always a bad cell — never coerced
 * to 0 (the exact fix for the `|| 0` trap, SA-284 (f)).
 *
 * I3: negative values are always rejected ("must not be negative" — the DTOs never accept a
 * negative price/cost/creditLimit), and each field carries a max bound matching its DTO/column so
 * a value that would overflow the Decimal column at write time is caught here as a bad cell
 * instead of throwing a raw Prisma numeric-overflow error mid-transaction.
 */
function boundedMoneyParser(max: number): CellParser {
  return withBlankGuard((raw) => parseStrictMoneyCell(raw, { max }));
}

/**
 * The ONE strict money-cell check, shared by the column registry above and the invoice importer
 * (#2190): the (currency/comma/space-stripped) cell must be ENTIRELY numeric, then it is parsed by
 * `parseImportMoney` and bounded to `max` (the Decimal(10,2) column by default). Callers own the
 * blank check (blank = absent); this treats every string it is handed as a present cell. Invoice
 * money may legitimately be negative (credits), so `allowNegative` lets that through — in which case
 * the bound applies to the magnitude.
 */
export function parseStrictMoneyCell(
  raw: string,
  opts: { max?: number; allowNegative?: boolean } = {},
): { ok: true; value: number } | { ok: false; reason: string } {
  const max = opts.max ?? MAX_MONEY_10_2;
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    return { ok: false, reason: "not a number" };
  }
  const n = parseImportMoney(raw);
  if (!Number.isFinite(n)) {
    return { ok: false, reason: "not a number" };
  }
  if (n < 0 && !opts.allowNegative) {
    return { ok: false, reason: "must not be negative" };
  }
  if (Math.abs(n) > max) {
    return { ok: false, reason: `must be ${max} or less` };
  }
  return { ok: true, value: n };
}

const moneyParser: CellParser = boundedMoneyParser(MAX_MONEY_10_2);

/**
 * M2: `standardCost` is `Decimal(10,4)` — rounding it to cents (like every other money column)
 * silently drops the 3rd/4th decimal digit, a real cost error on low-price items, and can compare
 * two genuinely different costs as "unchanged". Parsed and compared at 4dp, never via `roundMoney`
 * (which is 2dp / cents, for actual money math elsewhere). Still rejects negatives and bounds to
 * the column's own max (I3).
 */
const costParser: CellParser = withBlankGuard((raw) => {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    return { ok: false, reason: "not a number" };
  }
  const n = parseImportNumber(raw);
  if (!Number.isFinite(n)) {
    return { ok: false, reason: "not a number" };
  }
  if (n < 0) {
    return { ok: false, reason: "must not be negative" };
  }
  if (n > MAX_STANDARD_COST) {
    return { ok: false, reason: `must be ${MAX_STANDARD_COST} or less` };
  }
  // No mirrors: 4dp rounding reuses @routeflow/pricing's roundUnitCost (same away-from-zero
  // decimal-string rounding as the old local `roundTo(n, 4)`, which is now retired) rather than a
  // second local implementation of money rounding.
  return { ok: true, value: roundUnitCost(n) };
});

function intParser(min: number, max: number): CellParser {
  return withBlankGuard((raw) => {
    const trimmed = raw.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      return { ok: false, reason: `must be a whole number between ${min} and ${max}` };
    }
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < min || n > max) {
      return { ok: false, reason: `must be a whole number between ${min} and ${max}` };
    }
    return { ok: true, value: n };
  });
}

/** yes/true/1 -> true, no/false/0 -> false — the ONE literal set shared by every bool field. */
const boolParser: CellParser = withBlankGuard((raw) => {
  const v = raw.trim().toLowerCase();
  if (["yes", "true", "1"].includes(v)) return { ok: true, value: true };
  if (["no", "false", "0"].includes(v)) return { ok: true, value: false };
  return { ok: false, reason: "must be yes/no, true/false, or 1/0" };
});

const DUE_ON_RECEIPT_RE = /^(due on receipt|due upon receipt|cod|0)$/i;
const NET_TERMS_RE = /^(net ?(15|30|45|60)|n(15|30|45|60)|(15|30|45|60))$/i;
/** SA-305 (1): a Zoho payment-terms integer with no exact label (7, 10, 90, …) — bare digits only. */
const BARE_INTEGER_RE = /^-?\d+$/;

/**
 * Matches the existing VALID_CUSTOMER_TERMS labels — never invents a new label.
 *
 * SA-305 (1) — a bounded amendment to SA-284(b), for THIS field only: a bare Zoho integer that
 * maps exactly (0 → Due on Receipt; 15/30/45/60 → Net n) resolves normally above. A bare integer
 * with NO exact label (7, 10, 90, …) is never guessed (Net 7 is not Net 15) — the row still
 * imports, with `defaultPaymentTerms` left unset and a per-row warning naming the unmapped value.
 * This is the ONE column allowed to drop a cell instead of failing the row; every other field
 * (money, tier, dates, licence, consent) stays bad-cell ⇒ skip row.
 */
const termsParser: CellParser = withBlankGuard((raw) => {
  const v = raw.trim();
  if (DUE_ON_RECEIPT_RE.test(v)) return { ok: true, value: "Due on Receipt" };
  const netMatch = v.match(NET_TERMS_RE);
  if (netMatch) {
    const days = netMatch[2] || netMatch[3] || netMatch[4];
    return { ok: true, value: `Net ${days}` };
  }
  if (BARE_INTEGER_RE.test(v)) {
    return {
      ok: true,
      value: undefined,
      warning: `Payment Terms "${v}" is not a recognized term (0, 15, 30, 45, 60 map to a label) — imported with payment terms left unset`,
    };
  }
  return { ok: false, reason: "must be a recognized payment term" };
});

const tierParser: CellParser = intParser(1, 5);

/** YYYY-MM-DD or M/D/YYYY -> a Date at UTC midnight. */
const dateParser: CellParser = withBlankGuard((raw) => {
  const v = raw.trim();
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const [, y, m, d] = iso;
    return { ok: true, value: new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))) };
  }
  const us = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) {
    const [, m, d, y] = us;
    return { ok: true, value: new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))) };
  }
  return { ok: false, reason: "must be a date in YYYY-MM-DD or M/D/YYYY format" };
});

function strParser(max: number): CellParser {
  return withBlankGuard((raw) => {
    const v = raw.trim();
    if (v.length > max) {
      return { ok: false, reason: `must be ${max} characters or fewer` };
    }
    return { ok: true, value: v };
  });
}

/** Postgres `integer` (Prisma `Int`) max — a larger cell would overflow the column at write time. */
const MAX_INT = 2_147_483_647;

function aliasesFor(columns: { field: string; aliases: string[] }[], field: string): string[] {
  const entry = columns.find((c) => c.field === field);
  if (!entry) {
    throw new Error(
      `import-columns: no alias entry for field "${field}" in import-column-aliases.ts`,
    );
  }
  return entry.aliases;
}

function canonicalFor(columns: { field: string; canonical: string }[], field: string): string {
  const entry = columns.find((c) => c.field === field);
  if (!entry) {
    throw new Error(
      `import-columns: no alias entry for field "${field}" in import-column-aliases.ts`,
    );
  }
  return entry.canonical;
}

export const PRODUCT_COLUMNS: ColumnDef[] = [
  "name",
  "sku",
  "barcode",
  "unit",
  "pricePerUnit",
  "priceTier2",
  "priceTier3",
  "priceTier4",
  "priceTier5",
  "unitsPerBox",
  "category",
  "description",
  "standardCost",
  "msrp",
  "isTobacco",
  "reorderPoint",
  "reorderQty",
  "id",
  "family",
  "variantName",
].map((field): ColumnDef => {
  const canonical = canonicalFor(PRODUCT_IMPORT_COLUMNS, field);
  const aliases = aliasesFor(PRODUCT_IMPORT_COLUMNS, field);
  switch (field) {
    case "name":
    case "sku":
    case "barcode":
    case "unit":
    case "category":
    case "family":
    case "variantName":
      return { field, canonical, aliases, parse: strParser(200) };
    case "id":
      // SA-823: a product id is looked up as given (tenant-scoped); one that is not found skips the row.
      return { field, canonical, aliases, parse: strParser(64) };
    case "description":
      return { field, canonical, aliases, parse: strParser(2000) };
    case "pricePerUnit":
    case "priceTier2":
    case "priceTier3":
    case "priceTier4":
    case "priceTier5":
      return { field, canonical, aliases, parse: moneyParser };
    case "standardCost":
      // M2: Decimal(10,4) — its own parser (4dp, its own max bound), never the 2dp moneyParser.
      return { field, canonical, aliases, parse: costParser };
    case "msrp":
      return { field, canonical, aliases, parse: moneyParser, gate: "msrp" };
    case "isTobacco":
      return { field, canonical, aliases, parse: boolParser, gate: "tobacco" };
    case "unitsPerBox":
      return { field, canonical, aliases, parse: intParser(0, MAX_INT) };
    case "reorderPoint":
    case "reorderQty":
      // Reorder settings are a flag.forecasting feature (their HTTP writer is gated on it).
      return { field, canonical, aliases, parse: intParser(0, MAX_INT), gate: "forecasting" };
    default:
      throw new Error(`import-columns: unhandled PRODUCT_COLUMNS field "${field}"`);
  }
});

// ── Customer identity/address aliases — read EXACTLY as `importContacts` reads them today ──────
// (import.service.ts's importContacts). Length bounds equal `CreateCustomerDto`'s @MaxLength
// where one exists (so an import never lands a value the customer edit form would then refuse
// to save, and never refuses one the form accepts); address parts, which have no DTO cap, keep
// a generous bound. An overflow skips the ROW with "<Column>: must be N characters or fewer" —
// never a truncation (SA-305 (1)).
const CUSTOMER_IDENTITY_ADDRESS_COLUMNS: ColumnDef[] = [
  {
    field: "displayName",
    canonical: "Display Name",
    aliases: ["Display Name"],
    parse: strParser(120),
  },
  { field: "salutation", canonical: "Salutation", aliases: ["Salutation"], parse: strParser(20) },
  { field: "firstName", canonical: "First Name", aliases: ["First Name"], parse: strParser(80) },
  { field: "lastName", canonical: "Last Name", aliases: ["Last Name"], parse: strParser(80) },
  { field: "phone", canonical: "Phone", aliases: ["Phone", "Billing Phone"], parse: strParser(40) },
  { field: "mobile", canonical: "MobilePhone", aliases: ["MobilePhone"], parse: strParser(40) },
  { field: "email", canonical: "EmailID", aliases: ["EmailID", "Email"], parse: strParser(254) },
  {
    field: "currency",
    canonical: "Currency Code",
    aliases: ["Currency Code"],
    parse: strParser(3),
  },
  { field: "notes", canonical: "Notes", aliases: ["Notes"], parse: strParser(2000) },
  {
    field: "contactType",
    canonical: "Contact Type",
    aliases: ["Contact Type"],
    parse: strParser(50),
  },
  {
    field: "billingAttention",
    canonical: "Billing Attention",
    aliases: ["Billing Attention"],
    parse: strParser(120),
  },
  {
    field: "billingAddress",
    canonical: "Billing Address",
    aliases: ["Billing Address"],
    parse: strParser(300),
  },
  {
    field: "billingStreet2",
    canonical: "Billing Street2",
    aliases: ["Billing Street2"],
    parse: strParser(300),
  },
  {
    field: "billingCity",
    canonical: "Billing City",
    aliases: ["Billing City"],
    parse: strParser(100),
  },
  {
    field: "billingState",
    canonical: "Billing State",
    aliases: ["Billing State"],
    parse: strParser(100),
  },
  {
    field: "billingZip",
    canonical: "Billing Code",
    aliases: ["Billing Code"],
    parse: strParser(20),
  },
  {
    field: "billingLatitude",
    canonical: "Billing Latitude",
    aliases: ["Billing Latitude"],
    parse: strParser(30),
  },
  {
    field: "billingLongitude",
    canonical: "Billing Longitude",
    aliases: ["Billing Longitude"],
    parse: strParser(30),
  },
  {
    field: "shippingAddress",
    canonical: "Shipping Address",
    aliases: ["Shipping Address"],
    parse: strParser(300),
  },
  {
    field: "shippingStreet2",
    canonical: "Shipping Street2",
    aliases: ["Shipping Street2"],
    parse: strParser(300),
  },
  {
    field: "shippingCity",
    canonical: "Shipping City",
    aliases: ["Shipping City"],
    parse: strParser(100),
  },
  {
    field: "shippingState",
    canonical: "Shipping State",
    aliases: ["Shipping State"],
    parse: strParser(100),
  },
  {
    field: "shippingZip",
    canonical: "Shipping Code",
    aliases: ["Shipping Code"],
    parse: strParser(20),
  },
  {
    field: "shippingLatitude",
    canonical: "Shipping Latitude",
    aliases: ["Shipping Latitude"],
    parse: strParser(30),
  },
  {
    field: "shippingLongitude",
    canonical: "Shipping Longitude",
    aliases: ["Shipping Longitude"],
    parse: strParser(30),
  },
];

export const CUSTOMER_COLUMNS: ColumnDef[] = [
  ...[
    "businessName",
    "zohoContactId",
    "defaultPaymentTerms",
    "pricingTier",
    "creditLimit",
    "isTaxExempt",
    "taxId",
    "tobaccoLicenseNo",
    "tobaccoLicenseExpiry",
    "deliveryWindowStart",
    "deliveryWindowEnd",
    "smsConsent",
    "waConsent",
  ].map((field): ColumnDef => {
    const canonical = canonicalFor(CUSTOMER_IMPORT_COLUMNS, field);
    const aliases = aliasesFor(CUSTOMER_IMPORT_COLUMNS, field);
    switch (field) {
      case "businessName":
      case "zohoContactId":
        return { field, canonical, aliases, parse: strParser(200) };
      case "defaultPaymentTerms":
        return { field, canonical, aliases, parse: termsParser };
      case "pricingTier":
        return { field, canonical, aliases, parse: tierParser };
      case "creditLimit":
        // I3: Customer.creditLimit is Decimal(10,2) — the same column bound as every price.
        return { field, canonical, aliases, parse: moneyParser };
      case "isTaxExempt":
      case "smsConsent":
      case "waConsent":
        return { field, canonical, aliases, parse: boolParser };
      case "taxId":
        return { field, canonical, aliases, parse: strParser(40) };
      case "tobaccoLicenseNo":
        return { field, canonical, aliases, parse: strParser(100) };
      case "tobaccoLicenseExpiry":
        return { field, canonical, aliases, parse: dateParser };
      case "deliveryWindowStart":
      case "deliveryWindowEnd":
        return { field, canonical, aliases, parse: strParser(20) };
      default:
        throw new Error(`import-columns: unhandled CUSTOMER_COLUMNS field "${field}"`);
    }
  }),
  ...CUSTOMER_IDENTITY_ADDRESS_COLUMNS,
];

export interface ResolvedColumns {
  byField: Record<string, string>;
  unknownColumns: string[];
}

/**
 * Normalizes every header and matches it against every (normalized) alias in the registry.
 * A header matching nothing is collected into `unknownColumns` — e.g. "Average Cost" against
 * PRODUCT_COLUMNS, which has no `averageCost` field (SA-284 pin P5).
 */
export function resolveColumns(headers: string[], registry: ColumnDef[]): ResolvedColumns {
  const byField: Record<string, string> = {};
  const unknownColumns: string[] = [];

  // normalized header -> the file's header text (first occurrence wins)
  const present = new Map<string, string>();
  for (const header of headers) {
    const key = normalizeHeader(header);
    if (!present.has(key)) present.set(key, header);
  }

  // Each field takes the FIRST of its aliases the file carries, in alias order — the same
  // priority as the old `row["A"] || row["B"]` reads. One header may feed several fields
  // ("Display Name" is both the display name and a fallback business name).
  const used = new Set<string>();
  for (const col of registry) {
    for (const alias of col.aliases) {
      const key = normalizeHeader(alias);
      const header = present.get(key);
      if (header !== undefined) {
        byField[col.field] = header;
        used.add(key);
        break;
      }
    }
  }

  for (const [key, header] of present) {
    if (
      !used.has(key) &&
      !registry.some((c) => c.aliases.some((a) => normalizeHeader(a) === key))
    ) {
      unknownColumns.push(header);
    }
  }

  return { byField, unknownColumns };
}

export interface ParsedRow {
  values: Record<string, unknown>;
  badCells: { column: string; reason: string }[];
  /** SA-305 (1): a cell that dropped its value (never fails the row) but still needs a signal. */
  warnings: { column: string; message: string }[];
}

/**
 * For each resolved field, run its parser on the row's raw cell value. A `gate` field is parsed
 * the same as any other field — the file-level entitlement check happens in `ImportService`
 * (this module has no Nest/DI access to entitlements).
 */
export function parseRow(
  row: Record<string, string>,
  resolved: ResolvedColumns,
  registry: ColumnDef[],
): ParsedRow {
  const values: Record<string, unknown> = {};
  const badCells: { column: string; reason: string }[] = [];
  const warnings: { column: string; message: string }[] = [];

  for (const col of registry) {
    const header = resolved.byField[col.field];
    if (!header) continue;
    const raw = row[header] ?? "";
    const result = col.parse(String(raw));
    if (result.ok) {
      if (result.value !== undefined) values[col.field] = result.value;
      if (result.warning) warnings.push({ column: header, message: result.warning });
    } else {
      badCells.push({ column: header, reason: result.reason });
    }
  }

  return { values, badCells, warnings };
}
