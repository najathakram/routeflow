# Remaining-work context pack — 2026-09-19 (read-only)

Section-A paths relative to `local-assets/handoff/`. Section-B verified against
`origin/master @357db4a6` via `git show`/`git grep` (local checkout `06752f88` is 30
commits stale — don't trust local reads for billing/schema).

## A1 — `2026-09-18/PLAN-units-po-MINIMAL.md` (units + PO)
- Scope: re-scope of a rejected v4 (≈113 lane-days). Adds `unitLabel` on order/invoice
  lines (relabels the existing boxes/pieces triple, no new unit table), links PO↔bill,
  fixes PO edit+re-apply. Web PO surface (`inventory/page.tsx`, 3,303 lines) already exists
  — "nothing to build but an Edit modal."
- Effort: **≈57h / 7 builder-days; ≈4 wall-clock days on 2 lanes**. First owner-visible
  slice ready at ≈13h/day 2.
- Dependencies: steps 1-6 sequential (units), 7-9 (PO) parallel lane; step 4/6
  (order+invoice write paths, 20h) = critical path.
- Open questions: no dedicated heading; §5 lists 9 risks the owner can overrule "by line
  number" (re-apply is whole-doc reverse not delta; mobile can't edit case-line qty; default
  unit web-only; no unit levels above pack on regulated products til Phase 2).

## A2 — `2026-09-18/units-po-plan/industry-patterns-uom-po.md` — patterns already settled
1. Base-unit-as-reference UoM (D365 BC/Odoo/ERPNext: one reference unit factor=1, every
   other unit stores a conversion factor) — §1.
2. Rounding remainder: post to a variance account or load onto the last unit, never
   drop/invent value — mirrors RouteFlow's own `roundMoney`/`computeLineSubtotal` — §2.
3. Never mutate a conversion factor in place once docs reference it — close/repost first,
   or mint a new unit (SAP failure mode) — §3.
4. GS1: a pack-quantity change needs a **new barcode** at that level and above; barcode is a
   property of (product, packaging-level), not the product — §4.
5. PO/GRN/Invoice are 3 independently-falsifiable docs (intent/physical fact/payment claim);
   collapsing any two removes a fraud/error control — §5.

## A3 — `2026-09-18/scanner-redesign-spec.md` (barcode scan-to-order)
- Scope: redesigned in-modal scan screen (accumulating list, price editor, undo, poor-signal
  queue), extract `LineItemRow` out of `CreateOrderModal.tsx`, port mobile's proven
  scan-loop/buffer/cue engine into `apps/web`. Non-goals: multi-level units (defers to A1),
  mobile's own camera screens, `BarcodeDetector` engine, a dedicated route.
- Effort: no hour/day total; §8 sizes per item — W1 LineItemRow extract=medium (blocking
  prereq), W2 camera fix=small-medium (independent, shippable alone), W3 port engine=small,
  W4 ScanOrderScreen=large ("the actual feature"), W5 PriceEditor=medium, W6 poor-signal
  queue=medium, W7 dual-decode=stretch/optional.
- Dependencies: W1+W2 parallel first → W3 → W4 (needs all 3) → W5 (parallel w/ W4 tail) →
  W6 last.
- Open questions (§10): 10.1 customer-first pricing (3 options, changes W4 scope, decide
  **before** W4 starts); 10.2 item-count = distinct SKUs vs total units; 10.3 promote ported
  modules to `packages/scanning` now vs accept a 2nd mirror pair (not blocking); 10.4
  ambiguous-match picker deferred to v2 (no evidence of a real complaint).

## A4 — `2026-09-18/order-ui-redesign-spec.md` (order line-item + post-creation UX)
- Scope: fix long/ambiguous product-name wrapping on order-detail rows, converge on ONE
  shared `LineItemRow` (editable + read-only variants) with the scanner spec, add a
  post-create "View Order" toast, restructure the action-bar hierarchy. Written parallel
  with A3, treats A3's `LineItemRow` extraction as a hard prerequisite (T3).
