# Adversarial review (Opus, effort high) — B858/B859 importer columns

Scope: `git diff 21085bcb..HEAD -- apps packages` on `bug/2156-b858-b859-import-commercial-columns`.
Read-only, reasoned from code (no jest/tsc run). Binding: SA-284 + cause-ruling.md.

Counts: **critical 0 · important 4 · minor 9**

## Important

### I1 · important · apps/api/src/import/import.service.ts:2047-2085 (product matching/claims)

In-file claims only track the row's own `sku:`/`barcode:` key. They never track the **matched existing product id**, and a SKU/barcode miss falls through to a name lookup.

- Input: existing product `Cola` (sku `C-1`). File: `Cola,SUP-1,10` then `Cola,SUP-2,11` (Item Name,SKU,Rate). Both SKUs miss, both rows name-match `Cola`. Real run: row 1 sets sku=SUP-1, price 10. Row 2 then sets sku=SUP-2, price 11. Two file rows collapse onto one product, the tenant's scanned SKU `C-1` is overwritten, and the last row wins. The preview shows two independent updates that each start from `C-1`.
- Same collapse with no existing product: row 1 creates `Cola`. Row 2's name lookup then finds the product row 1 just created and rewrites its SKU. The preview showed 2 creates, but the real run gives 1 create and 1 update.
- Same with a name-only row plus a SKU row that both resolve to the same product.
- This breaks the ruling's "a second file row hitting a key an earlier row already claimed ⇒ skip duplicate", and dryRun no longer predicts the real run.
- Fix: after matching, claim `existing.id`, and skip "duplicate of row N" when that id is already claimed. Also claim the normalized name key for rows that plan a create. Consider refusing a name-fallback match whose file SKU is non-blank and differs from the product's SKU (skip "SKU differs from matched product"), because a silent SKU rewrite is an identity change.

### I2 · important · apps/api/src/import/import.service.ts:504-517 (+ 521-620) (customer matching)

The customer match is `findFirst({ businessName: { equals: name, mode: "insensitive" } })`. It has no uniqueness check and no `deletedAt: null`. The ruling requires "exact after normalization and unique within the tenant; an ambiguous match skips", and cause-ruling §2.B preloads with `deletedAt:null`.

- (a) Ambiguity: the tenant has `Acme` and `ACME`, or two branches with the same name. The row's credit limit, tier, terms, **and SMS/WA consent (plus an AuditLog row)** land on whichever row Postgres returns first. That is the wrong customer, with no skip reason.
- (b) Soft-deleted match: the raw identity `customer.update` + address/contact creates run first, then `customersService.update` throws `ConflictException("Restore the customer first")`. The catch at :620 only calls `pushRowError`. The result is a **partial row**: identity is written, commercial fields are not. The row is counted in neither updated nor skipped, and it has no `rows`/`skippedRows` entry. The dryRun preview reported it as a clean "update".
- Fix: match with `deletedAt: null`. Use `findMany take 2` on the name path and skip with "ambiguous name (N matches)". Detect in-file duplicates as products do.

### I3 · important · apps/api/src/import/import-columns.ts:61-71 (moneyParser); consumers import.service.ts:292-297, 2171, 2143

`moneyParser` accepts any sign and any magnitude. The service calls bypass the HTTP ValidationPipe, so the DTO bounds never run: `CreateProductDto.pricePerUnit` has `@Matches(non-negative)`, and `CreateCustomerDto.creditLimit` has `@Min(0) @Max(1e9)`.

- `Rate = -12` or `Price Tier 2 = -3` → a product is written at a negative price, and later order lines compute negative money. `Credit Limit = -500` → written, and the credit guard then blocks every order.
- `Credit Limit = 100000000` exceeds `Decimal(10,2)`, so Prisma throws a numeric overflow. For a **new** customer the user, customer and addresses are already committed by `tenantTransaction` before `applyCustomerCommercialFields` runs (:710-722), so the customer exists without its commercial fields. It is reported as `skipped` with only an `errors` entry: a partial row, while the preview said "create".
- Fix: give money parsers bounds (`min: 0`; max 99,999,999.99 for Decimal(10,2) columns) and have out-of-range values fail as bad cells ("must be between 0 and …"). Ideally, fold new-customer commercial fields into the same transaction, or delete/roll back on failure.

### I4 · important · apps/web/components/import/ImportCsvPanel.tsx:370-414 + import.service.ts:2138-2160, 2166-2186

The panel renders only `rows`, `warnings` and `unknownColumns`. It never renders `errors` or `skippedRows`, although the old settings card listed `errors` and the old modal showed an error count. On the API side, `rowPlans.push({action:"update"|"create"})` happens **before** the write. When `productsService.create/update` throws ("SKU already exists", "A product named … already exists", pack-levels 400, non-HttpException), the failure goes only to `skippedRows`/`errors` and the row's plan stays create/update.

- Input: a preview shows row 3 as CREATE, but the SKU collides with another product's `unitSku` (preview never runs service validation). After Import, the final table still shows row 3 as **CREATE** with no reason. The only trace is "1 skipped" in the summary, and the reason text is unreachable.
- Contacts are worse: rows skipped for non-customer type, blank name, P2002 or `pushRowError` never appear in `rows` at all.
- Fix: on a real-run failure, replace that row's plan with `action:"skip", reason`. Record every skip (contact type, blank name, P2002, caught errors) in `rows`/`skippedRows`. Render `skippedRows` or `errors` in the panel.

