# S1 Evidence — B858 (products CSV importer)

Repo 21085bcb (fix/b858-b859-importer-columns == origin/master). Scope: B858 only, per GATHER list. B859 not investigated here.

## The bug as stated

git show f97966f6:.claude/campaign/bugs/B858.md: severity medium, state uncampaigned, location "apps/api/src/import/import.service.ts importProducts (~1660-1710) · settings/import 'Products (Items)' card".

Reported evidence (verbatim): "Only Item Name/Name, Rate/Sales Rate/Price, Description, Unit/Usage Unit and SKU are read; unitsPerBox, priceTier2-5, barcode, category, standardCost/averageCost, isTobacco, msrp and reorder columns are dropped with no warning, and re-import matches by name and skips existing rows so it can't fill them later. A richer JSON path (POST /products/import: barcode, category, opening stock, averageCost) exists but its hook useImportProducts has no call site; the Move-to-RouteFlow page forwards only name/sku/price/unit/category. White-glove onboarding must hand-enter pack sizes and tiers per product."

User impact (verbatim): "Every onboarding with a real catalog: pack sizes (unitsPerBox — drives boxed proration and case pricing), tier prices, barcodes (scanning), categories, costs (margins, AVCO) and tobacco flags (regulated reporting) must be keyed by hand per product, which turns a days-long load into weeks for a large catalog and invites typos in money fields. Route with the import-module work; likely fix = read the extra columns (and wire the dead JSON path or the migration page) with a preview."

## Code path

importProducts, import.service.ts:1660-1710. Reads `row["Item Name"]||row["Name"]`(1670), `row["Rate"]||row["Sales Rate"]||row["Price"]||"0"`(1677), `row["Description"]||row["Item Description"]`(1678), `row["Unit"]||row["Usage Unit"]||"unit"`(1679), `row["SKU"]`(1680); nothing else. No name: skip(1671-1674). Money: `parseImportMoney(...)||0`(1677) = parseImportNumber+roundMoney (parse-import-number.ts:10-22, strips $/commas/spaces, NaN if non-numeric); roundMoney at packages/pricing/src/pricing.ts:40. The `||0` turns NaN into 0, contradicting the file's NaN-means-absence contract. Dedupe: name only, case-insensitive, tenant-scoped findFirst(1684-1687); match skips, never updates. Create sets only name/description/pricePerUnit/unit/sku/isActive:true(1693-1702); every other column defaults. No transaction; catch→pushRowError(86-90, redacts DB text), skip. Returns {imported,skipped,errors}(1663,1709); dedupe-skip has no reason string. Tenant-scoped via forTenant() on lookup+create. No importBatchId write (Expense-only field, finance.prisma:453; zero Product-side hits).

parseCsv(56-79): columns/skip_empty_lines/relax_column_count/relax_quotes/trim/bom all true. MAX_IMPORT_ROWS=20_000 enforced outside the try(22,73-76).

Controller: class-level JwtAuthGuard+RolesGuard, Roles(OPERATOR)(25-27), no addon gate. POST products, FileInterceptor field "file", 10MB(89-95); no query/body params, no dryRun; returns the service result unchanged.

## Schema facts

Product, catalog.prisma:41-159, by type/default: String required — name, unit. String nullable — sku, unitSku, barcode, description, category, trackedCategoryId. Decimal(10,2) required — pricePerUnit; default 0 — priceTier2-5; nullable — msrp (present on master, line 59). Int nullable — unitsPerBox, reorderPoint, reorderQty (no minStock/parLevel field exists). Decimal(10,4) nullable — standardCost, averageCost. CostingMethod default AVCO — costingMethod. Boolean default false — isTobacco, detailsIncomplete; default true — isActive (the active/status field). Decimal(10,3) default 0 — currentStock.

Unique constraints: [tenantId,sku], [tenantId,barcode], [tenantId,unitSku] (135-137). Name uniqueness is NOT a Prisma @@unique — two raw-SQL partial unique indexes per the comment at 138-144; Prisma only carries a plain @@index([tenantId,name]).

ProductUnit exists (319-344): FK productId (Cascade), label, factorToBase Int, its own price/tiers. Comment (315-318): a product with no ProductUnit rows keeps using Product.unitsPerBox+tiers as "the pack." Neither import path writes to it.

## Service guards

ProductsService.create() (507-720, JSON single-product endpoint, guard reference only): assertCanFlagTobacco (508,143-152) requires tenant addon "tobacco_dealer" when isTobacco is true, else ForbiddenException; assertMsrpAllowed() runs if dto.msrp is defined (509). Name unique scoped by parentProductId (510-528); sku/barcode/unitSku each collision-checked against the other two (530-575, e.g. sku vs sku/unitSku). unitsPerBox validator is @IsInt() only, both DTOs (create:57, update:57) — no @Min(1)/range check anywhere (grepped every occurrence). costingMethod defaults from tenant systemConfig when unset (132-136); standardCost is a direct passthrough (703); msrp goes through normalizeMsrpForWrite (706) — none recompute from other fields. CreateProductDto has no currentStock field; only importFromZoho ever sets opening stock. emitProductChanged fires once per create (718); update() (722+) repeats the collision checks (753-788) plus a tobacco/category sync (789+). CSV importProducts calls none of this: no addon check, no msrp gate, no collision beyond name, no emit at all.

