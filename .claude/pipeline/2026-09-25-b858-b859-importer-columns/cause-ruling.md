# Fix ruling — B858 + B859 importer-commercial-columns

> Fable @ high, 2026-09-25, base 21085bcb. SA-284 binding; where silent, ruled here. S2 verdict: **CONFIRMED
> (both)** — B858: `import.service.ts:1670-1680` reads five header families, `create()` 1693-1702 writes five
> fields; name-match skips silently. B859: `importContacts` 214-533 reads no commercial header; match updates
> identity only. Plus: silent skips, `parseImportMoney(...)||0`, CSV path bypasses ProductsService guards.

## 1. Cause verdict

**Accepted cause**: both importers hard-code the header set at the read site (`row["Item Name"]…`, 1670-1680 /
232-298) with no column registry between `parseCsv` and the write, so every unlisted header is dropped with no
signal, and the write is raw `prisma.product.create` / `tx.customer.create`, so the service guards and update-on-
match never run. The dead JSON path is not the cause and stays dead (its removal = own PR, SA-284).

## 2. Fix design

**A. New pure module `apps/api/src/import/import-columns.ts`** (no Nest, no prisma).

- `normalizeHeader(h)`: lowercase, strip BOM/quotes, collapse `[\s_\-./]+` → single space, trim.
- Registries `PRODUCT_COLUMNS` / `CUSTOMER_COLUMNS`: `{ field, canonical, aliases[], parse, gate? }`.
  Products: name(Item Name|Name|Product Name), sku(SKU|Item Code), barcode(Barcode|UPC|EAN), unit(Unit|Usage
  Unit|UOM), pricePerUnit(Rate|Sales Rate|Price|Sales Price|Selling Price), priceTier2..5(Price Tier N|Tier N
  Price), unitsPerBox(Units Per Box|Pack Size|Case Qty|Units/Box), category(Category|Item Category), description,
  standardCost(Cost|Purchase Rate|Standard Cost|Purchase Price), msrp(MSRP|Retail Price) `gate:"msrp"`,
  isTobacco(Tobacco|Is Tobacco) `gate:"tobacco"`, reorderPoint(Reorder Point|Reorder Level), reorderQty.
  Customers: businessName(Customer Name|Display Name|Company Name), zohoContactId(Customer ID|Contact ID), the
  existing identity/address set (aliases exactly as read today), defaultPaymentTerms(Payment Terms|Terms),
  pricingTier(Pricing Tier|Price Tier|Tier), creditLimit(Credit Limit), isTaxExempt(Tax Exempt), taxId(Tax ID|
  Tax Number|EIN), tobaccoLicenseNo(Tobacco Licence No|Tobacco License No|Tobacco Licence), tobaccoLicenseExpiry
  (Tobacco Licence Expiry|Tobacco License Expiry), deliveryWindowStart/End(Delivery Window Start|End),
  smsConsent(SMS Consent), waConsent(WhatsApp Consent). **No `averageCost` field exists in either registry**;
  "Average Cost" is an unknown column.
- Cell parsers `(raw) => {ok:true,value} | {ok:false,reason}`; **blank ⇒ `{ok:true,value:undefined}` (never
  clears, SA-284)**: `money` = `parseImportMoney`; NaN on a non-blank cell ⇒ bad ("not a number"); value already
  `roundMoney`'d; `int(min,max)`; `bool` = yes/true/1 → true, no/false/0 → false (case-insens.), else bad — the
  one literal set for isTobacco/isTaxExempt/consent (SA-284 e); `terms` → `VALID_CUSTOMER_TERMS` label:
  `due on receipt|due upon receipt|cod|0` → "Due on Receipt", `net ?(15|30|45|60)|n(15|30|45|60)|(15|30|45|60)`
  → "Net N", else bad; `tier` = int 1..5; `date` = `YYYY-MM-DD` or `M/D/YYYY` → `Date` (UTC midnight), else bad;
  `str(max)` trims.
- `resolveColumns(headers, registry) → { byField, unknownColumns }`; `parseRow(row, resolved, registry) →
{ values, badCells: [{column, reason}] }`.

**B. `ImportService` becomes plan-then-apply** (`import.service.ts`; ctor gains `ProductsService` + `AuditService`;
`import.module.ts` imports `ProductsModule`/`AuditModule` — DI change ⇒ L-113 compose boot gate mandatory).

- Signatures: `importProducts(buffer, userId, opts?: { dryRun?: boolean; fileName?: string })`, same for
  `importContacts`. Existing callers/specs unchanged.
