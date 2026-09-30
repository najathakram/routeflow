# Plan: Regulated items — per-product regulatory UoM + TX Comptroller report UX

> Authored by Fable 5 on 2026-07-30. Status: SHIPPED
> This file is the ONLY context the implementation and review agents receive.
> It must stand alone: no references to "the conversation", no "as discussed".

## Objective

Two owner-reported defects in RouteFlow's regulated-items feature.

**1. TX Comptroller "Item type" and "Unit of measure" are configured on the wrong entity.** They
live on the regulated section (`TrackedCategory.txItemType` / `txUom`), so every product in a
Tobacco section files under one item type and one UoM — but a section legitimately holds
cigarettes, cigars and loose tobacco at once. Worse, the UoM is a _printed label only_:
`RegulatedSalesLedger.unitBasisQty` is a verbatim copy of `InvoiceItem.qty`
(`regulated-ledger.service.ts:79`, comment "W5: no unitBasis conversion yet"), so a line of
2 cases + 3 packs files as "27" under whichever single code the section names. Move the config to
the **product**, and make quantities bucket by selling unit: sold by the box → the product's case
UoM (e.g. `CC` Carton), sold loose → its unit UoM (e.g. `CP` Pack). Make the vocabulary
**template-driven** so a second template (another TX form, another jurisdiction) is a registry
entry rather than another round of edits across six hardcoded copies.

**2. Report UX.** The header "Prepare filing" button duplicates the filings list below it; date
ranges use bare native date inputs; there is no way to add the product name to a report or to
build a custom column layout.

## Constraints & conventions

- **npm + Turbo monorepo.** API `apps/api` (NestJS 11, Prisma 7/Postgres, Jest `*.spec.ts`);
  web `apps/web` (Next.js 14 App Router, Radix + Tailwind, TanStack Query, Playwright);
  mobile `apps/mobile` (Expo, expo-router, Jest pure-logic `__tests__/*.test.ts`).
- **Prettier**: semicolons, double quotes, `printWidth` 100, trailing commas. Match surrounding style.
- **Do NOT introduce**: Vitest, Biome, a second HTTP client, a root ESLint config, snapshot tests.
- **Mobile mirrors web** — same endpoints, same DTOs, same field names; only the UI differs.
- **Never reference a real client tenant** (slug, business name, product/invoice numbers) in code,
  tests, fixtures, or comments. Use `acme`-style placeholders.
- **Do not run** `prisma migrate`, `npm run dev`, dev servers, or deploys. Write migration SQL as a
  file only. A later gate stage runs builds/tests.
- **Money/qty helpers** live in `apps/api/src/common/pricing.ts` (+ web/mobile mirrors). Do not
  re-derive money math; this change does not touch pricing.

### THE critical invariant — back-compat

Backfilled tenants must produce **byte-identical** reports after this change. This is guaranteed by
one rule in the bucketing algorithm: **when a product's `regUomCase` is null, the ledger row's
signed `unitBasisQty` passes through raw and unconverted into a single bucket.** Never multiply by
`unitsPerBox` in that path. Case/unit splitting is strictly per-product opt-in. The migration
backfills `regItemType`/`regUomUnit` from the section and leaves `regUomCase` NULL everywhere, so
every existing tenant keeps exactly one bucket per invoice and identical rounding.

### Qty-basis rule (load-bearing — read twice)

`InvoiceItem.qty` is **total pieces** when `boxes != null`. For a legacy boxed line entered without
a split, `boxes` is null and `qty` is in **cases**. For a non-boxed product, `qty` is units.
`normalizeBoxesPieces` (`apps/api/src/common/pricing.ts:56-80`) guarantees new boxed lines always
carry `boxes`/`pieces` with `qty` = total pieces (`boxes` may be 0).

### Verified facts the design depends on

- `InvoiceItem.productId String?` exists (`schema.prisma:1742`), indexed, nullable — freeform
  regulated lines with no product are real and must be handled.
- `RegulatedSalesLedger.invoiceItemId String?` exists and is indexed, and **every** reversal writer
  stamps it (`regulated-ledger.service.ts` :172 void/reconcile, :352 returns, :558 credit notes),
  at the same scale as the SALE row.
- **`invoiceItemId` can dangle** — there is no FK, and delivered-basis reconcile deletes/recreates
  `InvoiceItem`s, rotating ids (documented at `regulated-ledger.service.ts:242-247`). The report
  MUST tolerate a missing line via raw passthrough + a warning; it must never drop quantity.
- The API runs `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`
  (`apps/api/src/main.ts:167-173`). An unknown request field 400s the whole request. Therefore:
  **do NOT remove `txItemType`/`txUom` from the tracked-category DTOs** — an older mobile build
  still sending them would fail every category save. Keep them accepted-and-ignored.

## Work packages

File lists are DISJOINT. Every package is independently implementable from this file.

---

### WP1 — Schema + migration

- **files:** `apps/api/prisma/schema.prisma`,
  `apps/api/prisma/migrations/20260801000200_product_regulatory_reporting_config/migration.sql`
- **brief:** Add three nullable regulatory-config columns to `Product`, a `reportColumnPrefs`
  JSON column to `TrackedCategory`, deprecation comments on the superseded TX columns, and one
  additive migration with backfills.

**exact code** — in `model Product`, immediately after the `trackedSubcategoryId` field:

```prisma
  /// Regulatory reporting config (template-agnostic; the vocabulary is defined by
  /// the section's reportTemplate — see regulated/template-registry.ts).
  /// regUomUnit = UoM code for loose/unit quantities. regUomCase is OPTIONAL and
  /// opts the product into case-level bucketing when sold by the box; leaving it
  /// NULL makes the report pass quantities through unconverted (back-compat).
  regItemType          String?
  regUomCase           String?
  regUomUnit           String?
```

In `model TrackedCategory`, add after `txUom` (keep the existing columns exactly as they are, only
add the comment and the new field):

```prisma
  /// Saved custom report column layout, keyed by template:
  /// { "TX_COMPTROLLER": ["wholesalerPermit", "retailerName", ...] }
  reportColumnPrefs   Json?
```

