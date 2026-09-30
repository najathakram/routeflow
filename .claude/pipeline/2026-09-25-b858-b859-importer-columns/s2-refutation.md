# S2 — Cause refutation (Opus, in-session, read-only) — B858 + B859

Inputs: s1-products.md, s1-contacts.md. Base 21085bcb.

## Verdict: CONFIRMED (both)

**B858** — `apps/api/src/import/import.service.ts:1670-1680` reads exactly five header families (`Item Name|Name`,
`Rate|Sales Rate|Price`, `Description|Item Description`, `Unit|Usage Unit`, `SKU`); `create()` at 1693-1702 writes
only name/description/pricePerUnit/unit/sku/isActive. Every other column is dropped with no signal. On a
case-insensitive name match (1684-1691) the row is counted `skipped` and `continue`s — never updated, no reason.
Refutation attempts that failed: (a) no header-normalizing layer exists — `parseCsv` (56-79) keys rows by the raw
trimmed header, so "Units Per Box" cannot reach any field; (b) the richer JSON path `POST /products/import`
(`importFromZoho`) is unreachable from any UI (`useImportProducts` has zero call sites) and itself lacks
unitsPerBox/tiers/isTobacco/msrp/standardCost, and writes ONE price into all four tiers; (c) the migration page
posts to the staging API with name/sku/price/unit/category only (B205 owns its parser).

**B859** — `importContacts` (214-533) has no read of any commercial header: pricingTier, creditLimit,
isTaxExempt, taxId, defaultPaymentTerms, tobaccoLicenseNo/Expiry, deliveryWindowStart/End, consent. Unlike
products, a match (zohoContactId, else case-insensitive business name, 306-320) DOES update — but only the
identity/contact field set (322-406), so a re-import still cannot fill terms/tier/limit.

## Additional facts the fix must respect (found while refuting)

1. **Silent skips, both importers**: skip branches at 1672, 1690 (products) and 234, 245, 519-520 (contacts,
   incl. P2002) add no reason; `pushRowError` (86-90) emits only "`<name>: import failed`". This is part of the
   defect (the operator cannot see what was dropped) — matches the owner's "skips are silent" goal.
2. **Money parse**: products price uses `parseImportMoney(...) || 0` (1677) — a present-but-unparseable price
   silently becomes $0.00 (contradicts parse-import-number.ts' NaN-means-absent contract). Same trap would hit
   every new money column if copied.
3. **Guards the CSV path bypasses today**: `ProductsService.create` enforces `assertCanFlagTobacco`
   (tobacco_dealer addon), `assertMsrpAllowed` (plan flag), sku/barcode/unitSku cross-collision checks, and emits
   `emitProductChanged`; CSV `importProducts` calls none. Writing isTobacco/msrp/barcode from CSV without these
   gates would open an entitlement bypass.
4. **AVCO**: `averageCost` is ledger-derived (B562 lane refuses sales-blind averages). A CSV that overwrites
   averageCost on an existing product with stock would corrupt costing. `standardCost` is a plain passthrough.
5. **Schema**: Product unitsPerBox/reorderPoint/reorderQty Int?; priceTier2-5 Decimal(10,2) default 0;
   standardCost/averageCost Decimal(10,4)?; msrp Decimal? (present on master); isTobacco Bool; barcode/sku/unitSku
   @@unique per tenant; name unique via raw partial indexes. Customer pricingTier Int default 1 (DTO 1-5);
   creditLimit Decimal(10,2)?; defaultPaymentTerms String? restricted by DTO to VALID_CUSTOMER_TERMS
   ("Due on Receipt","Net 15","Net 30","Net 45","Net 60",""); isTaxExempt Bool; taxId String? (≤40);
   tobaccoLicenseNo/Expiry have NO write path anywhere today; delivery window strings; no enums → L-072 N/A.
6. **Geocoding**: CustomersService.create/update geocode (`geocodeIfPossible`, GOOGLE_MAPS_API_KEY); importer
   never does. External paid API per row.
7. **Harness**: only import-robustness.spec (REG-B98, REG-B112), import-address-state.spec, import-customer-cap.spec
   exercise the two CSV importers; none asserts the dropped columns or skip semantics → low stale-mock risk,
   but all use `createMockPrisma()`; a new update path needs `product.update`/`findMany` mocks.
8. Callers: web settings/import page (both cards) + customers/page.tsx modal (contacts). No scripts/e2e callers.

## Undetermined / owner questions (design, not cause)

Re-import match key + overwrite policy; averageCost handling; tobacco/msrp gating behavior on import;
geocoding in or out; dry-run shape; whether the dead JSON path is wired, left, or removed.