## JSON path + web

ImportProductItemDto: name, sku?, barcode?, unit, pricePerUnit(IsDecimal string), category?, description?, isActive?, currentStock?(IsDecimal), averageCost?(IsDecimal), reorderPoint?(IsInt) — no unitsPerBox, per-tier priceTier2-5, isTobacco, msrp, standardCost, or costingMethod.

importFromZoho (1360-1469): skips on name(1375-1382)/sku(1385-1393)/barcode(1396-1405) match, never updates. tenantTransaction wraps create+opening stock (1418-1452): priceTier2..5 all set to item.pricePerUnit (1426-1429 — one value into every tier, not distinct inputs), plus category/description/isActive/currentStock/averageCost/reorderPoint; nonzero stock creates a StockMovement type PURCHASE (1439-1449). One emitProductChanged(null,"bulk") if created>0 (1467).

Controller (71-75): POST import, Roles(OPERATOR) — only class-level guards apply (34); no PlanFlagGuard (msrp/bulk at 88-91 has one).

`grep -rn "useImportProducts" apps/web apps/mobile` →

```
apps/web/lib/api/products.ts:170:export function useImportProducts() {
```

Only the definition (posts to /products/import); no caller in apps/web or apps/mobile.

settings/import/page.tsx Products card (57-65): endpoint "/import/products" — the CSV path, not /products/import. Only hint shown is the export-path string (64); no column-name help text. Result rendering (35-44,192-236,304-332) is generic imported/skipped/errors; a dedupe-skip has no reason text.

settings/migration/page.tsx parseProductsCsv (25-55): naive line.split(","), header matched case-insensitive to exactly name/sku/price(or priceperunit)/unit/category (29-34) — no unitsPerBox/barcode/tier/cost/tobacco. Posts via stage.mutate (141) to the migration-job staging API, not either import endpoint.

B205.md (companion bug, same parser, comma-thousands truncation) state line: uncampaigned.

## Existing tests

Only import-robustness.spec.ts calls the CSV importProducts (grep-confirmed). One test, :173-182, "REG-B98 (T-B98): importProducts stores a comma-thousands rate cent-exact" — asserts only pricePerUnit===4567.89 and imported===1 (mocks prisma.product.create). No test covers the CSV path's dedupe/skip-by-name behavior, header-alias order, or unit defaulting.

importFromZoho specs that would break under a behavior change: products.service.spec.ts:1974-2027 "opening stock baseline" (B562), 3 its, mocks findFirst/create+stockMovement.create. products.gateway-emit.spec.ts:228-247/:250-259 REG-PROD-EMIT-10/11 — one coalesced emit over 3 rows, zero on all-skip. products.security.spec.ts:72-88 asserts errors[0].reason==="Import failed". uploads/upload-routes.security.spec.ts:520-533 lists ["products","importProducts"] in a generic cross-route table (service stubbed) — not column-specific.

## History

git log -8 on import.service.ts: 8 commits, all unrelated — payment rounding, tenant-id nesting, address-state x2, B562 cost-replay, payments capacity, tenant-scoped numbering, pricing-package refactor. None touch importProducts's columns.

git blame -L1660,1710: dfdb4419d (Najath Akram, 2026-03-30) — original body (Item Name/Rate/Description/Unit/SKU reads + today's create() shape), unchanged since. a80ccb754 (04-17) added the case-insensitive name-exists skip (1683-1691), ~7wk after ship. ef21ef046 (07-17) switched catch to pushRowError. b82ec14f9 (author "najathakram" lowercase, differs from "Najath Akram" elsewhere) (08-31) routed the price line through parseImportMoney. d689ab610/da5e89faa touched only scaffold/create-call. No commit adds unitsPerBox/tiers/barcode/category/cost/isTobacco/msrp/reorder reads.

## Other callers

`grep -rn "importProducts|/import/products|products/import\b" apps scripts packages` (ts/tsx/mjs/js, excl. node_modules) → only self-referential hits: page.tsx:61 (endpoint string), products.ts:174 (the other route), upload-routes.security.spec.ts:530, import.controller.ts:92,94, import.service.ts:1660, import-robustness.spec.ts:173,176. Same grep against apps/web/e2e and apps/api/scripts+scripts/ → empty. No feature-smoke/QA references either path.

## Open unknowns

Whether the Rate/Sales Rate/Price and Unit/Usage Unit aliases match real Zoho/QuickBooks export headers is unverified against any in-repo sample (claim only). Whether the CSV path's name-only dedupe (no sku/barcode match, no update-on-match) is one defect with the dropped columns or distinct is unclear. Whether ProductUnit rows are an intended import target, or Product.unitsPerBox alone remains it, is unresolved. B859 was outside this GATHER's scope; presumably a sibling S1 file.
