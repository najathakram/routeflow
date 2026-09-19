# Industry standards — remaining RouteFlow work items

Research-only, 2026-09-19. Every URL fetched this session; "unsourced" = could not confirm.

## 1. Units of measure / packaging
Pattern: stock lives in ONE immutable base UoM; every alt UoM stores a factor to base (SAP: numerator/denominator, base=1/1; NetSuite: rate = qty per 1 base unit; Odoo: category+ratio, base="reference unit"). Price lists key on the line's own UoM; qty-in-base is always snapshotted for stock/costing. GS1: each→inner pack→case→pallet, one GTIN/level.
Refs: [SAP UoM](https://help.sap.com/docs/SAP_S4HANA_ON-PREMISE/f7fddfe4caca43dd967ac4c9ce6a70e4/a07cbd534f22b44ce10000000a174cb4.html) · [Odoo ratio](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/product_management/configure/uom.html) · [NetSuite rate](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N2212143.html) · [GS1 levels](https://www.gs1uk.org/knowledge-hub/product-identification/what-are-product-packaging-levels)
Rule most get wrong: editing a factor after documents reference it — SAP/NetSuite lock the base factor at 1 and expect historical docs to keep the factor that priced them.
Drop-in: none good — `convert-units` (npm, 2.3.4, published 2018, dead). Write a ratio-table module in `@routeflow/pricing`.

## 2. PO / receiving / three-way match
Pattern: draft → issued → (partially) received → billed → closed. Three-way match compares PO/receipt/bill qty+price before payment. Zoho/QuickBooks/Odoo all let you convert a PO straight to a bill (against a receipt, or against yet-to-receive) or mark a standalone bill Received to reconcile stock.
Refs: [Zoho](https://www.zoho.com/us/inventory/help/purchase-orders/bills.html) · [QuickBooks](https://quickbooks.intuit.com/learn-support/en-us/help-article/purchase-orders/add-purchase-orders-expenses-bills-checks-online/L9pRK49uC_US_en_US) · [Odoo 3-way match](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/purchase/manage_deals/control_bills.html).
Rule most get wrong: not blocking a bill exceeding the PO's remaining qty/price — Odoo only warns ("Should Be Paid"→"Exception"), mistaken for a hard gate.
Drop-in: none — workflow, not a library.

## 3. Mobile barcode scanning (Expo/RN)
Pattern: `expo-camera`'s `CameraView` (`onBarcodeScanned`, `barcodeScannerSettings`) is lowest-effort but has known Android autofocus flakiness up close; `react-native-vision-camera` + `useCodeScanner` (ML Kit both platforms in v5) is steadier. UX: debounce re-fires of the same code, haptic+beep on accept, scanned-list under a compact viewfinder, torch toggle.
Refs: [Expo Camera](https://docs.expo.dev/versions/latest/sdk/camera/) · [Android autofocus issue](https://github.com/expo/expo/issues/16126) · [VisionCamera v5](https://blog.margelo.com/react-native-qr-barcode-scanner-visioncamera-v5) · [Scandit UX](https://www.scandit.com/resources/guides/sparkscan-product-brochure/).
Rule most get wrong: no per-code cooldown, so one scan yields duplicate rows from repeated frame callbacks.
Drop-in: `react-native-vision-camera` (npm v5.2.3, maintained 2025/2026).

## 4. Taxonomy + jurisdiction restrictions
Pattern: Shopify's OSS [product-taxonomy](https://github.com/Shopify/product-taxonomy) (categories+attributes) is the closest reference; Shopify Markets bans by per-market prohibited-item review (tobacco blanket-banned). Avalara/Vertex model jurisdiction rules as tax-category exemptions, not sell/no-sell flags. Public Health Law Center keeps an actively-updated 50-state flavored-tobacco/vape dataset.
Refs: [Shopify Markets prohibited items](https://help.shopify.com/en/manual/international/managed-markets/prohibited-items) · [PHLC map/dataset](https://www.publichealthlawcenter.org/us-sales-restrictions-flavored-tobacco-products-map) · [Google Address Validation](https://developers.google.com/maps/documentation/address-validation/overview).
Rule most get wrong: comparing free-text state names against a ban list instead of normalizing to `US-XX` first — Google's API returns the USPS 2-letter `administrativeArea`, so `"US-" + administrativeArea` is the whole job.
Drop-in: none needed (trivial prefix). PHLC has no public API found — manual/quarterly refresh (unsourced beyond their PDF export).

## 5. SaaS entitlements: preview + snapshot/restore
Preview: Stripe's preview-invoice API simulates a plan update, returning the resulting invoice incl. proration before commit. Schematic documents versioning+previewing a plan and replaying usage against a draft before rollout — no vendor's literal "gained/lost features" diff UI found (unsourced).
Snapshot/restore: standard shape is event-sourcing's snapshot pattern — persist a serialized snapshot at the state-changing event, event log stays source of truth, rehydrate from last snapshot + later events. No vendor confirms an "N days preserved" SLA on downgrade→re-upgrade (unsourced); Chargebee's pause/resume documents preserving state, a distinct feature.
Refs: [Stripe preview invoice](https://docs.stripe.com/api/invoices/create_preview) · [Schematic](https://schematichq.com/) · [Azure event-sourcing snapshot pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing).
Rule most get wrong: hard-deleting config on downgrade instead of archiving it (matches this project's 2026-09-18 ruling: archive, restore as-was on re-upgrade).
Drop-in: none — build the snapshot table per the shape above.

## 6. B2B quick-order entry UX
Pattern: Shopify B2B's quick-order grid, Faire's reorder pad, Zoho/Magento equivalents converge on: spreadsheet-like grid (not product-page browsing), SKU/name typeahead, CSV/paste-list bulk entry, saved lists for repeat buyers, live stock/price per row. Baymard runs a paid B2B vertical (25+ sites) but a per-feature breakdown is paywalled (unsourced at that granularity).
Refs: [Shopify B2B quick order](https://www.lucentinnovation.com/resources/it-insights/b2b-wholesale-shopify) · [Baymard B2B vertical](https://baymard.com/research/business-to-business) · [Baymard cart-collab guideline](https://baymard.com/guidelines/2682-cart-collaboration-features-for-b2b-items).
Rule most get wrong: no duplicate-line merge — adding the same SKU twice (search vs. saved list) creates two lines instead of one.
Drop-in: none — UI pattern on `apps/web`'s existing grid, not a package.

## 7. Monotonic short ID allocation across git branches
Pattern: (a) central counter/"ticket server" (Flickr: one DB row per key, atomic upsert bump) — GitHub issue numbers work the same way, a central sequence, never a branch scan; (b) scan-all-refs max+1, no atomicity once two branches allocate concurrently; (c) ULID/UUID, collision-free but not short/readable.
Refs: [Flickr ticket servers](https://code.flickr.net/2010/02/08/ticket-servers-distributed-unique-primary-keys-on-the-cheap/) · [git-bug (hash-based)](https://github.com/git-bug/git-bug).
Recommendation: for short human-readable ids (`B569`-style), prefer a single central counter over scan-all-branches max+1 — the latter is the race this project's registry already works around procedurally ("file bugs only on master-merged trees").
Drop-in: `ulid` (npm v3.0.2, actively maintained, ~2025) if readability can drop for collision-free sortable ids.

## 8. Postgres: nullable → NOT NULL without long locks (PG12+)
Pattern: `ADD CONSTRAINT t_col_nn CHECK (col IS NOT NULL) NOT VALID` (instant) → `VALIDATE CONSTRAINT t_col_nn` (scans, only `SHARE UPDATE EXCLUSIVE`, no blocking) → `ALTER COLUMN col SET NOT NULL` — PG12+ recognizes the validated CHECK and skips the scan on that last step.
Refs: [Doctolib: minimal-lock NOT NULL](https://medium.com/doctolib-engineering/adding-a-not-null-constraint-on-pg-faster-with-minimal-locking-38b2c00c4d1c) · [PG12+ gist](https://gist.github.com/jjb/fab5cc5f0e1b23af28694db4fc01c55a) · [Squawk rules](https://squawkhq.com/docs/rules).
Squawk rules: `adding-not-nullable-field`, `constraint-missing-not-valid`, `ban-drop-not-null`, `disallowed-unique-constraint`.
Rule most get wrong: the CHECK must be exactly `CHECK (col IS NOT NULL)` — a differently-worded equivalent forces the full scan anyway.
Drop-in: none — raw DDL, matches `apps/api/scripts/schema-drift.mjs`.

## Reuse table

| Item | Adopt |
|---|---|
| 1. UoM | Odoo's category+ratio shape in `@routeflow/pricing`; base factor=1, immutable once used |
| 2. PO/receiving | Zoho/Odoo PO→receipt→bill machine + "convert to bill against yet-to-receive" |
| 3. Barcode scan | `react-native-vision-camera` + `useCodeScanner` if `expo-camera` autofocus stays flaky |
| 4. Jurisdiction | `"US-" + administrativeArea` from Google Address Validation; PHLC map = manual refresh |
| 5. Entitlements | Stripe preview-invoice pattern for plan preview; event-sourcing snapshot for restore |
| 6. Quick order | Shopify B2B / Faire grid: typeahead + CSV/paste + saved lists + line-merge |
| 7. ID allocation | Central counter (ticket-server / GitHub-Issues style), not scan-all-branches max+1 |
| 8. NOT NULL | `CHECK (col IS NOT NULL) NOT VALID` → `VALIDATE CONSTRAINT` → `SET NOT NULL` |
