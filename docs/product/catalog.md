# Products, Pricing & Promotions

_The catalogue, the price ladder, and the deals engine that every order, invoice and portal
visit prices against._

## The problem

A wholesale distributor's catalogue lives in three incompatible places: a spreadsheet of item
names and "the price", a printed price list that went stale months ago, and the owner's memory
of what each shop was promised. Goods are bought and sold by the case but customers routinely
take a case plus a few loose pieces, so every quote needs mental arithmetic that someone gets
wrong — and the same product carries a different negotiated price for every buyer, remembered by
one person. Deals ("buy 5 get 1 free", "10% off this brand this month") are honoured or forgotten
depending on who takes the call, and when a supplier's cost rises nobody notices they are now
selling below cost until the accountant says so at year end. Two order-takers quoting the same
customer the same item can produce two different prices, and neither can prove which was right.

## Why it matters to a tenant

One catalogue where packaging is a first-class fact: `unitsPerBox` plus `computeLineSubtotal`
mean a mixed "1 case + 3 pieces" line prices as 1.5 cases, not 9 pieces — the exact error that
once turned a $43.75 case of 6 into $262.50 on a real invoice. A five-rung price ladder with
per-customer, per-SKU tier overrides makes the negotiated price travel with the customer instead
of the salesperson, and the same resolver runs on the web dashboard, the mobile app and the buyer
portal, so a phone order and a self-service order settle at the same cents. Cost is carried per
product (`averageCost`, per-selling-unit normalised) and surfaced as a margin hint while the
operator types the price, with a configurable floor per category — the below-cost sale is caught
before it is saved, not after. Promotions are typed rules with a start and an end date, a single
best-wins evaluation, and a blast-radius guard that refused an "$35 off everything" rule that
would have put 699 of one tenant's 1,767 products on the portal at $0.00.

## Core use cases

1. **Maintain a sellable catalogue** — create and keep current the item's identity (name, case
   SKU, retail-unit code, barcode), its packaging (units per case, unit noun), its price and its
   cost — so every downstream document can reference one row instead of free text.
2. **Price a line correctly for this customer, this quantity** — resolve list price → the
   customer's tier → any per-SKU override → an active promotion or a one-off operator override,
   then prorate across cases and loose pieces and round to cents. The same answer on web, mobile
   and the buyer portal.
3. **Run a time-boxed deal without editing the catalogue** — publish a percent, fixed-amount,
   quantity-break or buy-N-get-M rule scoped to everything, a category or a named product set,
   with a window; it changes what buyers pay while it runs and stops on its own, leaving the list
   price untouched.

## Must have (P0)