- Step 1 resolve columns. Step 2 **file-level gate (SA-284 b), before any query that writes**: if a gated column
  is present in the header, call `productsService.assertCanFlagTobacco(true)` / `assertMsrpAllowed()` (both
  flipped `private` → public, bodies untouched); a throw is rethrown as `ForbiddenException(\`Column "<header>"
  needs <tobacco_dealer add-on | the MSRP plan flag>; remove the column or enable it\`)`— identical in preview
and import. Step 3 preload matching keys in ONE tenant-scoped`findMany`(products: id, name, sku, barcode,
unitsPerBox + every registry field for diffs; customers:`deletedAt:null`, id, businessName, zohoContactId +
registry fields). Step 4 per row build a `RowPlan = {row, label, action:"create"|"update"|"skip", changes?:
  Record<field,{from,to}>, reason?, warnings?: string[]}`; any bad cell ⇒ `skip`with`"<Column>: <reason>"`(never a partial row). Step 5`dryRun` ⇒ return the plan, zero writes. Step 6 apply sequentially per row.
- **Matching** — products: exact trimmed SKU → exact barcode → normalized name (lower, collapsed spaces) unique
  in tenant; 2+ name hits ⇒ skip "ambiguous name (N matches)"; a second file row hitting a key an earlier row
  already claimed ⇒ skip "duplicate of row N". Customers: `zohoContactId` → normalized businessName, same rules.
- **Update diff**: `changes` holds only fields whose parsed value is defined AND differs from existing (money
  compared after `roundMoney`; strings trimmed). Empty diff ⇒ `action:"update"` with `changes:{}` counted in
  `updated` only when non-empty; else counted as `unchanged` (new count). **unitsPerBox (SA-284 d)**: written on
  create or when existing is null; existing non-null ≠ row ⇒ skip with the exact reason
  `"pack changes are made in the product editor"`; equal ⇒ omitted from diff.
- **Products apply**: create → `productsService.create(dto, { suppressEmit: true })` (create gains the same
  optional `options` update already has); update → `productsService.update(id, diff, { suppressEmit: true })`;
  after the loop, if created+updated > 0, ONE `productsService.emitCatalogBulkChanged()` (new 1-line public
  wrapper over `emitProductChanged(null,"bulk")`). `standardCost` is the only cost written. New-product rows
  with a blank Rate skip: "Rate is required for a new product" (a $0 catalog row is the B858 trap in another
  coat). An `HttpException` from the service becomes that row's skip reason (its message is safe); anything else
  goes through `pushRowError` (redaction kept) and the row is skipped with "import failed".
- **Customers apply**: the pre-existing identity/address/contactPerson create+patch code (322-512) is **not
  rewritten** in this PR — it is not the defect and F4/cap specs pin it. Commercial fields, for created AND
  matched rows, go through `customersService.update(id, diff, { compliance })` — `update()` with no address
  fields never geocodes (geocode lives in create-with-addresses/addAddress/updateAddress), so geocoding stays
  OUT with no flag. `diff` is `Partial<UpdateCustomerDto>` (defaultPaymentTerms, pricingTier, creditLimit,
  isTaxExempt, taxId, deliveryWindowStart/End). **DTOs are NOT widened** (L-181): `CustomersService.update(id,
dto, options?: { compliance?: CustomerComplianceInput })` with `CustomerComplianceInput = { tobaccoLicenseNo?,
tobaccoLicenseExpiry?: Date|null, smsConsent?, waConsent?, consentUpdatedAt? }` exported from
  `customers/customer-compliance-input.ts`; `update()` spreads defined keys into `data`. The controller never
  passes `options`, so HTTP cannot reach these regardless of whitelist config.
- **Consent evidence**: only when `smsConsent`/`waConsent` is defined and differs: `consentUpdatedAt = now` in
  `compliance`, then `auditService.log({ tenantId: prisma.getTenantId(), userId, action:
"customer.consent.import", entityType: "Customer", entityId, meta: { source:"import", fileName, row, channel:
"sms"|"wa", value, timestamp } })` — one row per channel changed. Past `tobaccoLicenseExpiry` ⇒ row imports,
  `warnings` gets "Tobacco licence expired <date>".
- **Result**: products `{ imported (=created), created, updated, unchanged, skipped, errors (unchanged shape),
rows: RowPlan[], skippedRows: {row,label,reason}[], warnings: string[], unknownColumns: string[], dryRun }`;
  contacts identical minus `imported`. Skip reasons also mirror into `errors` as `"<label>: <reason>"` so old
  renderers still show them.