- Effort: no total; §10 sizes per task — T1 widen selects=small, T2 toast=small, T4 extend
  LineItemRow=medium, T5 name composition=small, **T6 table→card list=large** ("visible
  centerpiece"), T7 action-bar sequenced after T6 (same 3700-line file), T8 RN
  mirror=medium, T9 file 2 bugs=trivial-but-required.
- Dependencies: T3 (scanner's W1) blocks T4+; T4+T5 block T6; T6 blocks T7 and T8.
- Open questions: **none under a dedicated heading** — facts marked VERIFIED/PROPOSED; no
  owner-decision list found.

## A5 — `2026-09-18/PLAN-categories-jurisdiction-bans.md` (multi-category labels + selling bans)
- Scope: 3 new tables (`ProductCategory`, `ProductCategoryLabel`, `SellingRestriction`), a
  fail-closed `SellingRestrictionsService`, enforcement at every sale path, buyer-catalog
  hiding, governing-address resolution (tenant setting).
- Effort: **13 lane-days build + 2 review/landing = 15; floor ≈11** cutting 4 *(cuttable)*
  items — §7 table.
- Dependencies: steps 1→2 shippable standalone; 3+4 land as one PR ("rules without
  enforcement would be the B519 defect"); 5 follows 4 (no UI ships ahead of its server check).
- Open questions (§9): (1) "registered address" = customer's default address vs a new
  `CustomerAuthorization` licensed-premises field (+0.5d); (2) cron/driver-approved buyer
  changes = staff surface (chosen) or buyer, one-line flip; (3) block qty *increases* on a
  pre-ban line (chosen) or allow; (4) who may write rules — `TENANT_ADMIN` only (chosen) or
  any `OPERATOR`.
- **9 enforcement points** (§3 table; excludes EXEMPT rows [merges, import] and 2
  buyer-visibility rows [catalog/dashboard, cart pricing]): `create`, `changeStatus`,
  `updateOrderItems`, `approveChangeRequestAtStop`, templates, recurring invoices,
  `createSplitInvoices`, `update`/`duplicate`, `convertToInvoice`.

## A6 — `standing-items-status.md`
- **§1 Feature grants → Backoffice**: largely BUILT — briefs A/B(v2)/C(v2)/D all merged
  2026-09-17 (#825, #838, #837, #836). Un-built: PR-0/PR-0b consolidation (delete
  `DARK_PLAN_FLAGS`/`PREPIN_DARK_FLAGS`/`PLAN_FLAG_ENFORCEMENT`, still present per §8), plus
  an owner walkthrough of Feature Console #836 vs the "better than generic" bar — neither
  done.
- **§7 three open questions**: (a) **PR-0b** — gated on owner's zero-loss report proving no
  live tenant loses a currently-effective entitlement before the resolver flips authoritative.
  (b) **CRM Phase 1** — open Qs: lead-reassignment ownership (Q4), how loud an upgrade
  prompt at the customer-limit edge (Q5), allowed call-outcome list (Q6), a locking-reuse
  call, owner's "dogfood baseline" prospect count. (c) **B462** — should a DRAFT invoice's
  total count toward a customer's credit-limit exposure? (blocks check-payments PR-2).
- **§3 null-tenant "structural tables" wording**: "the remaining owner-scoped decision
  (whether structural tables like AuditLog/RefreshToken should carry `tenantId` at all — an
  RLS-spec question) has no update."

## A7 — `2026-09-19/decisions-prep.md` — Android-publish blockers
**10 blockers listed** (#6 already DONE via PR #862): 1 seed EAS versionCode counter
(owner-only, interactive TTY) · 2 paste real Maps API key into EAS env (owner-only,
credential) · 3 build internal APK (owner-only, no CI token) · 4 verify Maps key reached
the built artifact (lane-buildable) · 5 verify native Google Sign-In on a physical device
(owner/human-only; OAuth client rotated 2026-09-11, pre-09-11 verification void) · 6
privacy/terms pages — **DONE** · 7 in-app background-location disclosure screen
(lane-buildable, doesn't exist yet) · 8 `FOREGROUND_SERVICE_LOCATION` Play Console
declaration (owner-only) · 9 Play Console reviewer credentials (owner-only) · 10 investigate
4 old driver bugs B148/B49/B128/B34 (lane-buildable).

## A8 — lane-plan.html (`Seven Lanes, Eight Days`, scratchpad)
Uses **numbered lanes 1-7**, not U/R/S/B letters. ~75 tasks, 35
lane-days, **8 working days wall-clock**, 7 CI windows, 2 owner gates. Lanes: 1 Schema
spine & catalog API · 2 Sales write paths & customer data · 3 Purchasing & catalog web
(inventory/vendor-bills/products) · 4 Selling restrictions · 5 Web order surfaces (waits on
Lane 1) · 6 Scanner (camera ladder/engine/screen) · 7 Mobile mirror & 11 registry bugs.
Serial spine (6 of 8 days): Day1 LineItemRow extraction → Day2 schema migration → Day2.5-4
unit-aware write paths (~12 sites) → Day5 unit picker → Day6-7 integration. Two owner gates:
Day2 apply prod migration (blocks 4 lanes), Day4 run address-normalization script (blocks
restrictions going live). 2-day scope-cut option ships only autofocus fix + toast + schema
groundwork + ~9 bug fixes — none of the 4 requested features.

---

# Section B — repo facts (already exists, reuse)

**B1 — Prisma models.** On `origin/master`, already exist: `PurchaseOrder`
(catalog.prisma:242), `PurchaseOrderItem` (:265), `VendorBill` (finance.prisma:655),
`VendorBillItem` (:816), `TenantFeatureConfig` (platform.prisma:201), `FeatureResolverDiff`
(:177). `ProductUnit`, `SupplierProduct`, `ProductCategoryLabel`, `SellingRestriction` do
**NOT** exist on master — only on unmerged `origin/feat/l1-schema-spine` (catalog.prisma:313,
:346, :399; compliance.prisma:362) — the exact 4 new models A1+A5 propose look already
scaffolded there. `PurchaseOrder` fields: id, poNumber, supplierId, status(enum default
DRAFT), expectedDate?, notes?, totalAmount Decimal(10,2), timestamps, tenantId?,
unique(tenantId,poNumber). `PurchaseOrderItem`: id, poId, productId, qtyOrdered/qtyReceived
Decimal(10,3), unitCost Decimal(10,4), totalCost Decimal(10,2), tenantId?.

**B2 — PO API/UI.** No dedicated `purchase-order*` module — lives inside
`apps/api/src/inventory/` (`inventory.controller.ts`/`.service.ts`,
`dto/{create,list}-purchase-order(s).dto.ts`). Routes: `POST movements/purchase`,
`POST purchase-orders`, `GET purchase-orders(/:id)`,
`POST purchase-orders/:id/{send,receive,close}` — no edit endpoint. Web:
`inventory/page.tsx` + `vendor-bills/(page,[id]/page).tsx` reference `PurchaseOrder`; no
standalone `purchase-order*` page exists.

**B3 — Vendor-bill OCR/scan.** Entry: `POST /vendor-bills/scan-invoice`
(`vendor-bills.controller.ts:72`), `@RequireAddon("ocr")`-gated, up to 10 files/25MB
(`FilesInterceptor`), 60MB aggregate cap. Service: `VendorBillsService.scanInvoice()`
(`vendor-bills.service.ts:1454`) — HEIC→JPEG, calls Anthropic, parses response, checks for
a prior scan, persists `InvoiceScan`+files, returns lines for review/creation as a
`VendorBill`.

**B4 — Mobile scanner.** Screens: `apps/mobile/components/ScanCamera.tsx` (+`.web.tsx`),
`BarcodeScanner.tsx` (+`.web.tsx`), `ScanOrderSheet.tsx`, plus
`app/(operator)/{products,vendor-bills}/scan.tsx`, `app/(customer)/scan.tsx`. Camera lib:
`expo-camera ~55.0.23`, no vision-camera (`package.json:38`). `ScanCamera.tsx` uses Expo's
`CameraView`, `autofocus="on"` (`:145`), `barcodeScannerSettings` w/ 8 formats incl `itf14`
(`:142-144`), `onBarcodeScanned={active?handleBarcodeScanned:undefined}` (`:149`) —
single-shot fires once then latches; continuous mode routes through a gate + pending-buffer
(`scan-loop.ts`/`scan-pending-buffer.ts`) so a mid-resolve detection queues, not drops. After
a scan, `products/scan.tsx:23,29` calls `router.replace(...)` to product detail.

**B5 — Web order entry.** `CreateOrderModal.tsx` = 2,059 lines; uses `react-hook-form` +
`@hookform/resolvers/zod` + `zod` (`:4-6`), plain `React.useState` for line-item state, no
TanStack Table. **`apps/web/components/LineItemRow.tsx` does not exist anywhere** — confirms
A3/A4 correctly describe it as something to extract, not present today. Buyer-portal orders
list: `apps/web/app/buyer/portal/[seller]/orders/page.tsx` — plain `<table>` (`:159`), no
TanStack Table; one `overflow-x-auto` div wraps a filter-chip row (`:110`), not the table
itself (no scroll wrapper).

**B6 — Entitlements.** (Local checkout stale — read via `git show origin/master`.) Resolver
entry: `EntitlementAuthority.resolveAll(tenantId)`
(`billing/entitlement-authority.service.ts:42,209`); also
`FeatureResolverService.resolve(tenantId)` (`feature-resolver.service.ts:51,66`) w/ pure
helpers `resolveOneKey`/`toEffectiveFeature`. A **preview** fn already exists:
`FeaturePreviewService.preview(tenantId,request)` (`feature-preview.service.ts:45`) —
before/after per key for a hypothetical plan change, 0 writes. No snapshot/restore/archive
fn found for entitlement config — matches memory: downgrade→re-upgrade "needs a new store +
migration, spec before building" (not yet coded). Platform-admin pages (13): audit-logs,
billing, buyers(+[id],merge-requests(+[id])), dashboard, plans, profile, settings,
tenants(+new,+[id]) — no standalone "features" page; Feature Console #836 is presumably a
tenants/[id] tab.

**B7 — Bug registry id minting.** `scripts/campaign/bugs.mjs`, in `withCatalogueLock`
(`:382-418`): `maxId = max(shardMaxId, catalogueRowsMaxId)` — union of the **local**
catalogue's ids and every **local** ledger shard's; new id = `B${maxId+1}` unless `--id`
pins a specific (must-be-ahead) id. **Does not scan remote branches** — local-tree-only
(hence "file bugs only on master-merged trees" + the lead `--id` reservation mechanism for
cross-lane collisions).

**B8 — Backup / DB URL scripts.** `apps/api/scripts/backup-production.sh`: wraps
`railway`+`pg_dump` → gitignored `./backups/production_<ts>_<label>.sql`, requires
`railway login`+`link` first. `apps/api/scripts/lib/railway-db-url.mjs` exports:
`RAILWAY_PROXY_VARS` (`:4`), `resolveDatabaseUrl(env,{requireProxy})` (`:20`),
`redactUrl(url)` (`:44`), `scrubSecrets(text,url)` (`:53`).

**B9 — e2e seed.** `apps/api/scripts/e2e-seed.js` creates tenant `e2e-routeflow`
(`assertTestTenant` guarded, `:76`) with an operator admin, an ops user, and **one customer**
(`harbor_cafe`, `Customer1!`, `:184-195`) — but **no product-creation code exists** (no
`product.create`/`prisma.product` match) — no seeded catalog, consistent with a B566-style
"no test products" gap.

**B10 — Address / normalization.** `CustomerAddress.state` is free-text `String`
(`sales.prisma:266-280`, no enum/FK) — confirms A5's "states are free text today" claim.
`Tenant` (`tenancy.prisma:82-110`) has **no address/region field at all**. The only
ISO-3166 code in `apps/api/src` is unrelated: `ISO_3166_ALPHA2` in
`crm/crm-connection.service.ts:109-110` validates a CRM `defaultRegion` **country** code.
No `normalizeState`/`addressValidation` utility exists anywhere in `apps/api/src`.