## Minor

- **M1 · import.service.ts:2113-2118 + products.service.ts:56-61.** MSRP `0` or a negative value is not idempotent. With existing `msrp=null` and a file cell `0`, `existingVal == null` counts as a diff, so the importer calls update, which normalizes the value back to null. Every re-import reports "msrp — → 0" and writes again. Fix: normalize `≤0` to undefined or null before diffing, the same way the service does.
- **M2 · import-columns.ts:70 / import.service.ts:2113.** `standardCost` is `Decimal(10,4)` but is rounded to cents on both sides of the compare. A file `0.0825` is written as `0.08`, a 3% cost error on low-price items. A real change from `1.2345` to `1.2349` compares equal and is dropped as "unchanged". Fix: parse cost at 4dp and compare at 4dp.
- **M3 · import.service.ts:2124-2135.** A row with a Rate, no name, and an unmatched SKU goes to `productsService.create({name: undefined})`. Either the `nameTaken` lookup with `equals: undefined` matches any standalone product and reports `A product named "undefined" already exists`, or, with no SKU, `dto.name.replace` throws a TypeError and the row fails as "import failed". The preview shows CREATE. Fix: skip with "Item Name is required for a new product".
- **M4 · gives up (packages/types/api/import.ts:57).** The old importer read `row["Item Description"]` as a description fallback. That alias is gone, so such files silently drop description into `unknownColumns`. Fix: add the alias.
- **M5 · gives up (import-columns.ts:209-325, import.service.ts:392-404).** Identity/address columns are now length-checked (Notes > 4000, Billing Address > 300, Phone > 30, City > 100 …), and any overflow skips the **whole customer**, where the old importer imported it. Zoho's integer `Payment Terms` values outside 0/15/30/45/60 (e.g. 7, 10, 90) also now skip the whole customer. That is SA-284-compliant but becomes lost customers on re-upload of a previously working export, so flag it to the owner. Fix: either leave the identity columns unvalidated (they are written raw anyway) or document it in the preview.
- **M6 · import.service.ts:343-361.** The consent flip is persisted before `auditService.log`, and `AuditService.log` swallows every error. A DB hiccup therefore leaves consent granted with no evidence row, against SA-284 (e) "each write records …". Fix: write the evidence row in the same transaction as the consent change, or use a non-swallowing insert.
- **M7 · apps/web/app/(dashboard)/customers/page.tsx:1138-1141 + modal.** `onDone` closes the modal the moment the import succeeds, so the final result table, skip reasons and warnings are never visible in the customers modal. The `imported` state and the "Close" label are dead code. Fix: refetch on `onImported` but keep the modal open until the user closes it.
- **M8 · pre-existing, not regressed (import.service.ts:525).** "Blank never clears" is violated by the kept identity block: a blank `Currency Code` writes `currency: "USD"` over an existing `CAD` on every matched row. It is carved out by the ruling (identity block not rewritten); note it for a follow-up.
- **M9 · tests (import-commercial-columns.spec.ts, .db.spec.ts):**
  - P12 is negative-only. Its title promises the "meta shape is exact", but REG-B859-2 uses `toMatchObject` and never asserts `fileName`, `row`, `timestamp`, `userId` or `tenantId`.
  - P10's `else` branch is tautological and covers one string column only. "Blank-never-clears on every column" is pinned only at the parser level (P3), not at the write for money, bool or int fields.
  - P14 pins dryRun for products only. Nothing pins that contacts dryRun skips the raw identity/address writes, `customers.update`, `auditService.log` and `maybeStartCustomerGrace`.
  - P15's "zero when nothing changed" half is untested.
  - No spec asserts `prisma.product.create/update` is **not** called by `importProducts` (the SA-284 (a) source pin).
  - The P16 DB fixture is not "all-columns": it omits tier 3–5, MSRP, Tobacco, reorder, licence, delivery windows and WhatsApp consent. It also never asserts that run 2 makes zero commercial `customers.update` writes; only the audit-row count is checked.

## Per-area verdicts

- **Money:** I3, M1, M2. Decimal-vs-number diffing is **clean**: `Number(Prisma.Decimal)` goes through `valueOf()` and `roundMoney` on both sides, so an unchanged re-import produces no diff for price/tiers/creditLimit, apart from the MSRP-0 case (M1).
- **SA-284 compliance:**
  - Gate refusal happens before any write in both modes: ok.
  - averageCost is never written: ok (not in the registry, and `create()` does not seed it).
  - The unitsPerBox rule and its exact reason: ok.
  - Consent literals: ok.
  - Past expiry warns: ok.
  - Ambiguity/uniqueness for customers: violated (I2).
  - Whole-row integrity: violated on failure paths (I2b, I3).
- **Gives up:** M4, M5, plus the lost `errors` rendering (I4). isActive default, unit default, name-trim, P2002 handling, the cap gate and grace, contact-type skipping and the currency default are all preserved.
- **Tenancy:** none. Every read and write goes through `forTenant()`, the tenant-scoped services, or `getTenantId()`.
- **Idempotency:** M1 for products. For customers, commercial fields are idempotent. `updated` always increments by design, because the identity block re-patches.
- **Web:** I4, M7. Preview and import send the same `File`. State resets on a new pick. The 403 path works: `setPreview(null)` keeps Import disabled.
- **Tests:** M9.