| ID      | Capability                                        | Status     | What it does                                                                                                                                                                         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------- | ------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PPP-M1  | Catalogue CRUD with scannable identity            | SHIPPED ✅ | Create, edit, deactivate and find a product by name, case SKU, retail-unit code and barcode.                                                                                         | `products.controller.ts:37-124`, `ProductsService.create/update/remove`, `@@unique` on sku/barcode/unitSku. verified: only `unitSku` is checked against all three code columns — the service comment at `products.service.ts:524-526` states sku vs. barcode collisions are deliberately NOT rejected, and the check is skipped entirely on the auto-generated-SKU path (`:508-518`); disambiguation relies on `findByBarcode`'s ranking, not on refusal. |
| PPP-M2  | Case/piece UoM with correct line money math       | SHIPPED ✅ | Boxes + loose pieces price at the case rate, prorated, integers only.                                                                                                                | `common/pricing.ts computeLineSubtotal/normalizeBoxesPieces/roundMoney`, `pricing.spec.ts`. verified: web/mobile mirrors are kept in sync but are not byte-identical to the API file — `web/lib/pricing.ts` additionally exports `getTierPrice`/`TIER_FIELDS`/`cascadeTierPrices`, and line offsets diverge.                                                                                                                                              |
| PPP-M3  | Barcode/SKU scan resolves deterministically       | SHIPPED ✅ | Scanning finds the product across barcode, case SKU and retail-unit code, tolerant of 12/13-digit variance.                                                                          | `GET /products/barcode/:barcode`, `barcode-normalize.ts`, `scan-search.ts` + spec.                                                                                                                                                                                                                                                                                                                                                                        |
| PPP-M4  | Five-rung price ladder with tenant-named tiers    | SHIPPED ✅ | Product carries list price + 4 tiers; tenants rename tiers to their own vocabulary.                                                                                                  | `Product.pricePerUnit/priceTier2..5`, `utils/pricing.ts`, `SystemConfig.pricing.tierLabels`, `tier-label.ts`.                                                                                                                                                                                                                                                                                                                                             |
| PPP-M5  | Per-customer, per-SKU price override              | PARTIAL 🟡 | A negotiated rate follows the customer automatically, but only as a choice of one of the five existing tiers — no absolute price.                                                    | `CustomerPrice` model (tier + msrp only), `customers.controller.ts:231-257`. POST admits DRIVER role (B132).                                                                                                                                                                                                                                                                                                                                              |
| PPP-M6  | Cost per product with a live margin hint          | SHIPPED ✅ | Moving average cost per product; margin/warn/below-cost hint shown while pricing a line, floor configurable per category.                                                            | `common/pricing.ts costPerSellingUnit/computeMarginFraction/classifyMargin`, `MarginHint.tsx`. verified: cost is also settable directly from the product form (`CreateProductDto`/`UpdateProductDto` carry `costingMethod`/`standardCost`), not only via the two dedicated cost-basis endpoints.                                                                                                                                                          |
| PPP-M7  | Product categories with autocomplete              | PARTIAL 🟡 | Free-text category with de-duplicated suggestions; drives filters, promotion scope and margin floors. No rename/merge/hierarchy.                                                     | `Product.category` (String?, indexed), `GET /products/categories`.                                                                                                                                                                                                                                                                                                                                                                                        |
| PPP-M8  | Product photos with a focal point                 | SHIPPED ✅ | Upload, compress, and set the crop focus so tiles stay centred everywhere.                                                                                                           | `POST/DELETE /products/:id/images`, `compress.util.ts`, `CropModal.tsx`, `image-focal.ts`. verified: the focal point CAN be edited in place — `products/[id]/page.tsx:1299-1314` offers a "Crop / focal" button that re-crops and re-uploads the existing image without the operator sourcing the original file again (the storage-key `-fp` encoding is an implementation detail, not an operator-facing limitation).                                    |
| PPP-M9  | Typed, time-boxed promotion rules                 | SHIPPED ✅ | Percent, fixed, quantity-break or buy-N-get-M, scoped to all/category/products, with a start and end date.                                                                           | `Promotion`/`PromotionProduct` models, `promotions.service.ts`, `pricing.ts applyBestPromotion`.                                                                                                                                                                                                                                                                                                                                                          |
| PPP-M10 | Zero-price blast-radius guard                     | SHIPPED ✅ | Refuses a discount write that would zero-price too much of the catalogue until the operator confirms.                                                                                | `assertNoZeroPricedProducts`, `PROMOTION_ZERO_PRICE`, `pricing.ts` zero-price helpers + spec.                                                                                                                                                                                                                                                                                                                                                             |
| PPP-M11 | Tenant isolation on every catalogue/pricing write | SHIPPED ✅ | One tenant's products, prices, overrides and promotions are unreachable from another, including bulk paths.                                                                          | `PrismaService.forTenant()`, `products.security.spec.ts`.                                                                                                                                                                                                                                                                                                                                                                                                 |
| PPP-M12 | Get the catalogue in from a spreadsheet           | PARTIAL 🟡 | CSV import maps only name/price/unit/SKU — units-per-case, barcode, category, cost and tiers are dropped and must be typed by hand.                                                  | `import.service.ts importProducts`, `ProductsService.importFromZoho`. verified: `unitsPerBox` is not carried by CSV import, but new products created through the product form DO get it pre-filled by the pack-size inference engine (see PPP-M13) — the CSV path is the real gap, not "the field must always be typed by hand".                                                                                                                          |
| PPP-M13 | Pack-size inference at product create             | SHIPPED ✅ | Parses the product name ("24 CT", "Box of 12") and suggests units-per-box with a confidence-graded prompt, so the packaging fact PPP-M2 depends on is pre-filled instead of guessed. | `packages/types/pack-size.ts` (`suggestPackSize`, `PackSizeConfidence`), `PackSizePrompt.tsx` inside `ProductCreateModal.tsx`, specs `common/pack-size.spec.ts` + `mobile/__tests__/pack-size-logic.test.ts`, e2e `14-pack-size-prompt.spec.ts`.                                                                                                                                                                                                          |

### Testing criteria

#### PPP-M1

- [ ] POST /products with a sku already used as another product's unitSku returns 400 and no row is created `Jest`
- [ ] DELETE /products/:id for a product with a non-terminal OrderItem returns 400 and isActive stays true `Jest`
- [ ] GET /products/:id for a foreign-tenant id returns 404, and GET /products never returns a foreign-tenant row `Jest`
- [ ] NEGATIVE: an auto-generated SKU is created without a pre-write collision check against sku/unitSku — only the DB unique constraint catches it as a raw P2002; assert this and treat it as a hardening gap `Jest`

#### PPP-M2

