# Build plan: B858 + B859 — importer commercial columns

> **Stage S5 — "how".** Authored by Fable 5 @ high on `2026-09-25`.
> Status: `APPROVED`
> Inputs: `cause-ruling.md` (why + design), `sa-284-ruling.md` (binding design ruling),
> `s2-refutation.md` (confirmed cause), `bug-test-plan.md` (`T#`/pins).
> This file is the ONLY context the implementation and review agents receive.

**Gate to pass before S6:** every task declares what it satisfies and what proves it in its
`### <id> — <title>` brief below. A task that satisfies nothing is scope creep; a task proven by
nothing is unverifiable.

---

## Objective

`importProducts` and `importContacts` (`apps/api/src/import/import.service.ts`) each hard-code a five-field
header set and write through raw `prisma.create`, so every other commercial column (pack size, price tiers,
barcode, category, cost, payment terms, pricing tier, credit limit, tax fields, tobacco licence, consent) is
silently dropped on import, and a name-match on re-import is skipped instead of updated (B858, B859). This
change replaces both importers with a column-registry-driven plan-then-apply flow that writes exclusively
through `ProductsService`/`CustomersService`, so every service guard (tobacco/MSRP entitlement gates, sku/
barcode/name collision checks, catalog-changed events) runs on import exactly as it does on a manual edit, and
fixes the `parseImportMoney(...) || 0` trap that turns an unparseable price into a silent $0.

**In scope:** the column registry module; making both importers plan-then-apply through the two services;
file-level entitlement gate refusal; per-row skip reasons; the products pack-size rule; customer consent
evidence; the web preview/import panel and its two call sites.

**Explicitly out of scope:** invoices/payments/inventory/expense importers; `importFromZoho`'s dead JSON path
(own PR, SA-284); geocoding on import (stays out, filed separately); any Prisma schema change/migration; the
zero-price data-repair script (read-only report only, never bundled — cause-ruling.md §6); the runbook §5 docs
update (deferred, waits on #2154; registry close + lesson land in the Option B bookkeeping PR per project
CLAUDE.md).

---

## Constraints & conventions

- **Stack:** NestJS 11 API (`apps/api`), Next.js 14 web (`apps/web`), npm workspaces.
- **Test runner:** Jest, `*.spec.ts`, `Test.createTestingModule` + `createMockPrisma()` (the existing helper
  used by `apps/api/src/import/import-robustness.spec.ts` and siblings). No snapshot tests, no Vitest.
- **Lint/format:** ESLint flat config per workspace (`npm run lint`, never bare `eslint` from repo root);
  Prettier — semicolons, double quotes, `printWidth` 100, trailing commas.
- **Existing patterns to copy:**
  - `apps/api/src/import/import-robustness.spec.ts`, `import-address-state.spec.ts`,
    `import-customer-cap.spec.ts` — the Nest-module + `createMockPrisma()` harness shape for the new specs.
  - `apps/api/src/products/products.service.ts` `assertMsrpAllowed`/`assertCanFlagTobacco` (private methods,
    lines ~112/143) — the gate functions the fix flips `private` → public; body is untouched.
  - `apps/api/src/products/products.service.ts` `emitProductChanged(null, "bulk")` (used at ~L1032) — the
    pattern for the new `emitCatalogBulkChanged()` public wrapper.
  - `apps/api/src/audit/audit.service.ts` `AuditService.log(dto: CreateAuditLogDto)` — exact shape already
    exists (`tenantId, userId, action, entityType, entityId?, meta?`), no schema change needed.
- **Design system source:** N/A for the API tasks. Web task follows `apps/web/app/(dashboard)/settings/import/page.tsx`'s existing card layout and `apps/web/app/(dashboard)/customers/page.tsx`'s `ImportCustomersModal` (~L80) for the modal shell.
- **Must NOT change:** invoices/payments/inventory/expense importer code paths, `importFromZoho`, `parseCsv`,
  `pushRowError`, `MAX_IMPORT_ROWS`, the cap gate placement, address-state fields, DTO validators, any Prisma
  schema/migration.
- **Do-not-introduce list:** Vitest, Biome, Supabase, Vercel, a second HTTP client, a root-level test runner or
  root ESLint config.