Change the doc comments on `wholesalerLicenseNo` / `txItemType` / `txUom` to note:
`/// DEPRECATED — txItemType/txUom are superseded by Product.regItemType/regUomUnit. Kept one release as a shadow; no reader.`
(`wholesalerLicenseNo` stays live — it is the tenant's own permit and is still used.)

**exact migration SQL** (`migration.sql`, additive + idempotent):

```sql
-- Per-product regulatory reporting config; supersedes TrackedCategory.txItemType/txUom.
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "regItemType" TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "regUomCase"  TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "regUomUnit"  TEXT;

-- Saved custom report column layout per template.
ALTER TABLE "TrackedCategory" ADD COLUMN IF NOT EXISTS "reportColumnPrefs" JSONB;

-- Backfill 1: products currently assigned to a TX section inherit its config.
-- regUomCase stays NULL deliberately — case-level reporting is per-product opt-in,
-- which is what makes the new bucketing reproduce today's report numbers exactly.
UPDATE "Product" p
SET "regItemType" = COALESCE(p."regItemType", tc."txItemType"::text),
    "regUomUnit"  = COALESCE(p."regUomUnit",  tc."txUom")
FROM "TrackedCategory" tc
WHERE p."trackedCategoryId" = tc."id"
  AND tc."reportTemplate" = 'TX_COMPTROLLER'
  AND (tc."txItemType" IS NOT NULL OR tc."txUom" IS NOT NULL);

-- Backfill 2: products since DETACHED from the section but with historic regulated
-- sales — their ledger rows still surface in ranged reports via the invoice-line
-- snapshot. COALESCE leaves Backfill 1 winners untouched.
UPDATE "Product" p
SET "regItemType" = COALESCE(p."regItemType", tc."txItemType"::text),
    "regUomUnit"  = COALESCE(p."regUomUnit",  tc."txUom")
FROM "TrackedCategory" tc
WHERE tc."reportTemplate" = 'TX_COMPTROLLER'
  AND (tc."txItemType" IS NOT NULL OR tc."txUom" IS NOT NULL)
  AND EXISTS (
    SELECT 1 FROM "InvoiceItem" ii
    WHERE ii."productId" = p."id" AND ii."trackedCategoryId" = tc."id"
  );
```

Note for the human operator (put it in the migration as a leading SQL comment): repo `.gitignore`
excludes `*.sql`, so this file needs `git add -f`.

---

### WP2 — Template registry + shared report types

- **files:** `apps/api/src/regulated/template-registry.ts` (new),
  `apps/api/src/regulated/template-registry.spec.ts` (new),
  `apps/api/src/regulated/report-types.ts`
- **brief:** Create the single source of truth for report-template metadata: vocabulary
  (item types → their legal UoM codes) and the column superset per template. Add the two new
  warning codes and the `custom` flag to the shared report model.

**exact code** — `template-registry.ts`:

```ts
/**
 * Single source of truth for report-template metadata: the per-product regulatory
 * vocabulary (item types → their legal UoM codes) and each template's column
 * superset. Pure — no Prisma, no Nest. Served to clients by
 * `GET /regulated/templates` so web and mobile stop hardcoding these lists.
 *
 * Adding a jurisdiction = adding an entry here (+ a row builder for per-sale kinds).
 */

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

const TX_COLUMNS: TemplateColumn[] = [
  { key: "wholesalerPermit", label: "Wholesaler Permit #", default: true },
  { key: "retailerTaxpayerId", label: "Retailer Taxpayer ID", default: true },
  { key: "retailerName", label: "Retailer Name", default: true },
  { key: "retailerStreet", label: "Retailer Street Address", default: true },
  { key: "retailerCity", label: "Retailer City", default: true },
  { key: "state", label: "State", default: true },
  { key: "zip", label: "ZIP", default: true },
  { key: "retailerPermit", label: "Retailer Permit #", default: true },
  { key: "itemType", label: "Item Type", default: true },
  { key: "uom", label: "Unit of Measure", default: true },
  { key: "quantity", label: "Quantity", align: "right", default: true },
  { key: "invoiceAmount", label: "Invoice Amount", align: "right", default: true },
  // Optional extras — selecting any of these makes the layout non-official.
  { key: "itemDescription", label: "Item Description", default: false },
  { key: "invoiceNumber", label: "Invoice #", default: false },
  { key: "invoiceDate", label: "Invoice Date", default: false },
];

export const REPORT_TEMPLATES: ReportTemplateDef[] = [
  {
    key: "TX_COMPTROLLER",
    label: "TX Comptroller",
    kind: "per-sale",
    productConfig: {
      caseUomSupported: true,
      itemTypes: [
        {
          code: "1",
          label: "Cigarettes",
          uoms: [
            { code: "CP", label: "CP — Packs" },
            { code: "CS", label: "CS — Sticks" },
            { code: "CC", label: "CC — Cartons" },
          ],
        },
        {
          code: "2",
          label: "Cigars",
          uoms: [
            { code: "SB", label: "SB — Class B sticks" },
            { code: "SC", label: "SC — Class C sticks" },
            { code: "SD", label: "SD — Class D sticks" },
            { code: "SF", label: "SF — Class F sticks" },
          ],
        },
        {
          code: "3",
          label: "Tobacco",
          uoms: [
            { code: "WO", label: "WO — Ounces" },
            { code: "WN", label: "WN — Number (cans/packages)" },
          ],
        },
      ],
    },
    columns: TX_COLUMNS,
  },
  // Aggregate templates: no per-product config.
  // IMPORTANT: read apps/api/src/regulated/filing-csv.ts `buildAggregateReport` and
  // mirror the EXACT column `key` values it emits for each of GENERIC / CA_CDTFA /
  // CA_ABC / CALRECYCLE, all with `default: true`. The keys must match exactly or
  // column projection will reject valid requests. Labels may differ (CA_CDTFA
  // interpolates unitBasis at build time); projection matches on key only.
];

export function templateByKey(key: string): ReportTemplateDef | undefined {
  return REPORT_TEMPLATES.find((t) => t.key === key);
}

export function defaultColumnKeys(templateKey: string): string[] {
  return (templateByKey(templateKey)?.columns ?? []).filter((c) => c.default).map((c) => c.key);
}

export function allColumnKeys(templateKey: string): string[] {
  return (templateByKey(templateKey)?.columns ?? []).map((c) => c.key);
}

export function isValidItemType(templateKey: string, itemType: string): boolean {
  const cfg = templateByKey(templateKey)?.productConfig;
  return !!cfg?.itemTypes.some((t) => t.code === itemType);
}

/** When `itemType` is null the UoM is accepted if ANY item type allows it. */
export function isValidUom(templateKey: string, itemType: string | null, uom: string): boolean {
  const cfg = templateByKey(templateKey)?.productConfig;
  if (!cfg) return false;
  const types = itemType ? cfg.itemTypes.filter((t) => t.code === itemType) : cfg.itemTypes;
  return types.some((t) => t.uoms.some((u) => u.code === uom));
}

/** Human label for an item-type code; "" when unknown or unset. */
export function itemTypeLabel(templateKey: string, itemType: string | null): string {
  if (!itemType) return "";
  const cfg = templateByKey(templateKey)?.productConfig;
  return cfg?.itemTypes.find((t) => t.code === itemType)?.label ?? "";
}
```

**`report-types.ts` edits** — add two codes to `ReportWarningCode` and one field to
`RegulatedReport`:

```ts
  | "UNLINKED_LEDGER_ROWS"
  | "UNMATCHED_LEDGER_LINE"
  | "UNLISTED_PRODUCT_LINE";
```

```ts
  warnings: ReportWarning[];
  /** True when the column layout deviates from the template's official default. */
  custom?: boolean;
  csv: { ... };
```

Also widen `ReportWarning` so a product-scoped warning can name its product:

```ts
export interface ReportWarning {
  code: ReportWarningCode;
  /** A complete human sentence, ready to render in the UI. */
  message: string;
  invoiceId?: string;
  customerName?: string;
  productId?: string;
}
```

**Spec** `template-registry.spec.ts`: valid/invalid item type, UoM valid within its item type,
UoM rejected when it belongs to a different item type but `itemType` is specified, UoM accepted
with `itemType: null`, `defaultColumnKeys` excludes the three optional TX columns,
`itemTypeLabel` returns "" for unknown/null, every template's column keys are unique.

---

### WP3 — TX report engine: per-product case/unit bucketing

- **files:** `apps/api/src/regulated/tx-report.ts`, `apps/api/src/regulated/tx-report.spec.ts`
- **brief:** Rewrite the grouping half of `buildTxReport`. Today it groups signed ledger rows per
  `invoiceId` and stamps the _category's_ single item type + UoM on every row. It must instead
  resolve item type and UoM **per product**, split quantities into case and unit buckets, and emit
  one row per bucket. Everything else (customer/address/license resolution, truncation limits,
  `digitsOnly`, `pickReportAddress`, the CSV shape) stays exactly as it is.

**Interface changes** — replace/extend the exported interfaces:

```ts
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

export interface TxCategoryConfig {
  id: string;
  name: string;
  wholesalerLicenseNo: string | null;
  // txItemType / txUom REMOVED — config now lives on the product.
}
```

Keep `TX_UOM_CODES` and `TX_ITEM_TYPE_LABELS` exported from this file (other modules import them);
they may simply re-export from `./template-registry` or stay as-is. Import `itemTypeLabel` from
`./template-registry` for the Item Type cell.

**New `buildTxReport` signature:**

```ts
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
}): RegulatedReport;
```

**exact code — the bucketing core** (replaces the "Group signed sums by invoiceId" block and the
per-invoice loop header; the customer/address/license/warning body inside the loop is unchanged
apart from the dedupe noted below):

```ts
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
```

**Row emission changes:**

- Iterate `buckets.values()` instead of `sums`. `roundedQty = Math.round(b.qty)`,
  `roundedNet = Math.round(b.net)`; still `continue` when both are 0.
- The Item Type cell is `itemTypeLabel("TX_COMPTROLLER", b.itemType)`; the UoM cell is `b.uom`.
- **Per-invoice warnings must dedupe per invoice** now that one invoice can yield several rows.
  Use a `Set<string>` keyed `` `${code}|${invoiceId}` `` around the `MISSING_TAXPAYER_ID`,
  `INVALID_TAXPAYER_ID`, `MISSING_RETAILER_LICENSE`, `INVALID_RETAILER_LICENSE`, `MISSING_ADDRESS`
  and `NEGATIVE_NET_INVOICE` pushes. `FRACTIONAL_QTY` stays per bucket (it is per row) but include
  the UoM in its message.
- Append optional cells **after** the 12 base cells, in canonical registry order
  (`itemDescription` → `invoiceNumber` → `invoiceDate`), only for keys present in
  `includeOptionalColumns`. `itemDescription` = `b.productName`; `invoiceNumber` =
  `invoice?.invoiceNumber ?? ""`; `invoiceDate` = the issue date as `YYYY-MM-DD`
  (`invoice.issueDate.toISOString().slice(0, 10)`, `""` when the invoice is missing).
  Build the returned `columns` array the same way: the 12 base `TX_COLUMNS` plus the requested
  optional ones in the same canonical order.
- Track `roundedQty`/`roundedNet` numerically on each `BuiltRow` and compute `displayTotals` from
  those numbers rather than by parsing `cells[10]`/`cells[11]` — appended columns must not be able
  to break the totals.
- `displayTotals` becomes: `{ label: "Invoices", value: <count of DISTINCT invoiceIds among emitted rows> }`,
  `{ label: "Rows", value: <emitted row count> }`, `{ label: "Total Quantity", ... }`,
  `{ label: "Total Invoice Amount", ... }`.
- Sort by issue date → invoice number → item type code → UoM code → product name, so the fan-out
  order is deterministic.

**Spec** `tx-report.spec.ts`: the existing ~23 cases all need their fixtures reshaped (the input
signature changed) — keep every assertion's intent. `COMPLETE_CATEGORY` drops `txItemType`/`txUom`;
add `line()` and `productCfg()` factories and default `linesById`/`productsById`; ledger-row
literals gain `invoiceItemId`. The old category-level `MISSING_ITEM_TYPE`/`MISSING_UOM` cases
become per-product cases. New cases required:

1. **Back-compat identity** — `regUomCase: null`, a mix of split / no-split / non-boxed lines:
   rows and totals match a fixture built the old way (one row per invoice, raw qty sums).
2. Split line, `regUomCase: "CC"`, `unitsPerBox: 12`, `boxes: 2`, `pieces: 3`, `qty: 27` →
   two rows: `CC` qty 2 and `CP` qty 3; net split 24/27 vs 3/27 and the two nets sum to the original.
3. `boxes: 0`, `pieces: 5` split line → only the unit bucket is emitted.
4. Legacy no-split boxed line (`boxes: null`, `unitsPerBox: 12`, `qty: 4`) with `regUomCase` set →
   one `CC` row of qty 4 (**not** 48).
5. Same legacy line with `regUomCase: null` → one row, qty 4, under the unit UoM.
6. Non-boxed product → everything in the unit bucket.
7. Full reversal (SALE + equal negative REVERSAL on the same `invoiceItemId`) → both buckets net to
   0 and the invoice emits no rows.
8. Partial return (`factor` = −3/27) → fractional bucket sums, `FRACTIONAL_QTY` warning raised.
9. Reversal whose SALE is outside the range → negative bucket, `NEGATIVE_NET_INVOICE` still raised
   exactly once for that invoice.
10. Dangling `invoiceItemId` (not in `linesById`) → raw passthrough + one `UNMATCHED_LEDGER_LINE`
    warning carrying the count.
11. `invoiceItemId: null` but `invoiceId` set → raw passthrough, no crash.
12. Line with `productId: null` → empty Item Type / UoM cells, quantity still reported, one
    `UNLISTED_PRODUCT_LINE` warning for that invoice.
13. Product missing `regItemType`/`regUomUnit` → empty cells + exactly one warning per product
    even across many invoices.
14. Two products with different configs on one invoice → two rows, both with that invoice's
    customer data, and the per-invoice warnings (e.g. `MISSING_ADDRESS`) appear **once**.
15. `includeOptionalColumns: ["itemDescription"]` → columns gain "Item Description", rows split per
    product, each row's last cell is the product name.

---

### WP4 — Column projection, query DTO, templates endpoint, tracked-category DTOs

- **files:** `apps/api/src/regulated/report-projection.ts` (new),
  `apps/api/src/regulated/report-projection.spec.ts` (new),
  `apps/api/src/regulated/dto/report-query.dto.ts`,
  `apps/api/src/regulated/regulated.controller.ts`,
  `apps/api/src/tracked-categories/dto/create-tracked-category.dto.ts`,
  `apps/api/src/tracked-categories/dto/update-tracked-category.dto.ts`
- **brief:** Add the pure column-projection helper, the `columns` query parameter, the
  `GET /regulated/templates` endpoint, and `reportColumnPrefs` on the tracked-category DTOs.

**exact code** — `report-projection.ts`:

```ts
import { RegulatedReport } from "./report-types";

/**
 * Project a built report onto `keys` (order = output order). `rows` and `totalsRow`
 * are remapped through ONE index map derived from `report.columns`, so the JSON
 * preview and the CSV project identically — the single-source invariant that keeps
 * what an operator previews equal to what they download.
 *
 * `warnings` are deliberately kept in full: they describe the quality of the
 * underlying filing data, and hiding the Taxpayer ID column does not make a missing
 * taxpayer ID acceptable. `displayTotals`, `csv.preamble` and `csv.footer` are not
 * column-shaped and pass through untouched.
 */
export function projectReportColumns(report: RegulatedReport, keys: string[]): RegulatedReport {
  if (!keys.length) throw new Error("At least one column is required");
  const indexByKey = new Map(report.columns.map((c, i) => [c.key, i]));
  const idx: number[] = [];
  const unknown: string[] = [];
  for (const k of keys) {
    const i = indexByKey.get(k);
    if (i === undefined) unknown.push(k);
    else idx.push(i);
  }
  if (unknown.length) throw new Error(`Unknown column(s): ${unknown.join(", ")}`);
  const pick = (row: string[]) => idx.map((i) => row[i] ?? "");
  return {
    ...report,
    columns: idx.map((i) => report.columns[i]),
    rows: report.rows.map(pick),
    totalsRow: report.totalsRow ? pick(report.totalsRow) : null,
  };
}
```

**`report-query.dto.ts`** — append:

```ts
  /**
   * Comma-separated column keys; order defines output order. Absent ⇒ the
   * template's default layout (byte-identical to the pre-custom-format output).
   * Keys are validated against the template's registry superset in the service.
   */
  @IsOptional()
  @Matches(/^[A-Za-z][A-Za-z0-9]*(,[A-Za-z][A-Za-z0-9]*)*$/, {
    message: "columns must be a comma-separated list of column keys",
  })
  @MaxLength(400)
  columns?: string;
```

**`regulated.controller.ts`** — add a static route. It MUST be declared above any `:id`-style
route in this controller (Express matches first-declared), so place it immediately next to the
existing `reports/preview` handler:

```ts
  /** Report-template metadata (vocabulary + column supersets) for the config UIs. */
  @Get("templates")
  getTemplates() {
    return REPORT_TEMPLATES;
  }
```

Import `REPORT_TEMPLATES` from `./template-registry`. Also thread the new `columns` query value
into the two existing report handlers by passing `query.columns` through to the service calls
(`buildReport` / `buildReportCsv` gain a `columns?: string` param — WP5 implements them).

**Tracked-category DTOs** — in BOTH `create-tracked-category.dto.ts` and
`update-tracked-category.dto.ts`:

1. **Do NOT delete `txItemType` / `txUom`.** Add a comment above them:
   `// DEPRECATED — superseded by Product.regItemType/regUomUnit. Still ACCEPTED (and ignored) so an older mobile build's category save is not rejected by forbidNonWhitelisted. Remove next release.`
2. Add the saved column layout:

```ts
  /** Saved custom report column layout, keyed by template code. */
  @IsOptional()
  @IsObject()
  reportColumnPrefs?: Record<string, string[]> | null;
```

**Spec** `report-projection.spec.ts`: subset preserves cell↔column alignment; reorder; `totalsRow`
remapped (and null stays null); unknown key throws; empty keys throws; `warnings`, `displayTotals`,
`csv.preamble`/`footer` pass through untouched; a duplicate key in `keys` is emitted twice
(document whatever behavior you implement and assert it).

---

### WP5 — Report service joins, custom-format wiring, filing service

- **files:** `apps/api/src/regulated/regulated-report.service.ts`,
  `apps/api/src/regulated/regulated-report.service.spec.ts`,
  `apps/api/src/regulated/regulated-filing.service.ts`,
  `apps/api/src/regulated/regulated-filing.service.spec.ts`
- **brief:** Join ledger rows to invoice lines and products, feed the new builder, and implement
  the custom-column pipeline (validate → include-set → project → header/custom/filename).

**`buildTxReportForRange`** — add `invoiceItemId` to the ledger `select`, then two more
tenant-scoped queries before calling `buildTxReport`:

```ts
const itemIds = [
  ...new Set(txLedgerRows.map((r) => r.invoiceItemId).filter((id): id is string => !!id)),
];
const lines = itemIds.length
  ? await this.prisma.forTenant().invoiceItem.findMany({
      where: { id: { in: itemIds } },
      select: {
        id: true,
        productId: true,
        qty: true,
        boxes: true,
        pieces: true,
        unitsPerBox: true,
      },
    })
  : [];
const linesById = new Map<string, TxLineInfo>(
  lines.map((l: any) => [
    l.id,
    {
      id: l.id,
      productId: l.productId,
      qty: Number(l.qty),
      boxes: l.boxes,
      pieces: l.pieces,
      unitsPerBox: l.unitsPerBox,
    },
  ]),
);

const productIds = [
  ...new Set(lines.map((l: any) => l.productId).filter((id: any): id is string => !!id)),
];
const products = productIds.length
  ? await this.prisma.forTenant().product.findMany({
      where: { id: { in: productIds } },
      select: {
        id: true,
        name: true,
        unitsPerBox: true,
        regItemType: true,
        regUomCase: true,
        regUomUnit: true,
      },
    })
  : [];
const productsById = new Map<string, TxProductConfig>(products.map((p: any) => [p.id, p]));
```

Add an optional trailing param `includeOptionalColumns?: string[]` to `buildTxReportForRange` and
pass it into `buildTxReport`. `regulated-filing.service.ts` calls it without that argument, so
persisted filings keep the official layout — its only other change is dropping `txItemType`/`txUom`
from the `TxCategoryConfig` literal it builds (around :160).

Likewise drop those two keys from the literal in `buildReport` (:87-89).

**Custom-column pipeline in `buildReport`** — new optional `columns?: string` param:

```ts
const template = params.template || category.reportTemplate;

// Resolve the requested layout against the template's registry superset.
const requestedKeys = (params.columns ?? "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);
let optionalKeys: string[] = [];
let isCustom = false;
if (requestedKeys.length) {
  const known = allColumnKeys(template);
  if (!known.length) {
    throw new BadRequestException(`Template ${template} has no configurable columns`);
  }
  const unknown = requestedKeys.filter((k) => !known.includes(k));
  if (unknown.length) {
    throw new BadRequestException(`Unknown column(s) for ${template}: ${unknown.join(", ")}`);
  }
  const defaults = defaultColumnKeys(template);
  // Ordered comparison — a pure reorder is also a non-official layout.
  isCustom =
    requestedKeys.length !== defaults.length || requestedKeys.some((k, i) => k !== defaults[i]);
  optionalKeys = requestedKeys.filter((k) => !defaults.includes(k));
}
```

Then: build the report (TX path passes `optionalKeys`), and afterwards

```ts
if (requestedKeys.length) {
  report = projectReportColumns(report, requestedKeys);
  if (isCustom) {
    report.custom = true;
    // The official TX layout is deliberately headerless (filing-ready). A custom
    // layout is NOT the official filing, so it gets a header row to stay legible
    // and visibly distinct from a submittable export.
    report.csv = { ...report.csv, includeHeader: true };
  }
}
```

`buildReportCsv` forwards `columns` and inserts a `-custom` token in the filename when
`report.custom` is true:
`` `${slug}-${safeToken(report.template)}${report.custom ? "-custom" : ""}-${from}-${to}.csv` ``.

**Specs.** `regulated-report.service.spec.ts`: mock `prisma.invoiceItem.findMany` and
`prisma.product.findMany` (check `createMockPrisma` covers those models; extend it in the shared
mock if it does not — if extending requires touching a file outside this package, report it as a
deviation instead). New cases: omitting `columns` yields output deep-equal to the pre-change
fixture (the mobile back-compat guard) **and** leaves `custom` unset and TX headerless; unknown key
→ `BadRequestException`; `columns` exactly equal to the default list → not custom, still headerless;
a reorder-only request → custom, header on; `itemDescription` requested → custom, header on,
`-custom` in the filename; the ledger select includes `invoiceItemId`.
`regulated-filing.service.spec.ts`: add the two new prisma mocks to the TX block (:258-334) and
trim the tx fields from its category fixture; assert persisted filing CSV is unchanged.

---

### WP6 — Products API: DTOs, validation, inheritance

- **files:** `apps/api/src/products/dto/create-product.dto.ts`,
  `apps/api/src/products/dto/update-product.dto.ts`,
  `apps/api/src/products/products.service.ts`,
  `apps/api/src/products/products.service.spec.ts`
- **brief:** Accept, validate and persist the three per-product regulatory fields.

**DTOs** — add to both (matching each file's existing `emptyToNull` import/transform style):

```ts
  /**
   * Regulatory reporting config. The vocabulary is validated service-side against
   * the section's reportTemplate (regulated/template-registry.ts). "" clears.
   */
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(20)
  regItemType?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(20)
  regUomCase?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(20)
  regUomUnit?: string | null;
```

**`products.service.ts`:**

```ts
  /**
   * Regulatory reporting codes must belong to the section's report template. A
   * product with no regulatory config is always valid (the common case).
   */
  private async assertRegConfigValid(params: {
    trackedCategoryId: string | null;
    regItemType: string | null;
    regUomCase: string | null;
    regUomUnit: string | null;
  }): Promise<void> {
    const { trackedCategoryId, regItemType, regUomCase, regUomUnit } = params;
    if (!regItemType && !regUomCase && !regUomUnit) return;
    if (!trackedCategoryId) {
      throw new BadRequestException(
        "Regulatory reporting configuration requires a regulated type",
      );
    }
    const cat = await this.prisma.forTenant().trackedCategory.findUnique({
      where: { id: trackedCategoryId },
      select: { name: true, reportTemplate: true },
    });
    if (!cat) throw new BadRequestException("Regulated type not found");
    if (!templateByKey(cat.reportTemplate)?.productConfig) {
      throw new BadRequestException(
        `"${cat.name}" uses a report template with no per-product configuration`,
      );
    }
    if (regItemType && !isValidItemType(cat.reportTemplate, regItemType)) {
      throw new BadRequestException(
        `"${regItemType}" is not a valid item type for ${cat.reportTemplate}`,
      );
    }
    for (const uom of [regUomCase, regUomUnit]) {
      if (uom && !isValidUom(cat.reportTemplate, regItemType ?? null, uom)) {
        throw new BadRequestException(
          `"${uom}" is not a valid unit of measure for ${cat.reportTemplate}`,
        );
      }
    }
  }
```

Wire it:

- `create`: call after the existing `assertSubcategoryInSection` call (~:430) with the effective
  values; add the three fields to the parent `select` used for variant inheritance (~:399-411) and
  to the regulated inheritance branch (~:418-429) — a variant with no explicit section inherits the
  parent's trio alongside `trackedCategoryId`/`trackedSubcategoryId`; write them into the create
  `data` (~:445-475).
- `update`: call it near the existing subcategory validation (~:563) using the **effective merged**
  values (DTO value when the key is present, else the product's current value). Where the existing
  code auto-clears `trackedSubcategoryId` when the section is cleared (~:571-573), also force
  `regItemType`, `regUomCase` and `regUomUnit` to `null`.

Import `templateByKey`, `isValidItemType`, `isValidUom` from `../regulated/template-registry`.

**Spec** cases: variant inherits the trio when no section is given on the DTO; an explicit DTO value
beats inheritance; clearing the section nulls all three; an invalid item type 400s; an invalid UoM
for the chosen item type 400s; a UoM valid for a _different_ item type 400s when the item type is
set; valid TX codes persist; config without a section 400s; config on a `GENERIC`-template section
400s; a product with no regulatory config saves normally (no extra query).

---

### WP7 — Tracked-categories service: persist reportColumnPrefs

- **files:** `apps/api/src/tracked-categories/tracked-categories.service.ts`,
  `apps/api/src/tracked-categories/tracked-categories.service.spec.ts`
- **effort:** low
- **brief:** `toData()` already spreads DTO keys generically, so `reportColumnPrefs` persists with
  no change — **verify that** and add validation so a saved layout cannot go stale-invalid.

Add a private guard called from `create` and `update`: when `reportColumnPrefs` is present and not
null, every key must be a known template (`templateByKey`) and every value must be a non-empty
array of strings drawn from that template's `allColumnKeys`; otherwise `BadRequestException`.
Import from `../regulated/template-registry`. Add spec cases: valid prefs persist; an unknown
template key 400s; an unknown column key 400s; an empty column array 400s; `null` clears.

---

### WP8 — Web API layer: types + hooks

- **files:** `apps/web/lib/api/tracked-categories.ts`, `apps/web/lib/api/products.ts`
- **brief:** Types and hooks the web UI packages consume.

In `tracked-categories.ts`:

- Add the two new warning codes to the `ReportWarningCode`-equivalent union (~:311-323) and
  `productId?: string` to the warning type.
- Add `custom?: boolean` to the report preview type (~:344-359) and `columns?: string` to
  `RegulatedReportParams` (~:361-369). `useRegulatedReportPreview` and `fetchRegulatedReportCsv`
  must forward `columns` only when it is a non-empty string, so default requests keep today's
  query shape and cache keys.
- Add `reportColumnPrefs?: Record<string, string[]> | null` to `TrackedCategory` (~:15-35) and to
  `TrackedCategoryInput` (~:37-53). Mark `txItemType`/`txUom` `/** @deprecated */`.
- New types + hook:

```ts
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
  default: boolean;
}
export interface ReportTemplateDef {
  key: string;
  label: string;
  kind: "per-sale" | "aggregate";
  productConfig: { itemTypes: TemplateItemType[]; caseUomSupported: boolean } | null;
  columns: TemplateColumn[];
}

/** Report-template metadata; static per deploy, so cache it for the session. */
export function useRegulatedTemplates() {
  return useQuery<ReportTemplateDef[]>({
    queryKey: ["regulated", "templates"],
    queryFn: async () => (await api.get("/regulated/templates")).data,
    staleTime: Infinity,
  });
}
```

Match the file's existing axios/TanStack idiom exactly (import name for the client, error handling,
`queryKey` conventions).

In `products.ts`: add `regItemType`, `regUomCase`, `regUomUnit` as `string | null` to `ApiProduct`
(near `unitsPerBox`, ~:109) and to the create/update input types.

---

### WP9 — Web product forms

- **files:** `apps/web/components/ProductCreateModal.tsx`,
  `apps/web/app/(dashboard)/products/[id]/page.tsx`
- **brief:** Add a "Regulatory reporting" block to product create and product detail edit.

Render the block **only** when the currently selected regulated type's `reportTemplate` resolves,
via `useRegulatedTemplates()`, to a template whose `productConfig` is non-null. The section objects
returned by `useTrackedCategories` already carry `reportTemplate`.

Fields, in order:

1. **Item type** — `<select>` over `productConfig.itemTypes` (`code` → `label`), with a
   "Select…" empty option.
2. **Unit of measure** — `<select>` over the selected item type's `uoms`, disabled until an item
   type is chosen (mirror the existing disabled-until-parent pattern). Label it so it is clearly
   the _loose/piece_ unit, e.g. "Unit of measure (per piece)".
3. **Case unit of measure** — same option list, rendered **only** when
   `productConfig.caseUomSupported` and the form's units-per-box value is `> 1`. Helper text:
   "Used when this product is sold by the case. Leave blank to report every quantity in pieces."

Changing the item type must clear a now-incompatible `regUomCase`/`regUomUnit` (the category modal
at `CategoryFormModal.tsx:342-366` has the exact cascade pattern to copy).

`ProductCreateModal.tsx`: add the three keys to the form state (~:97-112) and reset (~:213-229),
render the block after the Regulated type select (~:537-566, i.e. after the units-per-box field at
~:612-633 is also fine — put it directly below the Regulated type select for adjacency), and
include them in the submit payload (~:252-271) as `value || undefined`.

`products/[id]/page.tsx`: seed the three keys in the edit draft (~:398-418); send them from
`saveEdit` (~:420-478) as `value || null` (explicit null clears), and force all three to `null`
whenever `trackedCategoryId` is being cleared; add read-mode rows showing the item type **label**,
the unit UoM and the case UoM in the existing InfoRow region (~:1566-1668), rendered only when the
product's section template has `productConfig`.

---

### WP10 — Web DateRangePicker component

- **files:** `apps/web/components/DateRangePicker.tsx` (new), `apps/web/package.json`
- **brief:** A reusable range picker with a dropdown two-month calendar and a preset rail. There is
  no calendar component anywhere in this repo today and no Radix popover — hand-roll the popover,
  use `react-day-picker` for the calendar grid.

Add `"react-day-picker": "^9.0.0"` to `apps/web/package.json` dependencies (keep the file's
alphabetical-ish ordering). `date-fns ^4.1.0` is already a declared dependency of `apps/web` and is
currently unused — use it here for formatting.

Component contract:

```tsx
export interface DateRangeValue {
  /** Inclusive YYYY-MM-DD. */
  from: string;
  to: string;
}

export interface DateRangePickerProps {
  value: DateRangeValue;
  preset: string; // a ReportRangePreset key, or "custom"
  presets: { value: string; label: string }[];
  /** Resolve a preset key to a range (the caller owns the preset math). */
  resolvePreset: (preset: string) => DateRangeValue;
  onChange: (next: { preset: string; range: DateRangeValue }) => void;
  /** Inclusive-day cap; days beyond it are disabled once one end is picked. */
  maxDays?: number;
  disabled?: boolean;
  className?: string;
}

export function DateRangePicker(props: DateRangePickerProps): JSX.Element;
```

Requirements:

- `"use client"` at the top.
- Trigger `<button>` styled like the app's existing text inputs, showing the active preset's label,
  or the formatted range when custom (`format(d, "MMM d, yyyy")`).
- Popover: absolutely positioned `z-50` panel; close on outside `mousedown` and on `Escape`. Copy
  the outside-click mechanics from `apps/web/components/SubcategoryCombobox.tsx:73-83`.
- Left rail lists `presets`; clicking one calls
  `onChange({ preset: p.value, range: resolvePreset(p.value) })` and closes.
- Right side: `<DayPicker mode="range" numberOfMonths={2} selected={...} onSelect={...} />`.
  Import `react-day-picker/style.css` in this file and layer Tailwind overrides via the
  `classNames` prop so it matches the app's surface/border tokens.
- Any day click switches `preset` to `"custom"` and emits the new range.
- **Timezone rule:** convert between ISO strings and `Date` using LOCAL calendar constructors —
  `new Date(y, m - 1, d)` and `format(date, "yyyy-MM-dd")` from `date-fns`. Never `toISOString()`
  on a picked day; that shifts the date across the UTC boundary.
- `maxDays` (default 366): once exactly one endpoint is selected, pass a `disabled` matcher to
  `DayPicker` greying out days more than `maxDays - 1` away from it, so the server's 366-day cap
  can never be tripped from this UI.
- Keyboard: `DayPicker` provides grid navigation; ensure the trigger is focusable and the panel
  returns focus to the trigger on close.

---

### WP11 — Web report panel, columns picker, category modal, compliance page

- **files:** `apps/web/components/RegulatedReportPanel.tsx`,
  `apps/web/components/ReportColumnsPicker.tsx` (new),
  `apps/web/components/CategoryFormModal.tsx`,
  `apps/web/app/(dashboard)/compliance/[categoryId]/page.tsx`
- **brief:** The four report-UX changes plus removing the TX config from the category modal.

**`CategoryFormModal.tsx`:**

- Delete the hardcoded `TX_ITEM_TYPES` and `TX_UOM_CODES` consts (~:30-57), the `txItemType`/
  `txUom` form state and hydration (~:87-88, :107-108, :123-124), their payload keys (~:157-158),
  and both selects (~:340-390). Keep the Wholesaler license # input (~:324-339) and the
  requires-license checkbox.
- Add helper copy inside the TX box: "Item type and unit of measure are configured per product."
- Replace the hardcoded `TEMPLATES` array (~:27) with keys from `useRegulatedTemplates()`, showing
  each template's `label`; fall back to the current literal array while the query is loading.

**`ReportColumnsPicker.tsx`** (new):

```tsx
export interface ReportColumnsPickerProps {
  /** The resolved template's full column superset, in canonical order. */
  columns: { key: string; label: string; default: boolean }[];
  /** null = template default (nothing customized yet). */
  value: string[] | null;
  onChange: (next: string[] | null) => void;
  onSave?: () => void;
  saving?: boolean;
  disabled?: boolean;
}
```

Trigger button labelled `Columns (n)`; hand-rolled popover with the same outside-click/Escape
mechanics as `DateRangePicker`. Checkbox per column in canonical order, template-default ones
pre-checked, non-default ones visibly tagged "optional". **The last remaining checked column is
disabled** so the set can never be emptied. Footer: "Reset to template" (`onChange(null)`) and,
when `onSave` is given, "Save for this section".

**Toggle semantics (this is the seamlessness requirement — get it exactly right):** when `value`
is `null`, the first toggle must first **materialize** the array from the template defaults and
then apply the single add/remove. Every other column keeps its state; nothing resets.

```tsx
const toggle = (key: string) => {
  const base = value ?? columns.filter((c) => c.default).map((c) => c.key);
  const next = base.includes(key) ? base.filter((k) => k !== key) : [...base, key];
  // Keep canonical order so the emitted list is stable and comparable.
  const ordered = columns.map((c) => c.key).filter((k) => next.includes(k));
  onChange(ordered);
};
```

**`RegulatedReportPanel.tsx`:**

- Replace the range `<select>` and both native date inputs (~:132-166) with one `<DateRangePicker>`,
  passing the existing `PRESETS` (~:15-20) and `presetRange` from `lib/regulated-format.ts` as
  `resolvePreset`, plus `maxDays={366}`. Delete `handlePresetChange` (~:59-67). Keep
  `validateRange` (~:78-88) as a cheap backstop.
- Build `TEMPLATE_OPTIONS` from `useRegulatedTemplates()` instead of the hardcoded list (~:13),
  falling back to the literal while loading.
- New state `selectedColumns: string[] | null` (`null` = template default). Resolve the active
  template as `template || categoryDefaultTemplate`, look up its `columns` from the templates hook,
  and derive:

```tsx
const defaultKeys = templateDef?.columns.filter((c) => c.default).map((c) => c.key) ?? [];
const isCustom =
  selectedColumns !== null &&
  (selectedColumns.length !== defaultKeys.length ||
    selectedColumns.some((k, i) => k !== defaultKeys[i]));
```

- The template `<select>` shows a synthetic selected option `Custom (based on {label})` while
  `isCustom`; choosing any real template sets `template` and resets `selectedColumns` to `null`.
- Send `columns: selectedColumns.join(",")` to both the preview hook and the CSV fetch **only when
  `isCustom`**, so default requests keep today's exact query shape.
- When the returned report has `custom === true`, show a short hint that the CSV includes a header
  row and is not the official filing layout, and mirror the server's `-custom` filename token in
  the client-side download name (~:108).
- Seed `selectedColumns` on mount and on template switch from the category's
  `reportColumnPrefs?.[resolvedTemplate]`, defensively intersected with the current superset
  (drop unknown keys); otherwise `null`. "Save for this section" PATCHes the category with
  `reportColumnPrefs: { ...existing, [resolvedTemplate]: selectedColumns }` via the existing
  `useUpdateTrackedCategory` hook. Saving is explicit — never auto-save a toggle.
- The preview table (~:203-302) needs **no changes**: the server projects, so cells stay
  server-formatted.

**`compliance/[categoryId]/page.tsx`:**

- Delete the "Prepare filing" `<Button>` from the page header (~:145-158) and simplify the
  now-single-child header wrapper. **Keep** `handlePrepare` (~:74-95), `usePrepareFiling` and the
  `preparing` state.
- Give the Filings card a flex header (copy the shape the "Categories" card already uses at
  ~:236-245): on the left, the hint "Filings for closed periods are prepared automatically
  overnight."; on the right a small secondary **Prepare last period** button wired to
  `handlePrepare`, keeping its existing spinner/disabled behavior.
- Drop the custom `emptyHint` prop (~:278-285) — it says "Use Prepare filing above", which is now
  wrong; `RegulatedFilingsTable`'s built-in empty copy is already correct.

---

### WP12 — Mobile API layer + product form logic

- **files:** `apps/mobile/lib/api/regulated.ts`, `apps/mobile/lib/api/tracked-categories.ts`,
  `apps/mobile/lib/api/products.ts`, `apps/mobile/lib/product-form.ts`,
  `apps/mobile/__tests__/operator-create-forms.test.ts`
- **brief:** Mirror WP8's types/hooks, and thread the three regulatory fields through the pure
  product-form module.

- `regulated.ts`: add `UNMATCHED_LEDGER_LINE` and `UNLISTED_PRODUCT_LINE` to the warning-code union
  (~:117) and `productId?: string` to the warning type; add `custom?: boolean` to the preview type.
- `tracked-categories.ts`: add `reportColumnPrefs`, mark `txItemType`/`txUom` `@deprecated`, and add
  a `useRegulatedTemplates` hook + `ReportTemplateDef` types mirroring WP8 (same shapes, this
  file's own client/TanStack idiom).
- `products.ts`: add `regItemType`/`regUomCase`/`regUomUnit` to the product type and inputs.
- `product-form.ts`: add the three keys (as `string`, `""` when unset) to `ProductFormValues`
  (~:7-51), `emptyProductForm` (~:53-80) and `productFormFromValues` (~:82-113); add them to
  `SubmitPayload` (~:122-145); in `buildProductPayload` (~:147-203) emit `trim() || null` in
  `"edit"` mode and `trim() || undefined` in `"create"` mode, and — mirroring how the function
  already clears `trackedCategoryId`/`trackedSubcategoryId` — force all three to the cleared value
  whenever `trackedCategoryId` is empty.
- `__tests__/operator-create-forms.test.ts`: extend the existing `buildProductPayload` cases —
  round-trip of the three fields in create and edit, `""` → `null` in edit mode, and an empty
  section clearing all three.

---

### WP13 — Mobile screens

- **files:** `apps/mobile/components/ProductForm.tsx`,
  `apps/mobile/components/RegulatedCategoryForm.tsx`,
  `apps/mobile/components/RegulatedReportSection.tsx`,
  `apps/mobile/app/(operator)/regulated/[id]/edit.tsx`
- **brief:** Mirror the web UI changes on mobile.

- `ProductForm.tsx`: extend the existing "Regulated (optional)" section (~:295-310) with Item type
  / Unit of measure / Case unit of measure pickers using the screen's existing
  `OptionPickerSheet` idiom, driven by `useRegulatedTemplates()` and the selected section's
  `reportTemplate`. Show the block only when that template has a `productConfig`; show the case
  picker only when `caseUomSupported` and the existing `isBoxed` flag (~:88-92) is true. Changing
  the item type clears an incompatible UoM.
- `RegulatedCategoryForm.tsx`: delete `txItemType`/`txUom` from values, payload and pickers
  (~:31-32, :48-49, :70-71, :101-122, :145-146, :156, :180-181, :269-284, :345-371); keep the
  wholesaler license field; add the "configured per product" helper line. Source the template list
  from `useRegulatedTemplates()` with the current literal (~:86-92) as loading fallback.
- `app/(operator)/regulated/[id]/edit.tsx`: drop the `txItemType`/`txUom` hydration lines (~:45-46).
- `RegulatedReportSection.tsx`: source its template list (~:35) from the hook, literal as fallback.
- **Out of scope on mobile:** the date-range calendar and the custom-format column picker. Mobile
  must keep sending only `{ category, from, to, template }` — it never sends `columns`.

---

## Acceptance criteria

1. `Product` has nullable `regItemType`, `regUomCase`, `regUomUnit`; `TrackedCategory` has nullable
   `reportColumnPrefs`; one additive migration file adds all four with `IF NOT EXISTS` and performs
   both backfills. No column is dropped and `TrackedCategory.txItemType`/`txUom` still exist.
2. `apps/api/src/regulated/template-registry.ts` exists and exports `REPORT_TEMPLATES`,
   `templateByKey`, `defaultColumnKeys`, `allColumnKeys`, `isValidItemType`, `isValidUom`,
   `itemTypeLabel`. `GET /regulated/templates` returns the registry.
3. `buildTxReport` resolves item type and UoM **from the product**, not the category.
   `TxCategoryConfig` no longer has `txItemType`/`txUom`.
4. **Back-compat:** with every product's `regUomCase` null, `buildTxReport` emits exactly one row
   per invoice with the raw summed `unitBasisQty` — identical rows/order/rounding to the previous
   implementation. A spec asserts this against a fixture. No code path multiplies a legacy
   cases-basis quantity by `unitsPerBox`.
5. With `regUomCase` set, a split line of 2 boxes + 3 pieces (`unitsPerBox` 12, `qty` 27) emits two
   rows — the case UoM with quantity 2 and the unit UoM with quantity 3 — and their net amounts
   sum to the line's net.
6. A ledger row whose `invoiceItemId` is missing from `linesById` still contributes its full
   quantity (raw passthrough) and raises exactly one `UNMATCHED_LEDGER_LINE` warning carrying the
   count. A line with no `productId` raises `UNLISTED_PRODUCT_LINE`.
7. `MISSING_ITEM_TYPE`/`MISSING_UOM` are emitted at most once **per product**; per-invoice warnings
   are emitted at most once **per invoice** even when that invoice fans out into several rows.
8. `GET /regulated/reports/preview` and `/csv` accept `columns`. Omitting it produces output
   byte-identical to before (TX stays headerless, `custom` unset). A non-default set or order sets
   `custom: true`, forces `csv.includeHeader = true`, and adds `-custom` to the CSV filename. An
   unknown column key returns 400.
9. Products accept and persist the three regulatory fields; codes are validated against the
   section's template; clearing the section clears all three; variants inherit them.
10. The web category modal no longer renders or submits item type / unit of measure, and no longer
    hardcodes the TX vocabulary; the mobile category form matches.
11. Web product create and product detail both offer Item type, Unit of measure and — only for a
    boxed product on a case-capable template — Case unit of measure. Mobile's product form mirrors
    them.
12. `RegulatedReportPanel` uses `DateRangePicker` (a dropdown two-month calendar with a preset rail)
    instead of a preset `<select>` plus two native date inputs.
13. Toggling one column when nothing is customized yet materializes the template defaults and
    changes only that column; the template label switches to "Custom (based on …)"; unchecking back
    to exactly the default set reverts the label. A column set can never be emptied.
14. The "Prepare filing" button is gone from the compliance page header and present as
    "Prepare last period" in the Filings card header; the stale `emptyHint` is gone.
15. A custom column layout can be saved on the section and is restored on next visit.
16. Mobile never sends a `columns` parameter.
17. `npm run check-types`, `npm run test` and `npm run lint` all pass.

## Verification commands

Run from the repo root, in this order:

- `npm install --no-audit --no-fund`
- `npx prisma generate --schema apps/api/prisma/schema.prisma`
- `npm run check-types`
- `npm run test`
- `npm run lint`

Do **not** run `prisma migrate`, `npm run dev`, or any deploy/Railway command.

## Risks & rollback

- **Silent restatement of filed reports** is the highest-severity risk. The back-compat path
  (criterion 4) is the guard; reviewers should trace it first. Any `* unitsPerBox` appearing in the
  `regUomCase == null` path is a blocker.
- **Dangling `invoiceItemId`** is real (no FK; reconcile rotates ids). Raw passthrough must never
  drop quantity.
- **`forbidNonWhitelisted`**: removing `txItemType`/`txUom` from the tracked-category DTOs would
  400 older clients' category saves. They must remain accepted.
- **Deploy ordering**: the API must ship before a web build that sends `columns`.
- **Rounding fan-out**: once configs diverge, several buckets per invoice round independently
  (±1 versus the old single row). Inherent to the requested split; backfilled tenants are
  unaffected because they stay single-bucket.
- **New dependency** `react-day-picker` in `apps/web` only. If it cannot install, the gate fails
  loudly rather than silently degrading.
- **Rollback**: `git revert` the commit; the migration is purely additive, so the columns can be
  left in place harmlessly (nothing reads them once the code is reverted).