- [ ] With unitsPerBox=6 and a $43.75 case price, 1 box + 3 pieces subtotals 65.63 — never 43.75 × 9 `Jest`
- [ ] normalizeBoxesPieces coerces fractional/negative input to a non-negative integer with correct rollover `Jest`
- [ ] Every computeLineSubtotal value is roundMoney'd; document totals equal the rounded sum of lines plus tax `Jest`
- [ ] Boxed order entry shows the same subtotal the API persists, to the cent `Playwright`

#### PPP-M3

- [ ] A 12-digit UPC-A resolves when the client sends the 13-digit EAN form and vice versa `Jest`
- [ ] pickBestScanMatch returns the barcode match ahead of the sku match, deterministically `Jest`
- [ ] An unknown or zero-candidate code returns 404, never a false match `Jest`
- [ ] A barcode existing only in tenant B returns 404 for a tenant-A operator `Jest`

#### PPP-M4

- [ ] A customer on tier 3 prices at priceTier3; a null/zero tier column falls back to pricePerUnit `Jest`
- [ ] cascadeTierPrices only rewrites lower tiers, never the edited tier or above `Jest`
- [ ] A blank or corrupt tierLabels config falls back to "Tier N" without throwing `Jest`
- [ ] Renaming tier 2 changes the products grid header and the customer record label in the same session `manual`

#### PPP-M5

- [ ] POST {productId, pricingTier:4} makes a new order line for that product price at tier 4 for that customer only `Jest`
- [ ] POST with both fields null deletes the row; non-operator roles are refused `Jest`
- [ ] NEGATIVE (B132, currently failing): a DRIVER token overwriting an existing override must be rejected 403 `Jest`
- [ ] A CustomerPrice row for tenant A is never returned to tenant B `Jest`

#### PPP-M6

- [ ] Margin is computed against the CASE cost (averageCost × unitsPerBox), never the piece cost `Jest`
- [ ] classifyMargin buckets belowFloor/warn/ok/belowCost correctly at the configured floor `Jest`
- [ ] classifyMargin returns null when averageCost is null; UI renders "cost unknown" `Jest`
- [ ] Typing a below-cost price on the create-order modal shows the warning before save; save still succeeds `Playwright`

#### PPP-M7

- [ ] "Snacks" and "snacks" yield exactly one entry in GET /products/categories `Jest`
- [ ] category=Snacks returns only exact matches `Jest`
- [ ] NEGATIVE: renaming a category on one product leaves the rest on the old string and un-scopes any promotion or margin-floor key referencing it `Jest/manual`
- [ ] GET /products/categories never returns a foreign-tenant category `Jest`

#### PPP-M8

- [ ] Uploading an SVG is rejected 400 and nothing is written `Jest/e2e`
- [ ] A 50/50 focal point produces no `-fp` suffix; out-of-range values clamp to 0-100 `Jest`
- [ ] Deleting a key not on the product returns 404 and deletes nothing `Jest`
- [ ] Using the existing "Crop / focal" control re-crops and replaces an already-uploaded image in place `manual`

#### PPP-M9

- [ ] BUY_N_GET_M with N=5,M=1 yields correct freeUnits at 5/6/11/12/18 units; loose pieces below a full case never count `Jest`
- [ ] A QTY_BREAK below its threshold applies no promotion `Jest`
- [ ] applyBestPromotion returns exactly one winner, deterministic tie-break `Jest`
- [ ] POST /promotions rejects endsAt<=startsAt, CATEGORY scope with no category, fractional minQty on BUY_N_GET_M `Jest`

#### PPP-M10

- [ ] A FIXED $35 rule against a sub-$35 catalogue returns 400 PROMOTION_ZERO_PRICE with count/examples and creates nothing `Jest`
- [ ] allowZeroPrice:true succeeds and is never persisted on the row `Jest`
- [ ] A PATCH is judged against the MERGED rule, not the patch fields alone `Jest`
- [ ] PERCENT 50 never scans; PERCENT 100 always does; BUY_N_GET_M never does `Jest`

#### PPP-M11

- [ ] DELETE /products/clear-all never issues a raw TRUNCATE `Jest`
- [ ] bulk-assign-parent with a foreign parentProductId returns 400 and assigns nothing `Jest`
- [ ] GET/PATCH/DELETE a foreign-tenant promotion returns 404 `Jest`
- [ ] Bulk delete >500 ids returns 400; an empty array returns 400 `Jest`

#### PPP-M12

- [ ] Re-importing a name that exists increments skipped and does not overwrite the price `Jest`
- [ ] A failed row returns a generic reason, never raw Prisma error text `Jest`
- [ ] GAP TEST (currently fails): a "Units per case" CSV column must set unitsPerBox — today it is dropped `Jest`
- [ ] Re-uploading the identical file twice creates zero new products `Jest`

#### PPP-M13