- **Controller**: `@Query("dryRun") dryRun?: string` ⇒ `{ dryRun: dryRun === "true", fileName: file.originalname }`
  on both routes.

**C. Web** — new `apps/web/components/import/ImportCsvPanel.tsx` (endpoint, title, column help from a static
list of canonical headers per registry mirrored in `packages/types/api/import.ts` as `PRODUCT_IMPORT_COLUMNS` /
`CUSTOMER_IMPORT_COLUMNS` — the api registry imports the same constants so the two cannot drift): Preview
(`?dryRun=true`) → table of rows with action/changes/reason, warnings, unknown columns, then Import. Used by
both `settings/import/page.tsx` cards and the `customers/page.tsx` modal (ruled: the modal gets preview too —
one renderer for one result shape). Gate refusal (403 message) renders as a blocking error.

**Must NOT change**: invoices/payments/inventory/expense importers, `importFromZoho`, `parseCsv`, `pushRowError`,
`MAX_IMPORT_ROWS`, the cap gate placement, address-state fields, DTO validators, any prisma schema (no migration).

**Invariant preserved**: every value the importer persists reached the DB through `ProductsService`/
`CustomersService` write methods, and a cell that cannot be parsed never becomes a written value.

## 3. Regression tests (full table + pins: rulings-s4-s5.md)

| T#  | REG token  | Fails TODAY on                                                       | Passes after fix on                                                                    |
| --- | ---------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| T1  | REG-B858-1 | `productsService.create` calls: expected 1 received 0 (raw prisma)   | called with `unitsPerBox:12, priceTier2:9.5, barcode, category, standardCost`          |
| T2  | REG-B858-2 | Rate "12abc": `imported` expected 0 received 1 (price 0)             | skippedRows[0].reason ~ /Rate.*not a number/                                           |
| T3  | REG-B858-3 | SKU match, differing name: `update` calls expected 1 received 0      | update(id,{priceTier2:9.5})                                                            |
| T4  | REG-B859-1 | `customersService.update` calls expected 1 received 0                | `{defaultPaymentTerms:"Net 30",pricingTier:3,creditLimit:1500,isTaxExempt:true,taxId}` |
| T5  | REG-B859-2 | `auditService.log` calls expected 1 received 0                       | options.compliance + audit meta source "import"                                        |
| T6  | REG-B859-3 | Pricing Tier "9": `skippedRows` expected length 1 received undefined | reason ~ /Pricing Tier/                                                                |

## 4. Blast radius (`radius: [before, after]`)

- fix-columns (`import-columns.ts`, new): [20, 20]. fix-products-service (public guards, `create` options,
  `emitCatalogBulkChanged`): HIGH [60, 60] — call sites of `create(`/`assertCanFlagTobacco`. fix-customers-service
  (`update` options): HIGH [60, 60]. fix-import-service+controller+module: HIGH [80, 80] (money + tenancy).
  fix-web: [30, 30].

## 5. Sibling pattern

- `parseImport(Money|Number)\([^)]*\)\s*\|\|\s*0` over `apps/api/src/import` — a hit is the same NaN→$0 trap; fix
  only inside importProducts/importContacts here, file any other hit (invoices/payments) to the registry.
- `prisma\.forTenant\(\)\.product\.create\(` in `import.service.ts` — a remaining hit outside `importFromZoho`
  is a guard bypass.

## 6. Data repair

Plausibly: products created at $0.00 from unparseable/blank Rate (import origin not recoverable — no
`importBatchId` on Product). Read-only report first: `apps/api/scripts/report-zero-price-products.mjs` (active
`pricePerUnit = 0` counts per tenant, no live identifiers); owner decides; never bundled.

## 7. Probe plan

| File                                                   | Needs a `revert-probe` task?                                   | REG test that must go red |
| ------------------------------------------------------ | -------------------------------------------------------------- | ------------------------- |
| apps/api/src/import/import-columns.ts                  | yes (money parser → `\|\| 0` semantics)                        | REG-B858-2                |
| apps/api/src/import/import.service.ts (products block) | yes                                                            | REG-B858-1, REG-B858-3    |
| apps/api/src/import/import.service.ts (contacts block) | yes                                                            | REG-B859-1, REG-B859-3    |
| apps/api/src/customers/customers.service.ts            | yes (drop `options.compliance` spread)                         | REG-B859-2                |
| apps/api/src/products/products.service.ts              | no (visibility/options only; pinned by T1 through the service) | —                         |
| web files                                              | no (Playwright captures are the proof)                         | —                         |