- **Landmines:**
  - `ImportModule` currently does NOT inject `ProductsService` (import.service.ts ctor, verified L48) — adding
    it is a DI-graph change; project CLAUDE.md requires `npm run local:up && npm run local:validate` (L-113,
    compose boot gate) before push whenever DI changes.
  - `ProductsService.create` currently takes ONLY `(dto: CreateProductDto)` — verified at
    `apps/api/src/products/products.service.ts` L507; this PR ADDS the optional second `options` parameter
    (mirroring `update`'s existing `options?: { suppressEmit?: boolean }` at L722). Do not confuse "gains the
    same options `update` already has" with `update` itself changing shape beyond its own new `options.compliance`.
  - `CustomersService.update` currently takes ONLY `(id: string, dto: UpdateCustomerDto)` — verified at
    `apps/api/src/customers/customers.service.ts` L767. This PR adds an optional third param
    `options?: { compliance?: CustomerComplianceInput }`; the DTO itself is NOT widened (L-181) — compliance
    fields never touch `UpdateCustomerDto`/`CreateCustomerDto`.
  - `AuditModule` is `@Global()` (already exports `AuditService` tenant-wide) — importing it into `ImportModule`
    is harmless but not strictly required by Nest's DI; do it anyway per the ruling for explicitness/clarity of
    the dependency graph.
  - `packages/types/api/import.ts` does not exist yet — it is a NEW file (only `enums.ts` exists in that dir
    today).
  - `apps/web/components/import/` does not exist yet — `ImportCsvPanel.tsx` is a NEW component.

---

## Task graph and briefs

Waves are `dependsOn`-ordered; tasks in the same wave have disjoint files and run in parallel. Bugfix chain
rules apply: every `fix` depends on the `root-cause` task AND a `repro-test` task; every `revert-probe` depends
on its `fix`.

### RC1 — Confirm root cause on the current tree

**type:** root-cause · **files:** (none — read-only) · **tests:** (none) · **dependsOn:** none

Reproduce both bugs on HEAD (`21085bcb`) and confirm the cause named in `cause-ruling.md` §1: (a) for B858,
show that `apps/api/src/import/import.service.ts` reads only five header families at the products read site
(≈L1670-1680) and writes via `create()` at ≈L1693-1702 with a raw `prisma.product.create`, so any other column
(e.g. "Units Per Box") is silently dropped and a name-match at ≈L1684-1691 `skip`s and `continue`s without
updating; (b) for B859, show `importContacts` (≈L214-533) never reads a commercial header at all, and its
match-update path (≈L306-406) only touches identity/contact fields. Confirm no header-normalizing layer exists
between `parseCsv` (≈L56-79) and either write site. Do not confirm any alternative cause (e.g. the dead
`importFromZoho` JSON path, or the migration-page CSV parser) — `s2-refutation.md` already ruled those out.
Report `reproduced: true, causeConfirmed: true` only if the exact line ranges and behavior match; otherwise stop
and raise a Ruling rather than guessing a different cause.

### RT1 — Repro tests (red set + pins + harness edits)

**type:** repro-test · **files:** `apps/api/src/import/import-commercial-columns.spec.ts` (new),
`apps/api/src/import/import-columns.spec.ts` (new), `apps/api/src/import/import-robustness.spec.ts`,
`apps/api/src/import/import-address-state.spec.ts`, `apps/api/src/import/import-customer-cap.spec.ts`,
`apps/api/src/import/import.security.spec.ts`, `apps/api/src/customers/customers.service.spec.ts` ·
**tests:** all of the above · **dependsOn:** RC1

Write every test in `bug-test-plan.md` (T1-T6 red set, P1-P15 pins in the two new spec files — P16's
`.db.spec.ts` companion is NOT part of this task; it is NEED-DB and out of the engine's scope entirely) plus the
harness edits listed in that plan's "Harness notes" section, in the SAME edit (a stale mock in a neighboring
suite is the classic bug-batch blocker — do not defer these edits to the fix task).

Exact `wrongValue` each RED test must fail on (the red-gate's behavioral check greps the failure output for
this):

- T1: `productsService.create` — expected `1` call, received `0`.
- T2: `result.imported` — expected `0`, received `1`.
- T3: `productsService.update` — expected `1` call, received `0`.
- T4: `customersService.update` — expected `1` call, received `0`.
- T5: `auditService.log` — expected `1` call, received `0`.
- T6: `result.skippedRows` — expected length `1`, received `undefined`.

Do not write `import-commercial-columns.db.spec.ts` (P16) — that file is authored later by whoever owns the
NEED-DB lane (per project rule: "Builders post NEED-DB first — never run DB specs on the compose stack"); post
a NEED-DB note for it instead of writing it here.

### FIX1 — Column registry module (`import-columns.ts`)

**type:** fix · **risk:** (LOW — pure module, no DB/DI) · **files:** `apps/api/src/import/import-columns.ts`
(new), `packages/types/api/import.ts` (new) · **tests:** `apps/api/src/import/import-columns.spec.ts` ·
**dependsOn:** RC1, RT1

Create `apps/api/src/import/import-columns.ts` — a pure module (no Nest decorators, no Prisma import) per
cause-ruling.md §2.A:

- `normalizeHeader(h: string): string` — lowercase, strip BOM/quotes, collapse `[\s_\-./]+` to a single space,
  trim.
- `PRODUCT_COLUMNS` registry: entries `{ field, canonical, aliases: string[], parse, gate? }` for: `name` (Item
  Name|Name|Product Name), `sku` (SKU|Item Code), `barcode` (Barcode|UPC|EAN), `unit` (Unit|Usage Unit|UOM),
  `pricePerUnit` (Rate|Sales Rate|Price|Sales Price|Selling Price), `priceTier2`..`priceTier5` (Price Tier N|
  Tier N Price), `unitsPerBox` (Units Per Box|Pack Size|Case Qty|Units/Box), `category` (Category|Item
  Category), `description`, `standardCost` (Cost|Purchase Rate|Standard Cost|Purchase Price), `msrp` (MSRP|
  Retail Price) with `gate: "msrp"`, `isTobacco` (Tobacco|Is Tobacco) with `gate: "tobacco"`, `reorderPoint`
  (Reorder Point|Reorder Level), `reorderQty`. **No `averageCost` field** — omit it entirely (pin P4); an
  "Average Cost" header must resolve to nothing and surface in `unknownColumns` (pin P5).
- `CUSTOMER_COLUMNS` registry: `businessName` (Customer Name|Display Name|Company Name), `zohoContactId`
  (Customer ID|Contact ID), the existing identity/address aliases exactly as read today in `importContacts`
  (do not change those aliases), `defaultPaymentTerms` (Payment Terms|Terms), `pricingTier` (Pricing Tier|Price
  Tier|Tier), `creditLimit` (Credit Limit), `isTaxExempt` (Tax Exempt), `taxId` (Tax ID|Tax Number|EIN),
  `tobaccoLicenseNo` (Tobacco Licence No|Tobacco License No|Tobacco Licence), `tobaccoLicenseExpiry` (Tobacco
  Licence Expiry|Tobacco License Expiry), `deliveryWindowStart`/`deliveryWindowEnd` (Delivery Window Start|End),
  `smsConsent` (SMS Consent), `waConsent` (WhatsApp Consent).
- Cell parsers, each `(raw: string) => {ok:true, value} | {ok:false, reason: string}`:
  - **blank input ⇒ always `{ok:true, value:undefined}`** regardless of parser kind (never clears an existing
    value — SA-284 pin).
  - `money`: reuse `parseImportMoney` from `./parse-import-number`; a NaN result on a NON-BLANK cell is
    `{ok:false, reason:"not a number"}` (this is the exact fix for the `|| 0` trap — cause-ruling.md §2.B /
    SA-284 (f)); a successful parse is passed through `roundMoney` from `@routeflow/pricing` before being
    returned as `value`.
  - `int(min, max)`: parse integer, range-check, bad on failure/out-of-range.
  - `bool`: case-insensitive `yes|true|1` → `true`, `no|false|0` → `false`, anything else bad — this is the ONE
    literal set shared by `isTobacco`, `isTaxExempt`, `smsConsent`, `waConsent` (SA-284 (e)).
  - `terms`: matches (case-insensitively) `due on receipt|due upon receipt|cod|0` → `"Due on Receipt"`, or
    `net ?(15|30|45|60)|n(15|30|45|60)|(15|30|45|60)` → `"Net N"`; else bad. Output must be one of the existing
    `VALID_CUSTOMER_TERMS` labels (do not invent new labels).
  - `tier`: integer 1..5.
  - `date`: `YYYY-MM-DD` or `M/D/YYYY` → a `Date` at UTC midnight; else bad.
  - `str(max)`: trim, bad only if it exceeds `max` length (mirrors existing DTO length limits, e.g. taxId ≤ 40).
- `resolveColumns(headers: string[], registry): { byField: Record<string, string /* matched raw header */>,
unknownColumns: string[] }` — normalizes every header, matches against every alias (also normalized), and
  collects headers matching nothing into `unknownColumns`.
- `parseRow(row: Record<string,string>, resolved, registry): { values: Record<string, unknown>, badCells:
{ column: string, reason: string }[] }` — for each resolved field, run its parser on the row's raw cell value;
  a `gate` field is parsed the same as any other (the file-level entitlement check happens in `ImportService`,
  not here — this module has no Nest/DI access to entitlements).

Also create `packages/types/api/import.ts` exporting `PRODUCT_IMPORT_COLUMNS` and `CUSTOMER_IMPORT_COLUMNS` —
static arrays of `{ canonical: string, aliases: string[] }` per field, one entry per registry field above (the
canonical display header + its alias list, for the web help text). `import-columns.ts` in `apps/api` imports
these same constants for its own `aliases` arrays so the two cannot drift (single source of truth lives in
`packages/types/api/import.ts`; `apps/api` re-exports/consumes it, never redeclares the alias lists).

**Must NOT change:** `parseImportMoney`/`parseImportNumber` themselves (`apps/api/src/import/parse-import-
number.ts`) — this task only changes how a NaN result from `parseImportMoney` is handled at the call site
(bad-cell instead of `|| 0`), never the parser's own contract.

### FIX2 — Products service: public gates + create options + bulk emit wrapper

**type:** fix · **risk:** HIGH (money: cost/price fields; entitlement gates) · **files:**
`apps/api/src/products/products.service.ts` · **tests:** (none of its own — proven by T1/T3 through the import
service; `products.service.spec.ts` and `products.gateway-emit.spec.ts` are pinned unchanged behavior) ·
**dependsOn:** RC1, RT1 · **radius:** [10, 20] (call sites of `create(` / `assertCanFlagTobacco` /
`assertMsrpAllowed` across the api workspace)

Three surgical changes to `apps/api/src/products/products.service.ts`:

1. Flip `private async assertMsrpAllowed()` (≈L112) and `private async assertCanFlagTobacco(isTobacco?:
boolean)` (≈L143) to `public` (drop the `private` keyword). Bodies are UNCHANGED — this is a visibility
   change only, so the importer can call the exact same gate the manual-edit path uses instead of duplicating
   gate logic.
2. `async create(dto: CreateProductDto)` (≈L507) gains an optional second parameter, mirroring `update`'s
   existing shape (≈L722 `update(id, dto, options?: { suppressEmit?: boolean })`):
   ```ts
   async create(dto: CreateProductDto, options?: { suppressEmit?: boolean }) {
     // ...existing body unchanged...
     // at the existing `this.emitProductChanged(created.id, "created");` call site:
     if (!options?.suppressEmit) this.emitProductChanged(created.id, "created");
     return created;
   }
   ```
   Every existing caller of `create(dto)` (no second arg) is unaffected — `options` defaults to `undefined`,
   `!undefined?.suppressEmit` is `true`, so the emit still fires exactly as today.
3. Add a new one-line public method next to `emitProductChanged` (≈L93):
   ```ts
   /** Public wrapper so a bulk-write caller (e.g. CSV import) can fire ONE coalesced
    * catalog-changed event after its own loop, instead of one per row. */
   emitCatalogBulkChanged(): void {
     this.emitProductChanged(null, "bulk");
   }
   ```

**Must NOT change:** the bodies of `assertMsrpAllowed`/`assertCanFlagTobacco`, any existing `create`/`update`
call site's behavior when `options` is omitted, `resolveCostingMethod`, any pricing/AVCO logic, the existing
private `emitProductChanged` signature.

### FIX3 — Customers service: `update` gains `options.compliance`

**type:** fix · **risk:** HIGH (tenancy/PII: tax id, tobacco licence, consent) · **files:**
`apps/api/src/customers/customers.service.ts`, `apps/api/src/customers/customer-compliance-input.ts` (new) ·
**tests:** (none of its own — proven by T4/T5 through the import service; pin added to
`customers.service.spec.ts` in RT1) · **dependsOn:** RC1, RT1 · **radius:** [10, 20] (call sites of
`customersService.update(`)

Create `apps/api/src/customers/customer-compliance-input.ts`:

```ts
export interface CustomerComplianceInput {
  tobaccoLicenseNo?: string;
  tobaccoLicenseExpiry?: Date | null;
  smsConsent?: boolean;
  waConsent?: boolean;
  consentUpdatedAt?: Date;
}
```

Change `async update(id: string, dto: UpdateCustomerDto)` (≈L767) to `async update(id: string, dto:
UpdateCustomerDto, options?: { compliance?: CustomerComplianceInput })`. After the existing `deletedAt` guard
and before/alongside the existing `data: { ...(dto.xxx...) }` spread, merge in the compliance fields when
present:

```ts
return this.prisma.forTenant().customer.update({
  where: { id },
  data: {
    ...(dto.businessName && { businessName: dto.businessName }),
    // ...ALL existing spread lines, unchanged...
    ...(options?.compliance?.tobaccoLicenseNo !== undefined && {
      tobaccoLicenseNo: options.compliance.tobaccoLicenseNo,
    }),
    ...(options?.compliance?.tobaccoLicenseExpiry !== undefined && {
      tobaccoLicenseExpiry: options.compliance.tobaccoLicenseExpiry,
    }),
    ...(options?.compliance?.smsConsent !== undefined && {
      smsConsent: options.compliance.smsConsent,
    }),
    ...(options?.compliance?.waConsent !== undefined && {
      waConsent: options.compliance.waConsent,
    }),
    ...(options?.compliance?.consentUpdatedAt !== undefined && {
      consentUpdatedAt: options.compliance.consentUpdatedAt,
    }),
  },
});
```

`UpdateCustomerDto`/`CreateCustomerDto` are NOT touched (L-181) — compliance data flows only through
`options`, so no HTTP surface (the controller never passes `options`) can reach `tobaccoLicenseNo`,
`tobaccoLicenseExpiry`, `smsConsent`, or `waConsent` regardless of whitelist config. **Do not add these fields
to any DTO.**

**Confirm before use in FIX4:** `tobaccoLicenseNo`, `tobaccoLicenseExpiry`, `smsConsent`, `waConsent`,
`consentUpdatedAt` are Customer model columns already present in the Prisma schema (per
`sa-284-ruling.md`'s facts: `Customer.consentUpdatedAt` at `sales.prisma:180`; the others exist per
`s2-refutation.md` fact 5 as read-only-so-far fields) — this task performs NO migration; if any field name
above does not match the schema exactly, stop and raise a Ruling rather than guessing a column name.

**Must NOT change:** `create()`'s geocoding behavior, `update()`'s existing address-field geocode trigger
(≈L889/L949 — untouched, `options.compliance` never includes an address field so this call path structurally
cannot geocode), the DTO validators, the `deletedAt` guard.

### FIX4 — Import service, controller, module: plan-then-apply

**type:** fix · **risk:** HIGH (money math, tenancy, entitlement bypass) · **files:**
`apps/api/src/import/import.service.ts`, `apps/api/src/import/import.controller.ts`,
`apps/api/src/import/import.module.ts` · **tests:** (none of its own — proven by T1-T6 + all pins) ·
**dependsOn:** FIX1, FIX2, FIX3

**`import.module.ts`**: add `ProductsModule` and `AuditModule` to `imports: [...]` (both already export the
services this task's constructor needs — `ProductsModule` exports `ProductsService`, `AuditModule` is
`@Global()` and exports `AuditService`). This is the DI-graph change project CLAUDE.md's `L-113` flags — the
compose boot gate (`npm run local:up && npm run local:validate`) must pass before this branch pushes.

**`import.service.ts`** constructor (≈L48) gains `ProductsService` and `AuditService`:

```ts
constructor(
  private readonly prisma: PrismaService,
  private readonly vendorBills: VendorBillsService,
  private readonly customersService: CustomersService,
  private readonly numbering: NumberingService,
  private readonly externalRef: ExternalRefService,
  private readonly productsService: ProductsService,
  private readonly auditService: AuditService,
) {}
```

Rewrite `importProducts(buffer: Buffer, userId: string, opts?: { dryRun?: boolean; fileName?: string })` and
`importContacts(buffer: Buffer, userId: string, opts?: { dryRun?: boolean; fileName?: string })` — SAME
external signatures plus the new optional `opts` (every existing caller passing 2 args keeps working) — as a
plan-then-apply pipeline per cause-ruling.md §2.B:

1. `parseCsv` (unchanged) → resolve headers via `resolveColumns(headers, PRODUCT_COLUMNS | CUSTOMER_COLUMNS)`.
2. **File-level gate, BEFORE any write-capable query:** if `byField.msrp` is set, call
   `this.productsService.assertMsrpAllowed()`; if `byField.isTobacco` is set, call
   `this.productsService.assertCanFlagTobacco(true)`. Catch a thrown `ForbiddenException` and rethrow
   `new ForbiddenException(\`Column "${matchedHeaderName}" needs tobacco_dealer add-on | the MSRP plan
   flag; remove the column or enable it\`)`— identical wording whether`dryRun` is true or false (pins P6/P7).
3. Preload matching keys in ONE tenant-scoped `findMany`: products —
   `this.prisma.forTenant().product.findMany({ select: { id, name, sku, barcode, unitsPerBox, ...every
registry field needed for diffing } })`; customers — `this.prisma.forTenant().customer.findMany({ where: {
deletedAt: null }, select: { id, businessName, zohoContactId, ...registry fields } })`.
4. Per row: `parseRow` → any `badCells` ⇒ `action: "skip"`, `reason: "<Column>: <reason>"` from the FIRST bad
   cell (never a partial row — a row with any bad cell writes nothing). Else run matching:
   - **Products:** exact trimmed SKU → exact barcode → normalized name (lower, collapsed spaces) unique in
     tenant. 2+ name hits ⇒ skip `"ambiguous name (N matches)"`. A row hitting a key an earlier row in the SAME
     file already claimed ⇒ skip `"duplicate of row N"`.
   - **Customers:** `zohoContactId` → normalized `businessName`, same ambiguous/duplicate rules.
   - No match ⇒ `action: "create"`; match ⇒ `action: "update"`.
5. Build `changes` (update rows only): for each parsed field with a DEFINED value that differs from the
   existing row's value (money compared after `roundMoney`, strings trimmed) — blank/undefined parsed values
   are OMITTED from `changes` entirely (blank never clears). **`unitsPerBox` special case (SA-284 d):** written
   into `changes` only when existing is `null` OR this is a create; when existing is non-null and differs from
   the row value, the WHOLE ROW is skipped with reason exactly `"pack changes are made in the product editor"`
   (not merged into a partial update); when existing equals the row value, omit from `changes` (no diff).
   An update row whose final `changes` is `{}` is NOT counted in `updated` — count it as `unchanged` (new
   result field) instead.
6. `opts?.dryRun` ⇒ return the built plan (`rows: RowPlan[]`) with zero writes. Otherwise apply sequentially,
   row by row.
7. **Products apply:** create → `this.productsService.create(dto, { suppressEmit: true })`; update (non-empty
   changes only) → `this.productsService.update(id, changes, { suppressEmit: true })`. After the full loop, if
   `created + updated > 0`, call `this.productsService.emitCatalogBulkChanged()` exactly once. `standardCost` is
   the only cost field ever written (never `averageCost` — it is not in the registry at all, so this is
   structural, not a runtime check). A create row with a blank/missing `Rate` skips: `"Rate is required for a
new product"`. Catch `HttpException` from the service and use its `.message` as the row's skip reason
   (these messages are already user-safe); any other error goes through the existing `pushRowError` (redaction
   preserved) with reason `"import failed"`.
8. **Customers apply:** the existing identity/address/contactPerson create+patch code (≈L322-512) is UNCHANGED
   — it is not the defect (`s2-refutation.md` confirms it already works on match), and F4/the customer-cap spec
   pin it. For BOTH created and matched rows, additionally call
   `this.customersService.update(id, diff, { compliance })` where `diff` is a `Partial<UpdateCustomerDto>`
   built from `defaultPaymentTerms`/`pricingTier`/`creditLimit`/`isTaxExempt`/`taxId` (only defined-and-changed
   fields) and `compliance` is a `CustomerComplianceInput` built from `tobaccoLicenseNo`/`tobaccoLicenseExpiry`/
   `smsConsent`/`waConsent` (same defined-and-changed rule). **Consent evidence:** only when `smsConsent` or
   `waConsent` is defined AND differs from the existing value, set `compliance.consentUpdatedAt = new Date()`
   and call:
   ```ts
   await this.auditService.log({
     tenantId: this.prisma.getTenantId(),
     userId,
     action: "customer.consent.import",
     entityType: "Customer",
     entityId: customerId,
     meta: {
       source: "import",
       fileName: opts?.fileName,
       row: rowNumber,
       channel: "sms" | "wa",
       value: parsedBooleanValue,
       timestamp: new Date().toISOString(),
     },
   });
   ```
   — one call per channel actually changed (0, 1, or 2 calls per row). Past `tobaccoLicenseExpiry` (compared to
   `new Date()`) does NOT skip the row — it imports normally and the row's `warnings` array gets
   `"Tobacco licence expired <date>"`.
9. **Result shape:** products — `{ imported: number /* = created */, created, updated, unchanged, skipped,
errors: string[] /* unchanged shape, mirrors skip reasons as "<label>: <reason>" */, rows: RowPlan[],
skippedRows: { row: number, label: string, reason: string }[], warnings: string[], unknownColumns: string[],
dryRun: boolean }`; contacts — identical shape MINUS `imported`.

**`import.controller.ts`**: both `importProducts`/`importContacts` handler methods (≈L28-34) gain
`@Query("dryRun") dryRun?: string` and pass `{ dryRun: dryRun === "true", fileName: file.originalname }` as the
new third argument to the service call — e.g.:

```ts
@Post("contacts")
@HttpCode(HttpStatus.OK)
@UseInterceptors(FileInterceptor("file", { limits: uploadLimits(MB(10)) }))
importContacts(
  @UploadedFile() file: Express.Multer.File,
  @CurrentUser() user: JwtPayload,
  @Query("dryRun") dryRun?: string,
) {
  if (!file) throw new BadRequestException("No file uploaded");
  return this.importService.importContacts(file.buffer, user.sub, {
    dryRun: dryRun === "true",
    fileName: file.originalname,
  });
}
```

Same pattern for the products import route (find its exact route/method name in `import.controller.ts` before
editing — it is not in the excerpt read for this plan; it sits among the other `@Post(...)` handlers in the
same file, follows the identical `FileInterceptor` + `@CurrentUser` shape as `importContacts` above).

**Must NOT change:** `importInvoices`, `importPayments`, `importExpenses`, and every other route/method in
`import.controller.ts`/`import.service.ts` not named above; `parseCsv`; `pushRowError`'s redaction behavior;
`MAX_IMPORT_ROWS`; the cap gate placement (`assertCustomerCapNotExceeded`/`maybeStartCustomerGrace` calls stay
exactly where they are today relative to the row loop).

**Invariant this task must preserve:** every value the importer persists reaches the DB through
`ProductsService`/`CustomersService` write methods (no `prisma.forTenant().product.create` /
`tx.customer.create` call remains inside `importProducts`/`importContacts`), and a cell that cannot be parsed
never becomes a written value.

### FIX5 — Web: `ImportCsvPanel` + its two call sites

**type:** fix · **risk:** (LOW — presentation only, no money/tenancy logic of its own) · **files:**
`apps/web/components/import/ImportCsvPanel.tsx` (new), `apps/web/components/import/ImportCsvPanel.test.tsx`
(new), `apps/web/app/(dashboard)/settings/import/page.tsx`, `apps/web/app/(dashboard)/customers/page.tsx` ·
**tests:** `apps/web/components/import/ImportCsvPanel.test.tsx` · **dependsOn:** FIX4

Create `apps/web/components/import/ImportCsvPanel.tsx`: a reusable panel taking `{ endpoint: string, title:
string, columns: { canonical: string; aliases: string[] }[] }` (columns sourced from
`PRODUCT_IMPORT_COLUMNS`/`CUSTOMER_IMPORT_COLUMNS` in `packages/types/api/import.ts`, imported via
`@routeflow/types`). Flow: file picked → "Preview" button calls `apiClient.post(\`${endpoint}?dryRun=true\`,
formData)`→ renders a table of`rows`(action/changes/reason per row),`warnings`, `unknownColumns`→ "Import"
button calls the same endpoint with`dryRun=false`, then shows the final counts. A `403` response (gate
refusal) renders as a blocking error banner with the response body's message verbatim (already user-safe per
FIX4's ForbiddenException wording) — no retry-without-the-column affordance, just the message and a way to
re-pick a file.

Wire it into `apps/web/app/(dashboard)/settings/import/page.tsx`'s existing product/contact import cards
(replacing whatever inline upload UI currently drives `endpoint`/`ImportSection` for those two cards — leave
every OTHER import card, e.g. invoices/payments/expenses, exactly as-is) and into
`apps/web/app/(dashboard)/customers/page.tsx`'s `ImportCustomersModal` (≈L80) — the modal gets the SAME preview
step (ruled: one renderer for one result shape, not a second bespoke UI for the modal).

**Must NOT change:** any other card/section on the settings/import page; the customers page's non-import
modals/table; `apiClient`'s shared request wrapper.

---

### RP1 — Revert-probe: `import-columns.ts` money parser

**type:** revert-probe · **file:** `apps/api/src/import/import-columns.ts` · **test:**
`cd apps/api && npx jest src/import/import-commercial-columns.spec.ts -t "REG-B858-2" --maxWorkers=2
--reporters=default` · **dependsOn:** FIX4

Reverting the `money` parser back to `parseImportMoney(...) || 0` semantics must turn T2 (REG-B858-2) red.

### RP2 — Revert-probe: `import.service.ts` products block

**type:** revert-probe · **file:** `apps/api/src/import/import.service.ts` · **test:**
`cd apps/api && npx jest src/import/import-commercial-columns.spec.ts -t "REG-B858-1|REG-B858-3"
--maxWorkers=2 --reporters=default` · **dependsOn:** FIX4

Reverting the products half of `import.service.ts`'s plan-then-apply rewrite must turn T1 and T3 red.

### RP3 — Revert-probe: `import.service.ts` contacts block

**type:** revert-probe · **file:** `apps/api/src/import/import.service.ts` · **test:**
`cd apps/api && npx jest src/import/import-commercial-columns.spec.ts -t "REG-B859-1|REG-B859-3"
--maxWorkers=2 --reporters=default` · **dependsOn:** FIX4

Reverting the contacts half must turn T4 and T6 red. (Note: RP2 and RP3 name the SAME file — the engine's
`revert-probe` runs strictly sequentially across probes per dev-pipeline's own execution model, so this is
safe; each probe backs up, reverts, tests, and restores before the next one starts.)

### RP4 — Revert-probe: `customers.service.ts` compliance spread

**type:** revert-probe · **file:** `apps/api/src/customers/customers.service.ts` · **test:**
`cd apps/api && npx jest src/import/import-commercial-columns.spec.ts -t "REG-B859-2" --maxWorkers=2
--reporters=default` · **dependsOn:** FIX4

Dropping the `options.compliance` spread out of `update()` must turn T5 red.

`apps/api/src/products/products.service.ts` needs no revert-probe (cause-ruling.md §7: "visibility/options
only; pinned by T1 through the service" — its own behavior is unchanged, only reachable through the new call
path). Web files need no revert-probe — Playwright captures are the proof (cause-ruling.md §7).

---

## Docs (deferred, not a task)

The runbook §5 update and the bug-registry close + lessons-learned entry are explicitly NOT tasks in this
build. Per project CLAUDE.md (Bookkeeping Option B, owner ruling 2026-09-05), they land in the docs-only
follow-up PR the landing coordinator opens right after this code PR merges, citing the merged sha; the runbook
update additionally waits on #2154 (`docs/wholesaler-onboarding: playbook`) landing first, per
`sa-284-ruling.md`.

---

## Package map

| Task | type         | dependsOn        | Wave                    |
| ---- | ------------ | ---------------- | ----------------------- |
| RC1  | root-cause   | —                | 1                       |
| RT1  | repro-test   | RC1              | 1 (pipelined after RC1) |
| FIX1 | fix          | RC1, RT1         | 2                       |
| FIX2 | fix          | RC1, RT1         | 2                       |
| FIX3 | fix          | RC1, RT1         | 2                       |
| FIX4 | fix          | FIX1, FIX2, FIX3 | 3                       |
| FIX5 | fix          | FIX4             | 4                       |
| RP1  | revert-probe | FIX4             | 5                       |
| RP2  | revert-probe | FIX4             | 5                       |
| RP3  | revert-probe | FIX4             | 5                       |
| RP4  | revert-probe | FIX4             | 5                       |

FIX1/FIX2/FIX3 files are disjoint (`import-columns.ts`+`packages/types/api/import.ts` /
`products.service.ts` / `customers.service.ts`+`customer-compliance-input.ts`) — wave 2 runs in parallel.
RP1-RP4 all depend only on FIX4 but the engine's revert-probe execution model runs probes strictly
sequentially regardless of wave grouping (shared `checksum:after`, cause-ruling.md §7).

---

## Raised to Fable

None — every field, signature, gate, and file path needed to fill this plan was either stated explicitly in
`cause-ruling.md`/`sa-284-ruling.md`/`rulings-s4-s5.md` or directly confirmed by reading the current tree
(`import.service.ts`, `products.service.ts`, `customers.service.ts`, `audit.service.ts`, `import.module.ts`,
`products.module.ts`, `customers.module.ts`, `import.controller.ts`, both web call-site files, and
`apps/api`/`apps/web`/root `package.json` scripts). One item the FIX4 brief flags inline rather than raising
here: the products-import controller route's exact handler name was not in the excerpt read while drafting
this plan — the brief tells the implementer to locate it directly in `import.controller.ts` next to
`importContacts`, which is a repo-read, not a judgment call.

---

## Pipeline args

```js
{
  buildPlanPath: '.claude/pipeline/2026-09-25-b858-b859-importer-columns/build-plan.md',
  testPlanPath: '.claude/pipeline/2026-09-25-b858-b859-importer-columns/bug-test-plan.md',
  scriptsDir: '/Users/maznahamanullah/.claude/skills/dev-pipeline/scripts',
  lessonsPath: '.claude/lessons/LESSONS.md',
  startedAt: 'TBD-at-launch',
  runDir: '.claude/pipeline/2026-09-25-b858-b859-importer-columns',
  scale: 'major',
  mode: 'bugfix',
  profile: 'standard',
  workdir: '/Users/maznahamanullah/code/routeflow/.claude/worktrees/focused-knuth-179e2b',
  context: 'B858/B859: import.service.ts hard-codes a 5-header set and writes via raw prisma create, dropping every other commercial column; fix makes both importers plan-then-apply through ProductsService/CustomersService.',

  siblingPatterns: [
    {
      pattern: 'parseImport(Money|Number)\\([^)]*\\)\\s*\\|\\|\\s*0',
      note: 'the same NaN-to-$0 trap this fix removes from importProducts/importContacts — a hit elsewhere (e.g. invoices/payments importers) is the same defect class and gets filed to the bug registry, not fixed in this PR',
    },
    {
      pattern: 'prisma\\.forTenant\\(\\)\\.product\\.create\\(',
      note: 'a raw prisma product-create outside importFromZoho (the dead path this PR leaves alone) is a guard bypass of the same shape this fix closes',
    },
  ],

  tasks: [
    { id: 'RC1', title: 'Confirm root cause on the current tree', type: 'root-cause', files: [], tests: [], dependsOn: [] },
    {
      id: 'RT1',
      title: 'Repro tests (red set + pins + harness edits)',
      type: 'repro-test',
      files: [
        'apps/api/src/import/import-commercial-columns.spec.ts',
        'apps/api/src/import/import-columns.spec.ts',
        'apps/api/src/import/import-robustness.spec.ts',
        'apps/api/src/import/import-address-state.spec.ts',
        'apps/api/src/import/import-customer-cap.spec.ts',
        'apps/api/src/import/import.security.spec.ts',
        'apps/api/src/customers/customers.service.spec.ts',
      ],
      tests: [
        'apps/api/src/import/import-commercial-columns.spec.ts',
        'apps/api/src/import/import-columns.spec.ts',
      ],
      dependsOn: ['RC1'],
    },
    {
      id: 'FIX1',
      title: 'Column registry module (import-columns.ts)',
      type: 'fix',
      files: ['apps/api/src/import/import-columns.ts', 'packages/types/api/import.ts'],
      tests: [],
      dependsOn: ['RC1', 'RT1'],
    },
    {
      id: 'FIX2',
      title: 'Products service: public gates + create options + bulk emit wrapper',
      type: 'fix',
      files: ['apps/api/src/products/products.service.ts'],
      tests: [],
      dependsOn: ['RC1', 'RT1'],
      risk: 'HIGH',
      radius: [10, 20],
    },
    {
      id: 'FIX3',
      title: 'Customers service: update gains options.compliance',
      type: 'fix',
      files: ['apps/api/src/customers/customers.service.ts', 'apps/api/src/customers/customer-compliance-input.ts'],
      tests: [],
      dependsOn: ['RC1', 'RT1'],
      risk: 'HIGH',
      radius: [10, 20],
    },
    {
      id: 'FIX4',
      title: 'Import service, controller, module: plan-then-apply',
      type: 'fix',
      files: [
        'apps/api/src/import/import.service.ts',
        'apps/api/src/import/import.controller.ts',
        'apps/api/src/import/import.module.ts',
      ],
      tests: [],
      dependsOn: ['FIX1', 'FIX2', 'FIX3'],
      risk: 'HIGH',
    },
    {
      id: 'FIX5',
      title: 'Web: ImportCsvPanel + its two call sites',
      type: 'fix',
      files: [
        'apps/web/components/import/ImportCsvPanel.tsx',
        'apps/web/components/import/ImportCsvPanel.test.tsx',
        'apps/web/app/(dashboard)/settings/import/page.tsx',
        'apps/web/app/(dashboard)/customers/page.tsx',
      ],
      tests: ['apps/web/components/import/ImportCsvPanel.test.tsx'],
      dependsOn: ['FIX4'],
    },
    {
      id: 'RP1',
      title: 'Revert-probe: import-columns.ts money parser',
      type: 'revert-probe',
      file: 'apps/api/src/import/import-columns.ts',
      test: 'cd apps/api && npx jest src/import/import-commercial-columns.spec.ts -t "REG-B858-2" --maxWorkers=2 --reporters=default',
      dependsOn: ['FIX4'],
    },
    {
      id: 'RP2',
      title: 'Revert-probe: import.service.ts products block',
      type: 'revert-probe',
      file: 'apps/api/src/import/import.service.ts',
      test: 'cd apps/api && npx jest src/import/import-commercial-columns.spec.ts -t "REG-B858-1|REG-B858-3" --maxWorkers=2 --reporters=default',
      dependsOn: ['FIX4'],
    },
    {
      id: 'RP3',
      title: 'Revert-probe: import.service.ts contacts block',
      type: 'revert-probe',
      file: 'apps/api/src/import/import.service.ts',
      test: 'cd apps/api && npx jest src/import/import-commercial-columns.spec.ts -t "REG-B859-1|REG-B859-3" --maxWorkers=2 --reporters=default',
      dependsOn: ['FIX4'],
    },
    {
      id: 'RP4',
      title: 'Revert-probe: customers.service.ts compliance spread',
      type: 'revert-probe',
      file: 'apps/api/src/customers/customers.service.ts',
      test: 'cd apps/api && npx jest src/import/import-commercial-columns.spec.ts -t "REG-B859-2" --maxWorkers=2 --reporters=default',
      dependsOn: ['FIX4'],
    },
  ],

  redGate: {
    commands: [
      'cd apps/api && npx jest src/import/import-commercial-columns.spec.ts src/import/import-columns.spec.ts -t "REG-B85[89]" --maxWorkers=2 --reporters=default',
    ],
  },

  verifyCommands: {
    perRound: [
      'cd apps/api && npx jest src/import src/products/products.gateway-emit.spec.ts src/products/products.service.spec.ts src/customers/customers.service.spec.ts --maxWorkers=2 --reporters=default',
      'npx tsc --noEmit -p apps/api/tsconfig.json',
    ],
    final: [
      'cd apps/api && npx jest src/import src/products/products.gateway-emit.spec.ts src/products/products.service.spec.ts src/customers/customers.service.spec.ts --maxWorkers=2 --reporters=default --passWithNoTests',
      'npm run check-types -w apps/api -w apps/web',
      'npm run lint -w apps/api -w apps/web',
      'npm test -w apps/web -- ImportCsvPanel --maxWorkers=2 --reporters=default',
    ],
  },

  // Never run repo-wide `npm run format` (reference_engine_format_step_dirties_worktrees_2026-09-14 —
  // it reformats ~130 unrelated files). Format only the files this run actually touched.
  formatCommand: 'npx prettier --write',
}
```

**Not part of the engine run — separate lanes per project CLAUDE.md and the rulings:**

- `apps/api/src/import/import-commercial-columns.db.spec.ts` (pin P16) — NEED-DB, runs only via
  `npm run local:test:db` against the compose Postgres, never inside this pipeline.
- `npm run local:up && npm run local:validate` (L-113 compose boot gate) — required once before push because
  FIX4 changes `ImportModule`'s DI graph; run manually after the pipeline reports `clean`.
- Playwright captures (1440/768/390 — preview, gate refusal, and result states) to
  `local-assets/proofs/` — per project CLAUDE.md's UI-proof rule; run after FIX5 lands, outside the engine.