- [ ] A name containing "24 CT" suggests unitsPerBox=24 at HIGH confidence and pre-fills the field `Jest`
- [ ] An ambiguous name surfaces an AMBIGUOUS suggestion the operator must confirm, not a silent guess `Jest`
- [ ] A piece-sold item (no case language) suggests unitsPerBox=1 `Jest`
- [ ] The prompt appears inline in ProductCreateModal and does not block creation if dismissed `Playwright`

## Nice to have (P1)

| ID      | Capability                                                          | Status     | What it does                                                                                                                                   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------- | ------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PPP-N1  | Variants: one family, many flavours                                 | SHIPPED ✅ | Child SKUs inherit the parent's tiers, category, case size and classification.                                                                 | `Product.parentProductId`, `products.service.ts:554-611`, `GroupAsVariantsModal.tsx`.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| PPP-N2  | Inline quick-edit grid for the whole ladder                         | SHIPPED ✅ | Reprice a shelf directly in the products table with tier cascade doing the copying.                                                            | `products/page.tsx`, `QuickEditCell.tsx`, `cascadeTierPrices`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| PPP-N3  | MSRP with a customer override                                       | SHIPPED ✅ | Suggested retail per piece, display-only, snapshotted onto invoice lines.                                                                      | `common/msrp.ts resolveMsrp`, `POST /products/msrp/bulk`, `applyMsrpSnapshots`. verified: `applyMsrpSnapshots` is called at six sites, not five — also `invoices.service.ts:3091`.                                                                                                                                                                                                                                                                                                                                                                 |
| PPP-N4  | Remembered price per customer (sticky upsell)                       | SHIPPED ✅ | The last price actually given pre-fills next time; above-list prices stick, one-off discounts do not.                                          | `getCustomerPriceHistory`, `effectiveBuyerPrice/isUpsellLine`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| PPP-N5  | Per-product demand, sales and price/cost history                    | SHIPPED ✅ | Who bought it, at what price, demand trend, cost trend on the product page.                                                                    | `analytics.controller.ts:119-151`, `DemandCard.tsx`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| PPP-N6  | Reorder point and reorder quantity                                  | PARTIAL 🟡 | Stock level that drives a needs-reorder list, but not settable from the product form and ignored by the LOW-stock filter.                      | `Product.reorderPoint/reorderQty`, `inventory.service.ts:1309-1321`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| PPP-N7  | Regulated/tracked classification with subcategories                 | SHIPPED ✅ | Tenant-defined sections and subcategories drive licence gating, tax and reporting.                                                             | `TrackedCategory`/`TrackedSubcategory` models. verified: the controller exposes no DELETE — a section can only be deactivated via `PATCH :id/toggle`, never removed.                                                                                                                                                                                                                                                                                                                                                                               |
| PPP-N8  | Per-category excise, deposit and levy on a line                     | SHIPPED ✅ | Excise/percent/volume/deposit tax computed on piece count, optionally tax-inclusive.                                                           | `common/pricing.ts computeCategoryTax`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| PPP-N9  | Merchandising flags and smart collections                           | SHIPPED ✅ | Featured/new/deal flags build New, Deals, Usuals, Favourites rails on the buyer portal.                                                        | `Product.isFeatured/isNew/isDeal`, `BuyerCatalogService.getCatalog`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| PPP-N10 | Learned supplier line-text aliases                                  | SHIPPED ✅ | An operator's one-time match is remembered for future deliveries.                                                                              | `ProductAlias` model, `product-alias.service.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| PPP-N11 | "Finish setup" queue for scan-created products                      | SHIPPED ✅ | A product born from a scanned bill is sellable at cost+margin immediately and queued to be completed.                                          | `Product.detailsIncomplete`, `VariantResolutionService.createBrandNew`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| PPP-N12 | Bulk catalogue operations                                           | PARTIAL 🟡 | Group into variants, bulk MSRP, bulk section assign, bulk cost basis, bulk delete — but no bulk reprice, activate/deactivate or category move. | `bulk-assign-parent`, `msrp/bulk`, `cost-basis/bulk`, `bulk delete`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| PPP-N13 | Deactivated products stay out of pickers and new documents          | PARTIAL 🟡 | Retired SKUs are meant to disappear from order/invoice pickers and be rejected on write.                                                       | `ProductsService.remove` (soft delete only). verified: this was overstated as BROKEN. Every web operator picker (11 call sites — order/invoice/estimate/vendor-bill/standing-order/customer modals) already passes `isActive:true`, and mobile's shared product-fetch hook (`mobile/lib/api/products.ts:29,55`) defaults `isActive:true` too. The real gap is narrower: `mobile/components/ProductPickerSheet.tsx` fetches via `useAdminProducts`, which does not default the filter, and no server-side write path rejects an inactive productId. |
| PPP-N14 | Promotion lifecycle: schedule, pause, expire                        | SHIPPED ✅ | A deal can be scheduled forward, paused mid-flight, and expires on its own without retro-pricing past orders.                                  | `Promotion.startsAt/endsAt/isActive`, `activeForCatalog`, `setActive`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| PPP-N15 | Product image ordering: default image and multi-select delete       | SHIPPED ✅ | Reorder/set-default and select-then-delete across multiple images at once.                                                                     | `UpdateProductDto.imageKeys` (full-replacement, doc'd "reorder or set default"), `products/[id]/page.tsx:1285-1330` (`handleSetDefault`, select-mode delete).                                                                                                                                                                                                                                                                                                                                                                                      |
| PPP-N16 | Camera barcode capture into a product record                        | SHIPPED ✅ | Scan a code straight into the SKU/barcode/unit-code fields while editing a product, not just to look one up.                                   | `BarcodeScannerButton` used in `products/[id]/page.tsx:2560,2577,2693`; mobile `(operator)/products/scan.tsx`.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| PPP-N17 | Catalogue-wide average-cost recompute with dry run                  | SHIPPED ✅ | Recompute averageCost across the catalogue with a preview before committing.                                                                   | `POST /inventory/recompute-costs` (`RecomputeCostsDto.dryRun`), `inventory.service.spec.ts:584-660`, mobile `recompute-costs.tsx`.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| PPP-N18 | Vendor-bill line memory (ProductMapping)                            | SHIPPED ✅ | A second, independent learned mapping from a supplier's raw bill-line text to a product, scoped by supplier name.                              | `ProductMapping` model (`@@unique([supplierName, rawDescription])`), `POST /vendor-bills/product-mappings`, spec `vendor-bills.service.spec.ts:1005-1090`. Also deleted by bulk product delete (`products.service.ts:1142`).                                                                                                                                                                                                                                                                                                                       |
| PPP-N19 | Mobile bulk and per-product cost-basis edit                         | SHIPPED ✅ | Set cost on one product or many, and recompute, from the mobile operator app.                                                                  | `mobile/(operator)/products/bulk-set-cost.tsx`, `[id]/set-cost.tsx`, `recompute-costs.tsx`.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| PPP-N20 | Tier-ladder sanity affordances                                      | SHIPPED ✅ | "Set all tiers to list" and an inline "higher than the tier above" warning while typing a tier value.                                          | `products/[id]/page.tsx:1946` ("Set all to …"), `:2625` (inline warning).                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| PPP-N21 | BUY_N_GET_M live preview and status filter in the promotions editor | SHIPPED ✅ | A plain-English preview sentence for buy-N-get-M rules, plus filtering the promotions list by ACTIVE/SCHEDULED/PAUSED/EXPIRED.                 | `promotions/page.tsx:64,415` (preview), `:661-663` (status filter, distinct from the badge map).                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### Testing criteria

#### PPP-N6

- [ ] reorderPoint 24, currentStock 20 → needsReorder true; at 24 → false `Jest`
- [ ] GAP TEST (currently fails): PATCH /products/:id {reorderPoint:24} is silently ignored — not on the DTO `Jest`
- [ ] GAP TEST (currently fails, B25): stockStatus=LOW must use each product's own reorderPoint, not a fixed <=5 `Jest`
- [ ] A tenant without flag.forecasting gets 403 on reorder-settings and forecasting endpoints `Jest`

#### PPP-N12

- [ ] clear-all without ?confirm=true returns 400 and deletes nothing `Jest`
- [ ] CRITICAL NEGATIVE (B24): bulkDelete deletes InvoiceItem/OrderItem rows for the removed products — assert current behaviour then require a guard `Jest`
- [ ] bulk-assign-parent partial failure reports per-row succeeded/failed, does not abort the batch `Jest`
- [ ] msrp/bulk with a foreign-tenant id returns 404 and writes nothing `Jest`

#### PPP-N13

- [ ] Every web operator picker (orders, invoices, estimates, vendor bills, standing orders) excludes inactive products `Playwright`
- [ ] GAP TEST (currently fails): mobile's ProductPickerSheet (via useAdminProducts) must default isActive:true `manual`
- [ ] NEGATIVE (currently fails): POST /orders with an inactive productId must return 400 — no server path currently rejects it `Jest`
- [ ] Reactivating a product makes it selectable again with prior prices intact `Jest`

## Advanced / future (P2)

| ID      | Capability                                     | Status     | What it does                                                                    | Evidence                                                                            |
| ------- | ---------------------------------------------- | ---------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| PPP-A1  | Promotions apply to operator-taken orders      | MISSING ⬜ | Deals should fire on phone/dashboard orders, not only portal orders.            | `OrdersService.loadActivePromotions` returns `[]` unless role is CUSTOMER.          |
| PPP-A2  | Catalogue price-change history / audit trail   | MISSING ⬜ | Who changed a price, from what, to what, when.                                  | No PriceHistory model; `ProductsService.update` writes no AuditLog.                 |
| PPP-A3  | Absolute negotiated price per customer per SKU | MISSING ⬜ | "$18.50 for that case, whatever list does."                                     | `CustomerPrice` has only tier + msrp, no price column.                              |
| PPP-A4  | Effective-dated / scheduled price changes      | MISSING ⬜ | Enter a January rise in December; it lands itself.                              | No effectiveFrom/effectiveTo on any price column.                                   |
| PPP-A5  | Customer-facing price list / catalogue export  | MISSING ⬜ | Hand a buyer a PDF/CSV price list at their tier.                                | No export route exists anywhere in products.controller.ts.                          |
| PPP-A6  | Bulk repricing by rule                         | MISSING ⬜ | "+7% on category X, round to .99" with a preview.                               | Only bulk-assign-parent, msrp/bulk, cost-basis/bulk exist — no price-rule endpoint. |
| PPP-A7  | Cost-rise alerts that reach the operator       | PARTIAL 🟡 | Margin-alerts report exists but nothing pushes it to anyone.                    | `GET /analytics/inventory/margin-alerts`, no notification wiring.                   |
| PPP-A8  | Promotion performance reporting                | MISSING ⬜ | Units moved, revenue, discount given, per promotion.                            | No promotionId column on OrderItem/InvoiceItem; no aggregation endpoint.            |
| PPP-A9  | Audit on catalogue-wide promotion rules        | MISSING ⬜ | Who published an ALL-scoped discount and who confirmed the zero-price warning.  | `PromotionsService.create/update/setActive/remove` write no AuditLog.               |
| PPP-A10 | Kits, bundles, cross-line mix-and-match        | MISSING ⬜ | "Buy any 5 across this brand, get 1 free"; bundle SKUs drawing down components. | `promoBogoFreeUnits` is single-line only; no BOM/component model.                   |
| PPP-A11 | Segment / regional price and MSRP layer        | MISSING ⬜ | Prices/MSRP that vary by state or segment without a row per customer.           | `msrp.ts` stubs `segmentMsrp` as unpopulated; no equivalent for selling price.      |
| PPP-A12 | Competitor / street-price capture              | MISSING ⬜ | Record what an item sells for elsewhere to price against the market.            | No competitor-price field or model anywhere in the schema.                          |

### Testing criteria

#### PPP-A1

- [ ] An active PERCENT 10 promo scoped to product P prices an OPERATOR-created line identically to a CUSTOMER-created one `Jest`
- [ ] Phone and portal orders for the same customer/product/qty produce byte-identical pricing fields `Jest`
- [ ] An explicit MANUAL override still beats the promotion `Jest`
- [ ] A tenant with no promotions configured sees no behaviour change `Jest`

#### PPP-A7

- [ ] Receiving a vendor bill that pushes averageCost past the floor adds the product to margin-alerts in the same transaction `Jest`
- [ ] The operator is notified without opening the report `manual`
- [ ] Snoozing an alert persists and does not re-fire on an unchanged cost write `Jest`
- [ ] The alert compares cost per SELLING unit, not the piece cost `Jest`

## How this varies by tenant

| Variation                                                       | Mechanism                                                                                                                        |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Per-customer, per-SKU price overrides available or hidden       | plan flag `flag.pricing_tiers` on `/customers/:id/prices` (behind the PLAN_FLAG_ENFORCEMENT kill switch, default OFF)            |
| MSRP visible, editable and printed                              | plan flag `flag.msrp`, enforced outside the kill switch; grantable via the MSRP addon SKU                                        |
| Regulated/tracked categories, tobacco flag, per-category excise | legacy addon `tobacco_dealer` bridged to the REGULATED_ITEMS addon SKU; each TrackedCategory row also carries its own tax config |
| Reorder points and needs-reorder list                           | plan flag `flag.forecasting`, granted by the FORECASTING addon SKU                                                               |
| Demand, sales history, price/cost history, margin alerts        | plan flag `flag.analytics`, granted by the FORECASTING addon SKU                                                                 |
| Buyer-facing catalogue and promotion consumption                | BUYER_PORTAL addon SKU / `addon.buyer_portal`; without it, promotions still show in the nav but can never fire (see PPP-A1)      |
| Tier names ("Wholesale", "Shop", "Cash & Carry")                | tenant setting `pricing.tierLabels` (SystemConfig JSON blob)                                                                     |
| Costing method and margin floors (global + per category)        | tenant settings `costing.method`, `margin.floor.default`, `margin.floor.category.<name>`                                         |
| Number of price tiers                                           | **NOT CONFIGURABLE** — hardcoded at five columns (list + 4 tiers)                                                                |
| Available promotion mechanics                                   | **NOT CONFIGURABLE** — fixed enum: PERCENT, FIXED, QTY_BREAK, BUY_N_GET_M                                                        |
| Whether the Promotions module is visible                        | **NOT CONFIGURABLE** — no addon/plan-flag guard on the controller or nav leaf; every tenant sees it even if it can never fire    |
| Low-stock threshold on the products list                        | **NOT CONFIGURABLE** — hardcoded `currentStock <= 5`, ignores per-product reorderPoint                                           |
| Default margin on a product created from a scanned bill         | **NOT CONFIGURABLE** — hardcoded 30% (`DEFAULT_MARGIN = 0.3`)                                                                    |
| Product image limits and formats                                | **NOT CONFIGURABLE** — 10 files/request, 10 MB each, jpeg/png/webp only                                                          |
| Catalogue size ceiling on list reads                            | **NOT CONFIGURABLE** — `limit=0` fetch-all sentinel capped at 10,000 rows                                                        |

## Gaps for a great UX

| Severity | Gap                                                                 | Impact                                                                                                                                                                             | Suggested direction                                                                                                                                                                                        |
| -------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRITICAL | Promotions never apply to operator-taken orders                     | A distributor whose orders arrive by phone can build a promotion, see it ACTIVE, and have it change nothing — same customer, different price by channel, with no warning anywhere. | Have `loadActivePromotions` return the active set for staff roles too; an explicit operator MANUAL override still wins. If the split is deliberate, gate the Promotions nav/API on the buyer-portal addon. |
| CRITICAL | Bulk product delete rewrites financial history                      | `bulkDelete` deletes InvoiceItem/OrderItem rows for removed products; deleting a discontinued SKU silently alters paid invoices.                                                   | Refuse hard-delete of any product referenced by a non-DRAFT invoice or non-CANCELLED order line; offer archive instead, or detach and snapshot the line.                                                   |
| CRITICAL | Standing-order/template orders bill raw list price                  | `createOrderFromTemplate` ignores tier, per-customer override and promotions — the customers most likely to be on standing orders are exactly the ones with negotiated prices.     | Route template pricing through the same resolver as manual entry; add a regression spec comparing templated vs. manual pricing to the cent.                                                                |
| HIGH     | Promotion chooser compares savings on whole cases only              | On mixed case+piece lines the wrong mechanic can win, verified as a $53.95 overcharge in one case.                                                                                 | Compare candidate line subtotals via `computeLineSubtotal` rather than per-unit savings on whole boxes.                                                                                                    |
| HIGH     | No absolute negotiated price per customer/SKU                       | The single most common wholesale arrangement ("$18.50 for that case") is only expressible if it happens to equal a shared tier.                                                    | Add a nullable absolute price column to CustomerPrice with clear precedence over tier, mirrored across all resolvers.                                                                                      |
| HIGH     | Drivers can overwrite a customer's price override                   | `POST /customers/:id/prices` admits DRIVER while DELETE is operator-only; a driver token can silently reprice a customer.                                                          | Restrict POST to operator level, matching DELETE; add a negative spec.                                                                                                                                     |
| HIGH     | No record of catalogue price changes                                | No price-history table, no AuditLog on product update; a disputed invoice can't be reconstructed.                                                                                  | Write an audit entry on every price/tier/msrp change; render a list-price timeline distinct from the charged-price chart.                                                                                  |
| MEDIUM   | CSV catalogue import drops units-per-case, tiers, barcode, category | Everything the money model depends on must be typed by hand for every imported SKU (pack-size inference only helps at manual product create, not bulk CSV import).                 | Extend the CSV mapper to the missing fields with a column-mapping preview and dry run.                                                                                                                     |
| MEDIUM   | Category is unmanaged free text                                     | A typo forks a category permanently; renames silently un-scope live promotions and margin floors.                                                                                  | Add rename/merge that rewrites every referencing product, promotion scope and margin-floor key transactionally.                                                                                            |
| MEDIUM   | Low-stock signal ignores the configured reorder point               | A hardcoded `<=5` threshold shows a healthy status on items with a much higher reorder point; reorderPoint isn't even settable from the product form.                              | Use `COALESCE(reorderPoint, 5)`; add reorderPoint/reorderQty to the product DTOs.                                                                                                                          |
| MEDIUM   | No catalogue or price-list export                                   | No way to hand a buyer a price list, bulk-edit via spreadsheet round-trip, or take the catalogue elsewhere.                                                                        | Add a CSV/PDF export respecting regulated visibility and tier selection.                                                                                                                                   |
| MEDIUM   | Promotion writes are unaudited                                      | An ALL-scoped rule is a company-wide price change with no record of who published or confirmed it.                                                                                 | Write AuditLog entries on create/update/setActive/remove, including any accepted zero-price blast radius.                                                                                                  |
| MEDIUM   | Mobile cannot set MSRP or manage promotions                         | An operator running the business from a phone must find a laptop for these two tasks.                                                                                              | Add the MSRP field to the mobile product form; build a mobile promotions editor mirroring the web rule set.                                                                                                |
| MEDIUM   | Invoice PDFs/emails omit promo strikethrough and BOGO disclosure    | The customer's copy doesn't explain why quantity × price doesn't match the subtotal.                                                                                               | Add originalPrice/priceType/promoFreeUnits to PDF and email payloads.                                                                                                                                      |
| LOW      | Mobile's ProductPickerSheet can still offer deactivated SKUs        | One mobile sheet (via `useAdminProducts`) doesn't default `isActive:true`, unlike every other picker on web and mobile.                                                            | Default that one hook call to `isActive:true` with an explicit "show retired" toggle.                                                                                                                      |

## Cross-domain handoffs

- **→ Orders**: every line's price is resolved here; `OrderItem` snapshots unitPrice, originalPrice,
  priceType, boxes, pieces, unitsPerBox and promoFreeUnits so the catalogue can move afterward
  without rewriting history.
- **→ Invoices**: `applyMsrpSnapshots` writes MSRP at line creation (six call sites); the API does
  NOT re-price operator invoice lines against the tier ladder — the web page resolves tier
  client-side.
- **↔ Inventory & Costing**: `currentStock`/`averageCost` are owned by inventory; pricing reads
  `averageCost` for the margin hint; deleting a product also deletes its stock movement/lot rows.
- **→ Buyer portal**: resolves tier + override + sticky upsell into one buyer price, applies the
  regulated-licence visibility gate, and builds the merchandising rails.
- **← Purchasing / vendor bills / document scanning**: unmatched supplier lines become products
  through the resolution endpoints, which learn a `ProductAlias` (and independently a
  `ProductMapping` scoped by supplier) and flag brand-new rows `detailsIncomplete` for the
  finish-setup queue.
- **→ Regulated compliance**: tracked category/subcategory and reg UoM fields feed the ledger,
  filings and monthly reports; the one-axis rule keeps `category` synced to the subcategory name.
- **→ Analytics & bookkeeping**: sales-by-category, gross-margin, top products and dead stock all
  key on `category` and `averageCost` — an unmanaged free-text category is a reporting problem too.
- **→ Estimates, recurring invoices, order templates, returns, purchase orders**: all hold
  productId lines and must re-price through the same resolver. Estimates does; order templates
  does not (see Gaps).
- **← Billing & entitlements**: `flag.pricing_tiers`, `flag.msrp`, `flag.forecasting`,
  `flag.analytics`, `tobacco_dealer`/REGULATED_ITEMS and BUYER_PORTAL gate parts of this domain;
  any new gate needs a UI that can grant it and a matching activation write.
- **→ Customer documents (PDF + email)**: renders unitPrice and MSRP but not originalPrice,
  priceType or promoFreeUnits — the promotion disclosure stops at the web screen.

## What we could not verify

- No running API, database, or test execution — findings are from static code reading only.
  "SHIPPED" means the code path exists (and, where cited, has a named spec file), not that the
  suite is currently green.
- The two largest product UI files (`products/[id]/page.tsx` at 136 KB, `products/page.tsx` at
  60 KB) were read at the level of imports, section markers and column definitions rather than
  every branch — a further affordance may exist uncredited here.
- Bug register statuses (B24, B25, B48, B60, B103, B109, B132, B142, B154) are quoted from the
  local bug register as read on 2026-08-30; the code anchors for most were independently
  confirmed, but B109's $53.95 figure and the invoice PDF template for B103 were not re-derived.
- Which tenants currently hold `flag.msrp`, `flag.pricing_tiers`, `flag.forecasting` or
  `flag.analytics`, and whether `PLAN_FLAG_ENFORCEMENT` is on in production, could not be checked
  — the constants file defaults it OFF, meaning most of these flags may behave as always-on today.
- Not every one of the ~28 files referencing `priceTier`/`pricingTier` was traced; returns, credit
  notes and recurring invoices may resolve tiers differently from the main resolver and are worth
  a dedicated sweep.
- Mobile coverage rests on `lib/product-form.ts`, `lib/api/products.ts`, the operator products
  screen list, and a repo-wide grep for "promotion"/"msrp" — not every mobile screen was opened.
