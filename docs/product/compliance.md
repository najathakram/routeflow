# Regulated Goods & Compliance

_Licence gating, category tax, and jurisdiction filings for tobacco, alcohol, deposit and other
regulated product lines._

## The problem

A wholesale distributor that carries tobacco, vape, alcohol or deposit-bearing goods is running a
licensed business on top of an ordinary order book. Three obligations sit outside anything a
spreadsheet or an accounting package tracks: only a licensed retailer may legally buy the goods,
and that licence expires; every regulated sale must be reported to a state agency in that agency's
own column layout on a fixed cadence; and a per-unit excise or deposit must be collected on the
line and remitted. Today that means licence photos in a WhatsApp thread nobody re-checks, a
monthly filing rebuilt by hand from invoice PDFs (with voids, returns and credit notes silently
missing from the totals), and an excise figure re-derived differently every time someone asks for
it. One sale to a lapsed licence, or one filing that does not tie to the books, puts the licence
itself at risk — which is the whole business, not a line item.

## Why it matters to a tenant

The licence becomes a hard gate at order entry rather than a folder someone forgot to open: an
order line in a licence-required section is refused with a structured 409 (`REGULATED_AUTH_REQUIRED`)
unless the customer holds a VERIFIED, unexpired authorization or a deliberately recorded override,
and expiry is evaluated live so a licence that lapsed overnight blocks the next morning's order.
Every regulated line writes an append-only ledger row that nets automatically when the invoice is
voided, the goods are returned, or a credit note is issued — so the reported period is the reported
period, not an estimate. The filing itself is prepared by a nightly cron the day after a period
closes and downloaded as a CSV in the jurisdiction's own layout (TX Comptroller per-sale, CA CDTFA
/ CA ABC / CalRecycle aggregate), turning a two-day reconstruction into a download. Excise is
computed once by a shared rounded-to-cents helper (`computeCategoryTax`) that never re-derives a
boxed line as `qty x unitPrice`, so the invoice, the order and the filing all report the same
number.

## Core use cases

1. **Classify the regulated line and levy it correctly** — Define the regulated sections this
   business handles separately (tobacco, alcohol, CRV deposit, a city sugar levy), give each one a
   tax rule, an invoicing treatment and a reporting template, tag products into it, and have every
   order and invoice line permanently snapshot which section it belonged to and how much category
   tax it carried at the moment of sale.
2. **Prove the buyer was allowed to buy it** — Hold a per-customer, per-section licence record with
   a number, an expiry and a verification trail; refuse the sale when it is missing, rejected or
   expired; let the buyer submit their own licence for review; and record an explicit, attributable
   override when a seller chooses to sell under their own responsibility anyway.
3. **File the period** — Maintain an immutable per-line regulated sales ledger that nets voids,
   returns and credit notes back out, aggregate it into a period filing in the jurisdiction's
   prescribed column layout, and keep the generated filing as the archived compliance artifact.

## Must have (P0)

| ID      | Capability                                               | Status     | What it does                                                                                                                                                                                                                                           | Evidence                                                                                                                                                                                                                                                                                                                                                            |
| ------- | -------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REG-M1  | Define a regulated type (section)                        | SHIPPED ✅ | Tenant creates its own regulated classes with tax rule, invoicing treatment, licence requirement, report template and cadence; deactivating one keeps historic sales intact.                                                                           | `TrackedCategory` (`apps/api/prisma/schema.prisma:3531`); `apps/api/src/tracked-categories/tracked-categories.controller.ts`; web `RegulatedSettingsTab.tsx` + `CategoryFormModal.tsx`; mobile `(operator)/regulated/*`                                                                                                                                             |
| REG-M2  | Assign products into a regulated type                    | SHIPPED ✅ | Bulk-tag catalogue products into a section (and optional subcategory); untag them again.                                                                                                                                                               | `POST /tracked-categories/:id/products/{assign,unassign}` (`tracked-categories.controller.ts:47-55`); `products.service.ts` `assertSubcategoryInSection`; web `AssignProductsModal.tsx`                                                                                                                                                                             |
| REG-M3  | Sale-time classification snapshot                        | SHIPPED ✅ | Order and invoice lines permanently record the section/subcategory at sale time, so re-categorising the catalogue later never restates a filed period.                                                                                                 | `OrderItem`/`InvoiceItem.trackedCategoryId`/`trackedSubcategoryId`, `Order.hasRegulated` (`schema.prisma:1311`); snapshot writes in `orders.service.ts` and `invoices.service.ts`                                                                                                                                                                                   |
| REG-M4  | Category (excise / deposit / percentage) tax on the line | PARTIAL 🟡 | Each regulated line computes its own category tax (per-unit, per-volume, per-container, or percentage), rounded to cents and folded into the total.                                                                                                    | `computeCategoryTax`/`CategoryTaxType` (`apps/api/src/common/pricing.ts:194-250`); `orders.service.ts recomputeLineCategoryTaxes`; `invoices.service.ts foldCategoryTax`. PARTIAL: `applyPriceAdjustment` never recomputes `categoryTaxAmount` (bug register B57, Critical/Open); `PER_VOLUME` multiplies piece count, not true volume (no `Product.volumePerUnit`) |
| REG-M5  | Customer licence (authorization) lifecycle               | SHIPPED ✅ | Per customer, per section: number, expiry, verify/reject/renew, with a FK-less verifier snapshot.                                                                                                                                                      | `CustomerAuthorization`; `POST /customers/:customerId/authorizations` + `approve/reject/renew` (`authorizations.controller.ts`); web `AuthorizationsTab.tsx`; mobile `(operator)/customers/[id]/licenses.tsx`                                                                                                                                                       |
| REG-M6  | Block the unlicensed regulated sale                      | SHIPPED ✅ | Refuses the order/invoice unless the customer holds a VERIFIED, unexpired authorization or an active override; re-checked at every point the basket can change.                                                                                        | `authorization-guard.service.ts` `checkAuthorized`/`assertAuthorizedOrThrow` (409 `REGULATED_AUTH_REQUIRED`); hooked at 6+ sites incl. `orders.service.ts` create/update/changeStatus/merge, `change-requests.service.ts`, `invoices.service.ts` in-transaction backstop                                                                                            |
| REG-M7  | Immutable regulated sales ledger that nets reversals     | PARTIAL 🟡 | Every regulated invoice line writes an append-only SALE row; voids/deletes/returns/credit notes write negated REVERSAL rows.                                                                                                                           | `RegulatedSalesLedger`; `regulated-ledger.service.ts`. PARTIAL: `orders.service.ts deleteOrder` hard-deletes linked invoices inline with **no** ledger reversal — `RegulatedLedgerService` isn't even imported there (B65, High/Open)                                                                                                                               |
| REG-M8  | Prepare and archive a period filing                      | SHIPPED ✅ | Rolls a closed period's ledger into a persisted filing with signed net totals plus a stored CSV, unique per (tenant, section, period).                                                                                                                 | `POST /regulated/filings/prepare`, `GET /regulated/filings`, `GET /regulated/filings/:id/csv`; `regulated-filing.service.ts prepareFiling`; `RegulatedFiling` `@@unique([tenantId,trackedCategoryId,periodKey])`                                                                                                                                                    |
| REG-M9  | Jurisdiction report templates                            | SHIPPED ✅ | Filing comes out in the agency's own layout — TX Comptroller per-sale, CA CDTFA/ABC/CalRecycle aggregate, generic fallback.                                                                                                                            | `template-registry.ts REPORT_TEMPLATES`; served at `GET /regulated/templates` — class-level `JwtAuthGuard + RolesGuard(OPERATOR) + AddonGuard` still applies (verified: not addon-gated at the route, but authenticated and OPERATOR-only, not public); `tx-report.ts`; `filing-csv.ts`; `report-csv.ts`                                                            |
| REG-M10 | Licence expiry sweep and warnings                        | SHIPPED ✅ | Nightly job flips lapsed VERIFIED licences to EXPIRED and warns operators + buyer at 30/7/1 days out.                                                                                                                                                  | `authorization-expiry.service.ts` `@Cron("0 3 * * *")`; `GET /authorizations/expiring-soon`; `GET /buyer/authorizations/expiring`                                                                                                                                                                                                                                   |
| REG-M11 | Tenant isolation of every regulated artifact             | SHIPPED ✅ | Sections, licences, ledger rows, filings and stored CSVs are all tenant-scoped and unreachable from another tenant, including via a stored-object path.                                                                                                | `forTenant()` scoping throughout `regulated.service.ts`, `authorization-guard.service.ts`, `tracked-categories.service.ts`, `regulated-filing.service.ts`; tenant-prefix check at `apps/api/src/uploads/uploads.controller.ts:155` (verified: correct path is `apps/api/src/uploads/uploads-tenant-scope.security.spec.ts`, not a `regulated/../` path)             |
| REG-M12 | Audit trail of compliance actions                        | PARTIAL 🟡 | Every mutation plus named domain events (`regulated_filing.prepared`, `regulated_authorization.submitted`/`.expired`) is audit-logged; overrides are append-only with actor snapshots.                                                                 | `audit.interceptor.ts`; `authorization-overrides.service.ts`. PARTIAL: the only read surface is `GET /platform-admin/audit-logs` (SUPER_ADMIN-only) — no tenant-facing audit endpoint exists (see REG-A8)                                                                                                                                                           |
| REG-M13 | Licence-holder customer roster                           | SHIPPED ✅ | Filter the customer list to only buyers authorized to sell regulated items, with a per-row licence count, so an operator can see which buyers are actually licensed right now.                                                                         | `GET /customers?regulated=1` (`dto/list-customers.dto.ts:13-14`); `customers.service.ts:135-137,172,228` (`regulatedCount` via filtered `_count`); web `apps/web/lib/api/customers.ts:91-92`; specs `customers.service.spec.ts:165-203`                                                                                                                             |
| REG-M14 | Reopen-stop wipe of the age/ID compliance record         | BROKEN 🔴  | Reopening a completed delivery stop silently discards the recorded signature and age/ID verification, with no appended trail — a third evidence-destruction path alongside route delete (B96) and pod-artifact overwrite (B121), and driver-reachable. | `POST /route-runs/:id/stops/:stopId/reopen` (`routes.controller.ts:294-301`, roles OPERATOR/DRIVER) → `routes.service.ts:2236 reopenStop`, which at `:2361-2365` sets `signatureUrl: null, ageVerified: false, identityVerified: false, identityType: null, identityVerifiedAt: null`                                                                               |

### Testing criteria

#### REG-M1

- [ ] Creating two sections with the same name in one tenant returns 409 (P2002 mapped); the same name in a different tenant succeeds. `Jest`
- [ ] `PATCH /:id/toggle` on an active section with assigned products deactivates it without touching existing snapshots or ledger rows. `Jest`
- [ ] `GET /tracked-categories` under tenant A never returns tenant B's rows, including via `GET /:id` (must 404, not leak the name). `Jest`
- [ ] A CUSTOMER-role session gets 403 on `POST /tracked-categories`; a TENANT_ADMIN succeeds. `Playwright`

#### REG-M2

- [ ] Assigning 200 product ids issues a single `updateMany`; re-running is idempotent. `Jest`
- [ ] Assigning a product id belonging to another tenant updates zero rows without throwing. `Jest`
- [ ] Setting a subcategory that belongs to a different section is rejected 400. `Jest`
- [ ] A variant with no explicit section inherits its parent's section+subcategory on create. `Jest`

#### REG-M3

- [ ] Re-categorising a product after an order was created does not restate that order's snapshot. `Jest`
- [ ] Adding/removing a regulated line flips `Order.hasRegulated` in the same transaction as the line write. `Jest`
- [ ] A buyer-merge that keeps the loser's regulated line preserves its category snapshot. `Jest`
- [ ] Invoicing copies the order line's snapshot onto `InvoiceItem`, falling back to the live product only when absent. `Jest`

#### REG-M4

- [ ] `PERCENT_OF_SALE` at 0.05 on a 100.00 subtotal returns 5.00; with `priceIncludesTax` returns 4.76. `Jest`
- [ ] `EXCISE_PER_UNIT` on a boxed line multiplies the expanded piece count, never the box count. `Jest`
- [ ] Invariant: `Invoice.taxAmount` equals rounded line tax plus rounded category tax; `Invoice.total` reconciles to the cent. `Jest`
- [ ] FAILING TODAY (B57): halving a `PERCENT_OF_SALE` line's unit price via `applyPriceAdjustment` must halve its `categoryTaxAmount` and mirror onto the order. `Jest`
- [ ] A tax-exempt customer's regulated invoice stores `categoryTaxAmount = 0` on every line. `Jest`

#### REG-M5

- [ ] `renew()` on a REJECTED or PENDING_REVIEW row is refused — only VERIFIED or EXPIRED may renew. `Jest`
- [ ] Two concurrent `create()` calls for the same (customer, section) produce exactly one row. `Jest`
- [ ] Deleting the verifying user leaves `verifiedByName`/`verifiedAt` readable. `Jest`
- [ ] Cross-tenant `customerId` or `trackedCategoryId` writes nothing and 404s/403s. `Jest`
- [ ] Capturing an already-expired date is blocked client-side with no network write. `Playwright`

#### REG-M6

- [ ] A section with `requiresLicense=false` never blocks, regardless of authorization state. `Jest`
- [ ] A VERIFIED authorization one second past `expiresAt` is blocked as EXPIRED before the nightly sweep runs. `Jest`
- [ ] A DRAFT order may hold an unlicensed line; promoting it throws 409 and status is not persisted. `Jest`
- [ ] The invoice backstop fires when a licence expires between order creation and invoicing — no invoice, no items, no ledger rows are left. `Jest`
- [ ] The 409 body carries `blockedCategories[]` with `trackedCategoryId`, `categoryName`, `reason`. `Jest`

#### REG-M7

- [ ] Invariant: for any order line, the signed sum of all ledger rows is never negative. `Jest`
- [ ] Voiding an invoice twice writes reversal rows exactly once. `Jest`
- [ ] A partial return pro-rates off the live sale row's snapshot and a full return balances to 0.00. `Jest`
- [ ] FAILING TODAY (B65): `deleteOrder` on an order with an issued regulated invoice must leave ledger net at 0.00; today it does not. `Jest`
- [ ] A reversal books into the current period bucket, not the original sale's. `Jest`

#### REG-M8

- [ ] Preparing a period whose end is in the future is refused 400. `Jest`
- [ ] Invariant: `totalNetSales` agrees across the filing row, the persisted rows JSON, and the CSV. `Jest`
- [ ] A period whose reversals exceed sales produces a negative `totalNetSales`, never clamped to zero. `Jest`
- [ ] Re-preparing the same period updates the existing row; concurrent prepares resolve to one row. `Jest`
- [ ] A tenant-B JWT cannot mint a signed URL for tenant A's filing CSV. `Jest`

#### REG-M9

- [ ] The aggregate CSV is byte-identical to the pinned fixture. `Jest`
- [ ] The TX report emits no header row, truncates fields to spec length, sorts by issue date then invoice number. `Jest`
- [ ] A TX row whose net rounds to zero is dropped entirely, not emitted as zero. `Jest`
- [ ] Fields with commas/quotes/CRLF round-trip through CSV escaping. `Jest`
- [ ] A product with `regUomCase = null` passes through RAW with no conversion (back-compat invariant). `Jest`

#### REG-M10

- [ ] Running the sweep twice in one day sends the 30-day warning exactly once. `Jest`
- [ ] Approving or renewing resets the notified buckets so the new expiry warns again. `Jest`
- [ ] A tenant with zero `requiresLicense` sections is skipped entirely. `Jest`
- [ ] A SUPER_ADMIN with null tenantId gets `[]`, never every tenant's licences. `Jest`
- [ ] Operator and buyer bell counts each match their own scoped endpoint. `Playwright`

#### REG-M11

- [ ] `GET /regulated/ledger` under tenant A returns zero rows for tenant B's ledger entries. `Jest`
- [ ] `GET /regulated/filings/:id/csv` with another tenant's filing id returns 404 with no signed URL minted. `Jest`
- [ ] A tenant-B JWT cannot obtain a signed URL for a tenant-A `regulated-filings/` key. `Jest`
- [ ] A null-tenant (SUPER_ADMIN) `prepareFiling` call is refused 400 rather than writing unscoped. `Jest`

#### REG-M12

- [ ] The logged IP is the trust-proxy-aware `req.ip`, not a spoofable header. `Jest`
- [ ] An `AuditLog` write failure never fails the underlying request. `Jest`
- [ ] Creating an override writes both the override row and an `AuditLog` entry; `acceptedByName` survives user deletion. `Jest`
- [ ] MISSING-capability: a TENANT_ADMIN has no endpoint for their own audit trail — adding one must never leak another tenant or expose impersonation entries. `manual`

#### REG-M13

- [ ] `GET /customers?regulated=1` returns only customers with at least one authorization row. `Jest`
- [ ] Omitting the filter or passing any value other than `"1"` returns the unfiltered list. `Jest`
- [ ] `regulatedCount` on each row matches that customer's actual authorization count. `Jest`

#### REG-M14

- [ ] FAILING TODAY (B96/B121/reopen): reopening a COMPLETED stop clears `signatureUrl`, `ageVerified`, `identityVerified`, `identityType`, `identityVerifiedAt` with no appended trail — pin this as the current (wrong) behaviour. `Jest`
- [ ] After a fix: reopening a regulated stop preserves the prior compliance record under a superseded/history field rather than nulling it outright. `Jest`
- [ ] Any retention/legal-hold work must gate this route the same way it gates route delete and pod-artifact overwrite. `manual`

## Nice to have (P1)

| ID      | Capability                                                | Status     | What it does                                                                                                                                         | Evidence                                                                                                                                                                                                                                                                                                                                            |
| ------- | --------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REG-N1  | Buyer self-serve licence submission                       | SHIPPED ✅ | Retailer uploads their own licence from the buyer portal; lands PENDING_REVIEW with a consent checkbox and an operator notification.                 | `GET/POST /buyer/authorizations` (`buyer.controller.ts:960`); `submit-authorization.dto.ts`; web `buyer/portal/[seller]/licenses/page.tsx`; mobile `(customer)/licenses.tsx`                                                                                                                                                                        |
| REG-N2  | Hide locked regulated goods from the buyer catalogue      | SHIPPED ✅ | A buyer without a verified licence never sees those products — listing, counts, deep links, favourites, or dashboard.                                | `computeGate` (verified: defined in `apps/api/src/buyer/regulated-visibility.service.ts:31`, called from `buyer-catalog.service.ts` at :134/:289/:356/:460); also called from `buyer-dashboard.service.ts:34` (understated: a 6th call site the original analysis omitted)                                                                          |
| REG-N3  | Sold-under-responsibility override                        | SHIPPED ✅ | A seller can knowingly release one blocked sale, scoped to an order or a date, as an append-only record.                                             | `POST /customers/:customerId/authorization-overrides`; `AuthorizationOverride`; `authorization-scope.ts isScopeActive`                                                                                                                                                                                                                              |
| REG-N4  | Separate regulated invoice (paired siblings)              | SHIPPED ✅ | Mixed orders split into a standard invoice plus one invoice per SEPARATE_INVOICE section, tied by a shared group id.                                 | `invoices.service.ts groupOrderLinesForInvoicing`/`createSplitInvoices`; `Invoice.invoiceGroupId`                                                                                                                                                                                                                                                   |
| REG-N5  | In-invoice regulated section / per-line tax presentation  | BROKEN 🔴  | SEPARATE_SECTION and LINE_TAX are selectable but do nothing — both fold flat into the standard invoice behind a warn log.                            | `CategoryFormModal.tsx TREATMENTS`; `invoices.service.ts groupOrderLinesForInvoicing` only splits SEPARATE_INVOICE (:981, warn at :993-1001)                                                                                                                                                                                                        |
| REG-N6  | Reporting subcategories within a section                  | PARTIAL 🟡 | Classify inside a section (cigarettes vs cigars) for reporting only; snapshotted at every write.                                                     | `TrackedSubcategory`; nested CRUD in `tracked-categories.controller.ts`. PARTIAL: `prepareFiling` still aggregates by section only, never sets `withSubcategory`                                                                                                                                                                                    |
| REG-N7  | Ad-hoc range report preview and download                  | SHIPPED ✅ | Pick any date range, preview on screen, then download the CSV.                                                                                       | `GET /regulated/reports/{preview,csv}`; `regulated-report.service.ts buildReport`/`buildReportCsv`                                                                                                                                                                                                                                                  |
| REG-N8  | Custom report column layouts                              | SHIPPED ✅ | Add optional columns to a jurisdiction report, save per template, reset to official.                                                                 | `TrackedCategory.reportColumnPrefs`; `report-projection.ts projectReportColumns`; web `CompliancePackPanel.tsx`                                                                                                                                                                                                                                     |
| REG-N9  | Auto-prepare the filing when a period closes              | SHIPPED ✅ | Nightly job prepares the most recently closed period for every active section at its own cadence.                                                    | `regulated-filing-cron.service.ts @Cron("0 4 * * *")`                                                                                                                                                                                                                                                                                               |
| REG-N10 | Compliance hub and per-section dashboard                  | SHIPPED ✅ | One place showing active sections, product counts, this month's net sales/tax, filings roll-up, and a Prepare-filing action.                         | web `compliance/page.tsx` + `compliance/[categoryId]/page.tsx`; mobile `(operator)/compliance/*`                                                                                                                                                                                                                                                    |
| REG-N11 | Age and ID verification at the door                       | BROKEN 🔴  | Enforcement is fully built (refuse safe-drop, require signature/age/ID confirmation) but the toggle that arms it has no writer, so it is always off. | `regulated-delivery.ts` `loadAgeIdCategorySets`/`assertRegulatedDeliverySatisfied`; hooked at stop-complete routes; `TrackedCategory.requiresAgeCheck`/`requiresIdCheck` absent from both create/update DTOs (B149, High/Open); compounded by B171 (no POD gate on `changeStatus` to DELIVERED) and B186 (stop flags not recomputed after dispatch) |
| REG-N12 | Keep regulated volume out of headline analytics           | PARTIAL 🟡 | A dealer whose tobacco turnover dwarfs the rest of the business can exclude it from main dashboards; accounting/P&L are never affected.              | `SystemConfig` key `tobacco.excludeFromMainAnalytics`; `tobaccoExclusionActive()` (`analytics.service.ts:23,152`). PARTIAL: keys on the legacy `Product.isTobacco`, so an Alcohol or CRV section has no exclusion option                                                                                                                            |
| REG-N13 | Report data-quality warnings before you file              | SHIPPED ✅ | Flags missing permits, taxpayer IDs, addresses, fractional quantities, negative net invoices, and unlinked ledger rows before download.              | `ReportWarningCode` set in `tx-report.ts`; surfaced on preview payload and CSV footer                                                                                                                                                                                                                                                               |
| REG-N14 | Per-product regulatory item type and unit of measure      | SHIPPED ✅ | One section can legitimately hold cigarettes, cigars and loose tobacco, each with its own item-type code and UoM, set per product.                   | `Product.regItemType`/`regUomCase`/`regUomUnit`; `assertRegConfigValid` in `products.service.ts`; `buildTxReport` buckets per (invoiceId, itemType, uom)                                                                                                                                                                                            |
| REG-N15 | Attach the licence document itself                        | MISSING ⬜ | `documentKey` exists on the model and every DTO, but no screen — operator or buyer, web or mobile — ever sets it.                                    | `CustomerAuthorization.documentKey` (`schema.prisma:3621`); accepted by all three DTOs and persisted (`authorizations.service.ts:201,267,361`); no `.tsx` writer found repo-wide                                                                                                                                                                    |
| REG-N16 | Regulated-section catalogue filter                        | SHIPPED ✅ | Pull "every regulated product" or "everything not yet classified" to find products missing a section before a filing.                                | `GET /products?section=any\|none\|<sectionId>` (`dto/list-products.dto.ts:38-45`, `products.service.ts:249-251`)                                                                                                                                                                                                                                    |
| REG-N17 | Legacy tobacco period filing (CSV + PDF)                  | SHIPPED ✅ | A working, archived, PDF-bearing monthly filing for the legacy tobacco module — the precedent REG-A1/REG-A4 would generalise.                        | `GET/POST /tobacco/reports*` (`tobacco.controller.ts:53-71`); `tobacco-report.service.ts generateForPeriod`; `TobaccoReport` model; PDF via `tobacco-report-pdf.tsx`                                                                                                                                                                                |
| REG-N18 | Tobacco dealer overview KPI + outbound sales register     | SHIPPED ✅ | Month-scoped KPI overview plus a per-sale register that already prints the retailer's permit number and expiry beside each sale.                     | `GET /tobacco/overview`, `GET /tobacco/sales` (`tobacco.controller.ts:26-44`; `tobacco.service.ts:47,133`)                                                                                                                                                                                                                                          |
| REG-N19 | Customer merge re-points licences and overrides           | PARTIAL 🟡 | Merging duplicate buyer records resolves which authorization "wins" (unique per customer+section) rather than silently dropping one.                 | `customers.service.ts:1542` (effective-strength resolution), `:1654-1657` (re-point on merge); specs `customers.service.spec.ts:852-853`                                                                                                                                                                                                            |
| REG-N20 | Auto-provision the Tobacco section + isTobacco write-sync | PARTIAL 🟡 | Saving a product as tobacco auto-creates the tenant's Tobacco section if none exists yet, keeping the legacy mirror self-healing in one direction.   | `products.service.ts:132,152,617-626`; anchor `tobacco-category.ts:16 TOBACCO_CATEGORY_NAME`                                                                                                                                                                                                                                                        |

### Testing criteria

#### REG-N1

- [ ] `submit()` with `shareConsent` false is rejected 400 and writes nothing. `Jest`
- [ ] Submitting against an already-VERIFIED, unexpired row is refused — a buyer cannot downgrade their own licence. `Jest`
- [ ] `customerId` is always taken from session context, never the request body. `Jest`
- [ ] `listForBuyer` returns every `requiresLicense` section with status NONE where unsubmitted. `Jest`
- [ ] A licence submitted at seller A does not appear under seller B. `Playwright`

#### REG-N2

- [ ] The exclusion is applied at query level — page 2 of a paginated catalogue never contains a locked product. `Jest`
- [ ] `GET /buyer/products/counts` returns zero for a locked category. `Jest`
- [ ] `GET /buyer/products/:id` for a locked product returns 404, not 403. `Jest`
- [ ] The `ids=` filter still composes the regulated exclusion. `Jest`
- [ ] A tenant with zero `requiresLicense` sections takes the fast path with no extra queries. `Jest`

#### REG-N3

- [ ] Fail-closed: an empty, unparseable or bad-date scope string is always inactive. `Jest`
- [ ] An `ORDER:<id>`-scoped override satisfies the guard for that order only. `Jest`
- [ ] An `UNTIL:<iso>` override stops satisfying the guard the instant `now` passes it. `Jest`
- [ ] An override created under tenant A is invisible to tenant B's guard for the same customer email. `Jest`
- [ ] The override row is append-only; `acceptedByName` survives user deletion. `Jest`

#### REG-N4

- [ ] Invariant: sibling invoice totals sum to the order total to the cent. `Jest`
- [ ] An order with no SEPARATE_INVOICE lines produces exactly one invoice with `invoiceGroupId = null`. `Jest`
- [ ] Each sibling writes its own ledger SALE rows; the group's ledger net equals the order's regulated net. `Jest`
- [ ] An order edit after invoicing rebuilds the correct sibling by section snapshot, not position. `Jest`

#### REG-N5

- [ ] Pin the current (wrong) SEPARATE_SECTION behaviour: one invoice, line folded flat, warn log fires. `Jest`
- [ ] After fix: SEPARATE_SECTION groups lines under a named heading in one document with one total. `Jest`
- [ ] After fix: LINE_TAX shows a per-line tax amount that still sums into `Invoice.taxAmount`. `Jest`
- [ ] After fix: the three treatments must not render visually identical invoices. `Playwright`

#### REG-N6

- [ ] `GET /regulated/ledger` without `bySubcategory` is byte-identical to the pre-feature shape. `Jest`
- [ ] Deleting a subcategory sets ledger rows' `trackedSubcategoryId` to null without altering amounts. `Jest`
- [ ] A subcategory name is unique only within its section. `Jest`
- [ ] After fix: `prepareFiling` on a section with two subcategories stores one row per subcategory summing to the section total. `Jest`

#### REG-N7

- [ ] A 367-day range is rejected 400; 366 is accepted. `Jest`
- [ ] `from > to` or a malformed date is rejected 400. `Jest`
- [ ] The JSON preview and the CSV download for the same query agree cell-for-cell. `Jest`
- [ ] The CSV filename is sanitised — no header injection via a crafted section name. `Jest`
- [ ] The range uses a half-open window so `23:59:59.999` on `to` is included. `Jest`

#### REG-N8

- [ ] A custom layout forces `includeHeader = true` and adds a `-custom` filename token; the official TX layout stays headerless. `Jest`
- [ ] A column key not in the template's allowed set is rejected 400. `Jest`
- [ ] Requesting `itemDescription` switches to per-product bucketing while quantities still sum to the same total. `Jest`
- [ ] "Reset to template" clears the stored layout and the next preview carries no `columns` param. `Playwright`

#### REG-N9

- [ ] On 1 January, MONTHLY resolves to December of the prior year; quarterly/annual roll over correctly. `Jest`
- [ ] A section whose filing already exists is skipped without calling `prepareFiling`. `Jest`
- [ ] One tenant throwing does not abort the sweep for later tenants. `Jest`
- [ ] The cron writes `generatedById = null` so a cron-prepared filing is distinguishable. `Jest`

#### REG-N10

- [ ] A tenant with zero regulated sections sees a working empty state, not a spinner. `Playwright`
- [ ] A tenant without the addon still sees the hub with categories/product-count; gated KPIs render em-dash with no gated request fired. `Playwright`
- [ ] "Prepare filing" shows a success toast and the new row appears with a working CSV link. `Playwright`
- [ ] A CUSTOMER/DRIVER session never sees the Regulated Items nav group. `Playwright`

#### REG-N11

- [ ] An age-flagged category throws SAFE_DROP_FORBIDDEN when safe-drop is enabled; the stop stays PENDING. `Jest`
- [ ] `identityVerified: true` with a blank `identityType` throws ID_TYPE_REQUIRED; timestamp is server-stamped. `Jest`
- [ ] The requirement derives from the union of linked orders and payload item ids. `Jest`
- [ ] FAILING TODAY (B149): a TENANT_ADMIN has no way to set `requiresAgeCheck`/`requiresIdCheck` through any route or UI. `manual`
- [ ] FAILING TODAY (B186): linking a regulated order to an already-dispatched stop must surface the requirement server-side. `Jest`
- [ ] FAILING TODAY (B171): `changeStatus` to DELIVERED bypasses the gate entirely today. `Jest`

#### REG-N12

- [ ] With the addon active but config false, tobacco rows are included — both conditions are required. `Jest`
- [ ] Invariant: bookkeeping P&L is identical with the exclusion on and off. `Jest`
- [ ] The excluded figure ties back to the invoice line total to the cent. `Jest`
- [ ] Gap: an "Alcohol" section currently has no exclusion path. `Jest`

#### REG-N13

- [ ] A category-level warning is emitted exactly once per report, even across 500 rows. `Jest`
- [ ] A null-`invoiceId` ledger row produces UNLINKED_LEDGER_ROWS but is still counted in aggregate totals. `Jest`
- [ ] An unresolvable `invoiceItemId` produces UNMATCHED_LEDGER_LINE rather than being dropped silently. `Jest`
- [ ] Warnings are visible in the preview panel before the CSV download button. `Playwright`

#### REG-N14

- [ ] Moving a product to a section whose template cannot express its current codes is rejected 400, never auto-cleared. `Jest`
- [ ] Clearing the section auto-clears all three regulatory codes. `Jest`
- [ ] An unrelated PATCH that echoes the existing trio does not re-query the section. `Jest`
- [ ] A section with a cigarette and a cigar product emits two report rows with correct item-type codes. `Jest`

#### REG-N15

- [ ] After build: an operator can attach a PDF/JPEG, stored under a tenant-scoped prefix, with a working signed-URL link on reopen. `Playwright`
- [ ] After build: a tenant-B JWT cannot mint a signed URL for a tenant-A licence document. `Jest`
- [ ] After build: a buyer can attach the document on submission and it arrives on the PENDING_REVIEW row. `Playwright`
- [ ] After build: renewing without a new `documentKey` preserves the existing one. `Jest`

#### REG-N16

- [ ] `?section=<id>` returns only products tagged to that section. `Jest`
- [ ] `?section=none` returns only untagged products. `Jest`
- [ ] `?section=any` returns every regulated product regardless of section. `Jest`

#### REG-N17

- [ ] Generating a report twice for the same period does not duplicate `TobaccoReport` rows. `Jest`
- [ ] The CSV and PDF totals agree with each other and with the persisted report. `Jest`
- [ ] A tenant-B JWT cannot download a tenant-A tobacco report. `Jest`

#### REG-N18

- [ ] `/tobacco/overview` is month-scoped and matches the sum of `/tobacco/sales` for that month. `Jest`
- [ ] Each sales row carries the buyer's `tobaccoLicenseNo` and `tobaccoLicenseExpiry` as of the sale, not the live value. `Jest`

#### REG-N19

- [ ] Merging two customers each with a VERIFIED authorization for the same section resolves to a single winning row by effective strength, not an arbitrary pick. `Jest`
- [ ] The losing authorization's history is retained, not deleted, if the merge changes the winner. `Jest`

#### REG-N20

- [ ] Saving a product as tobacco on a tenant with no Tobacco section creates one automatically. `Jest`
- [ ] Renaming the auto-created section away from "Tobacco" detaches the `isTobacco` mirror sync (documented current behaviour). `Jest`

## Advanced / future (P2)

| ID      | Capability                                                        | Status     | What it does                                                                                                                        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | ----------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REG-A1  | Filing lifecycle: due dates, submission, acceptance, amendment    | MISSING ⬜ | Track a filing beyond "we made a CSV" — due date, submission, agency confirmation, acceptance, amendment.                           | `RegulatedFilingStatus` has only GENERATED/FAILED (`schema.prisma:3523-3526`); no `dueDate`/`submittedAt`/`confirmationNumber`/`supersededById` field exists                                                                                                                                                                                                                                                                                                                                                |
| REG-A2  | Direct electronic submission to the agency                        | MISSING ⬜ | File to the state portal from inside the product instead of downloading a CSV and re-uploading it.                                  | No submission client, credential store, or agency endpoint exists anywhere in `apps/api/src/regulated/`                                                                                                                                                                                                                                                                                                                                                                                                     |
| REG-A3  | PACT-Act-style federal / interstate shipment reporting            | MISSING ⬜ | Monthly per-state shipment report with recipient detail for interstate cigarette/ENDS distributors.                                 | `template-registry.ts` has 5 templates, none federal/multi-state; ledger rows carry no ship-to state                                                                                                                                                                                                                                                                                                                                                                                                        |
| REG-A4  | Filing PDF                                                        | BROKEN 🔴  | A human-readable PDF of the prepared filing to sign or archive.                                                                     | `GET /regulated/filings/:id/pdf` is registered but `prepareFiling` always writes `pdfKey: null` — the route 404s on every call. Contrast: the legacy tobacco module (REG-N17) already does this                                                                                                                                                                                                                                                                                                             |
| REG-A5  | Inbound (purchase-side) regulated tracking with supplier licences | PARTIAL 🟡 | What regulated stock came in, from which licensed supplier, under which permit.                                                     | Tobacco-only: `GET /tobacco/purchases` joins `Supplier.tobaccoLicenseNo`; no generic equivalent, no per-section supplier permit field                                                                                                                                                                                                                                                                                                                                                                       |
| REG-A6  | Regulated stock reconciliation per section                        | PARTIAL 🟡 | Opening/closing stock statement per section — held, bought, sold, holds now.                                                        | Tobacco-only, anchored by section NAME `"Tobacco"` (`tobacco-category.ts`); an Alcohol section has no stock statement                                                                                                                                                                                                                                                                                                                                                                                       |
| REG-A7  | Data retention, archival and legal hold                           | MISSING ⬜ | Statutory retention with a hold that suspends deletion during an audit or dispute.                                                  | No retention/purge/legal-hold concept found anywhere; compounded by B96 (route delete destroys completed runs' POD/signatures), B121 (pod-artifact overwrite), and REG-M14 (reopen-stop wipe)                                                                                                                                                                                                                                                                                                               |
| REG-A8  | Tenant-facing compliance evidence pack                            | PARTIAL 🟡 | Produce "who verified this retailer's licence, and every regulated sale to them in Q2" without going through the platform operator. | `GET /platform-admin/audit-logs` is SUPER_ADMIN-only (the audit-log gap is real). Partially softened: `GET /route-runs/:id/stops/:stopId/pod` already returns the per-stop signature + age/ID record to OPERATOR/DRIVER, `GET /customers?regulated=1` (REG-M13) gives the licence-holder roster, and `GET /regulated/reports/{preview,csv}` (REG-N7, already SHIPPED) gives an arbitrary-range regulated sales export — so a partial evidence pack already exists; only the audit-log half is fully missing |
| REG-A9  | Per-jurisdiction rules driven by where the goods go               | MISSING ⬜ | Tax rule, licence requirement and report follow the delivery destination, not one tenant-global setting.                            | `TrackedCategory.appliesScope` exists but `deliveryCity` is never passed at any of the 6 guard call sites, so a scoped section fails closed everywhere                                                                                                                                                                                                                                                                                                                                                      |
| REG-A10 | True volume basis for per-volume levies                           | MISSING ⬜ | Alcohol excise / CRV levies on litres/ounces, not piece count.                                                                      | No `Product.volumePerUnit`; `computeCategoryTax`'s `PER_VOLUME` branch is documented approximate (`orders.service.ts:189,1773`)                                                                                                                                                                                                                                                                                                                                                                             |
| REG-A11 | Verify a permit number against the issuing registry               | MISSING ⬜ | Check a retailer's permit against the state's public registry at capture time, and periodically re-check.                           | `licenseNumber` is free text with no format/checksum validation at entry; the only structural check fires at report time, after the sale                                                                                                                                                                                                                                                                                                                                                                    |
| REG-A12 | Cross-seller licence reuse                                        | MISSING ⬜ | A retailer already proven to one wholesaler should not have to re-submit to the next.                                               | `CustomerAuthorization` is unique per (seller's customerId, section) — deliberately per-seller today                                                                                                                                                                                                                                                                                                                                                                                                        |

### Testing criteria

#### REG-A1

- [ ] After build: a filing shows a due date derived from cadence + jurisdiction lag; an overdue unfiled period raises a notification. `manual`
- [ ] After build: marking SUBMITTED requires a confirmation reference, is audit-logged, and freezes the CSV — re-preparing creates an AMENDED filing. `manual`
- [ ] After build invariant: an amended filing stores prior totals, new totals, and the delta. `manual`
- [ ] After build: re-preparing a SUBMITTED period without choosing "amend" is refused 409. `manual`

#### REG-A2

- [ ] After build: credentials are stored encrypted per tenant and never returned by any GET. `manual`
- [ ] After build: submission is idempotent per (tenant, section, period) — a retry never double-files. `manual`
- [ ] After build: a rejected submission stores the agency's error and remains re-submittable. `manual`
- [ ] After build: submission is gated by the compliance-pack addon. `manual`

#### REG-A3

- [ ] After build: shipments group by destination state, not billing address. `manual`
- [ ] After build: a shipment missing required recipient fields is flagged as a blocking warning before download. `manual`
- [ ] After build invariant: the union of per-state reports equals the period's ledger net exactly. `manual`
- [ ] After build: an intra-state-only tenant produces zero interstate reports. `manual`

#### REG-A4

- [ ] Today: `GET /regulated/filings/:id/pdf` returns 404 for every filing in every tenant — pin this. `Jest`
- [ ] After build: the PDF's totals match the CSV's and the persisted Decimal columns to the cent. `manual`
- [ ] After build: the PDF is stored under the same tenant-scoped prefix with the same isolation test. `manual`
- [ ] After build: re-preparing a period regenerates both artifacts together. `manual`

#### REG-A5

- [ ] After build invariant: opening stock + purchases - sales - returns-out = closing stock for a section/period. `manual`
- [ ] After build: a purchase from a supplier with no permit on file raises a report warning. `manual`
- [ ] After build: a supplier permit is per-section, not one free-text field. `manual`
- [ ] After build: a non-Tobacco section has a purchase report too. `manual`

#### REG-A6

- [ ] After build invariant: section closing stock equals current on-hand minus movements after period end. `manual`
- [ ] After build: ending value uses period-end cost or discloses the current-cost approximation. `manual`
- [ ] After build: renaming the Tobacco section must not detach its reports. `manual`
- [ ] After build: an Alcohol section produces the same statement shape, with tobacco numbers proven byte-identical before/after. `manual`

#### REG-A7

- [ ] After build: a configurable retention period per record class, floored at the statutory minimum. `manual`
- [ ] After build: a legal hold blocks every deletion path touching held rows. `manual`
- [ ] FAILING TODAY (B96): deleting a route destroys completed runs' POD/signatures/identity records. `Jest`
- [ ] FAILING TODAY (B121): a completed stop's signature can be overwritten with existence checks only. `Jest`

#### REG-A8

- [ ] After build: a TENANT_ADMIN can filter/export their own audit trail; another tenant's rows are never returned. `manual`
- [ ] After build: impersonation entries are shown as impersonation or deliberately excluded, documented either way. `manual`
- [ ] After build: a per-customer evidence pack bundles authorization history, overrides, and ledger lines in one download. `manual`
- [ ] Today: confirm the existing partial surfaces (pod record, customer roster, ad-hoc report) remain read-only and do not mutate records. `Jest`

#### REG-A9

- [ ] After build: two customers in different cities get the correct per-jurisdiction rate, computed once through `computeCategoryTax`. `manual`
- [ ] After build: the filing splits by jurisdiction and sums exactly to the section's period ledger net. `manual`
- [ ] FAILING TODAY: `appliesScope {cities:['Oakland']}` gates deliveries everywhere because `deliveryCity` is never passed. `Jest`
- [ ] After build: an unknown destination still fails closed, surfaced as a warning. `manual`

#### REG-A10

- [ ] After build: a 750ml bottle at $0.20/litre yields $0.15/bottle, not $0.20 — assert against today's wrong result. `manual`
- [ ] After build invariant: the levy is computed from volume × rate, rounded once at the line. `manual`
- [ ] After build: a PER_VOLUME product missing `volumePerUnit` blocks save with a validation error. `manual`
- [ ] After build: a migration leaves already-filed periods untouched. `manual`

#### REG-A11

- [ ] After build: a permit number failing the jurisdiction's format check is refused at entry, not flagged months later. `manual`
- [ ] After build: a "revoked" registry result flips the authorization out of VERIFIED and notifies operators; a timeout leaves it untouched. `manual`
- [ ] After build: the periodic re-check is idempotent per (authorization, day). `manual`
- [ ] After build: registry results are stored with a check timestamp. `manual`

#### REG-A12

- [ ] After build: a verified licence at seller A is offered to seller B as pre-filled, requiring B's own approval. `manual`
- [ ] After build: propagation requires explicit per-seller buyer consent and is revocable without altering past approvals. `manual`
- [ ] After build: seller B cannot see seller A's verifier identity or rejection reasons. `manual`
- [ ] After build: a licence rejected by seller A is still submittable to seller B. `manual`

## How this varies by tenant

| Variation                                                                                                         | Mechanism                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whether the tenant gets the compliance pack at all (ledger, filings, jurisdiction reports, Tobacco section)       | Addon `tobacco_dealer` → SKU `REGULATED_ITEMS` (`plan-catalog.constants.ts:220,240`); `AddonGuard` on `tobacco.controller.ts` and per-route on `regulated.controller.ts`            |
| Classifying products and capturing licences (not the ledger/filing/report surfaces)                               | Available to every tenant regardless of addon — `tracked-categories.controller.ts` and `authorizations.controller.ts` carry only `JwtAuthGuard + RolesGuard`, deliberately un-gated |
| Which regulated classes exist, and each one's tax rule / unit basis / tax-inclusive pricing / invoicing treatment | Per-tenant data on `TrackedCategory`, edited via `CategoryFormModal.tsx`                                                                                                            |
| Whether an unlicensed sale is blocked or merely allowed through                                                   | `TrackedCategory.requiresLicense` — seeded `false` for the Tobacco backfill; enabling blocking is an explicit per-tenant toggle                                                     |
| Which jurisdiction's layout the filing is produced in, and how often                                              | `TrackedCategory.reportTemplate` and `reportCadence`                                                                                                                                |
| A saved custom column layout for a report                                                                         | `TrackedCategory.reportColumnPrefs` (Json, keyed by template)                                                                                                                       |
| The tenant's own wholesaler permit number on the return                                                           | `TrackedCategory.wholesalerLicenseNo` — TX-only, form field shown only for `TX_COMPTROLLER`                                                                                         |
| Per-product legal item type and unit of measure                                                                   | `Product.regItemType`/`regUomCase`/`regUomUnit`, validated against the section's template                                                                                           |
| Whether tobacco turnover is excluded from main analytics                                                          | `SystemConfig` key `tobacco.excludeFromMainAnalytics`, effective only when the addon is also active                                                                                 |
| Whether a delivery demands an age check and/or ID check at the door                                               | **NOT CONFIGURABLE** — `requiresAgeCheck`/`requiresIdCheck` exist in the schema but have no DTO field, no service write, no UI toggle; every real tenant is hardcoded to false      |
| Restricting a regulated section to particular cities / jurisdictions                                              | **NOT CONFIGURABLE in practice** — `appliesScope` is honoured by the guard but no UI writes it and `deliveryCity` is never supplied, so scoping fails closed everywhere             |
| Which section counts as "the tobacco one" for legacy tobacco reports, inventory and analytics exclusion           | **NOT CONFIGURABLE** — hardcoded by name match (`TOBACCO_CATEGORY_NAME = "Tobacco"`), case-insensitive; a rename silently detaches the mirror                                       |
| True volume for a per-volume levy (alcohol, CRV)                                                                  | **NOT CONFIGURABLE** — no `Product.volumePerUnit`; levied on piece count, documented as approximate                                                                                 |
| How long regulated records are kept, and whether an audit can freeze them                                         | **NOT CONFIGURABLE** — no retention setting, no purge job, no legal-hold concept exists                                                                                             |

## Gaps for a great UX

| Severity | Gap                                                                                                                                                                                                  | Impact                                                                                                                                                                                                                                                      | Suggested direction                                                                                                                                                                                                                                                                  |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CRITICAL | The age/ID verification gate can never be armed by any tenant — `requiresAgeCheck`/`requiresIdCheck` have no writer anywhere.                                                                        | A distributor believes safe-drop is impossible on age-restricted goods and that the driver confirmed the recipient's age. In reality every regulated stop completes like an ordinary one, with no ID record — a documented promise the product cannot keep. | Add the two fields to both tracked-category DTOs and expose them as toggles in the Regulated settings tab. In the same change, fix B186 (server-derived stop requirement) and B171 (gate `changeStatus` to DELIVERED for regulated orders) — the imports already exist and are dead. |
| CRITICAL | `deleteOrder` destroys regulated invoices without reversing their ledger rows (`RegulatedLedgerService` isn't even imported into `OrdersService`).                                                   | Regulated sales and excise are permanently overstated for that period; the ledger has no FK to the invoice, so the overstatement is unrecoverable by reconciliation.                                                                                        | Import `RegulatedLedgerService` into `OrdersService` and call `reverseInvoiceEntries` inside `deleteOrder`'s existing transaction, mirroring `deleteInvoice`. Pin with a spec asserting ledger net is 0.00 after delete.                                                             |
| CRITICAL | An invoice price adjustment never recomputes the line's category tax (`applyPriceAdjustment` writes price/subtotal only).                                                                            | A `PERCENT_OF_SALE` regulated line keeps stale excise, persisted on the invoice, the mirrored order, and the filing — an under-collection the tenant discovers at audit.                                                                                    | In `applyToInvoice`'s item loop, call `computeCategoryTax` from the new subtotal and persist it, mirroring `recomputeLineCategoryTaxes`. Add a spec asserting `taxAmount` and the order mirror both move.                                                                            |
| HIGH     | A tenant cannot see its own compliance audit trail — the only reader of `AuditLog` is SUPER_ADMIN-only.                                                                                              | "Who approved this retailer's licence?" is answerable only by the platform operator, undercutting the reason to buy compliance software over a folder.                                                                                                      | Add a tenant-scoped audit read endpoint (`@Roles(TENANT_ADMIN)`, `forTenant`) plus a Settings → Audit page and a per-customer licence-history panel. Decide and document how impersonation entries are shown.                                                                        |
| HIGH     | Two selectable invoicing treatments (SEPARATE_SECTION, LINE_TAX) do nothing — both fold flat behind a warn log.                                                                                      | A tenant configures a treatment, sees no change, and gets no error explaining why. Three settings produce two behaviours.                                                                                                                                   | Either build the presentation (heading + per-line tax rendering) or hide the two unimplemented options in `CategoryFormModal` and label them "coming soon."                                                                                                                          |
| HIGH     | Compliance evidence is destructible and mutable across three paths: route delete (B96), pod-artifact overwrite (B121), and reopen-stop (REG-M14) — with no retention or legal-hold concept anywhere. | Records that prove a regulated delivery was lawful can be destroyed by ordinary cleanup, overwritten by any in-tenant user, or silently wiped by a driver reopening a stop.                                                                                 | Sequence: refuse cascade-delete of completed runs; make a completed stop's signature immutable or append-with-trail; extend the same protection to the reopen route; add a retention policy with a statutory floor and a legal-hold flag.                                            |
| HIGH     | The generic regulated system and the legacy tobacco system have not converged — several tobacco readers still key on `Product.isTobacco`, anchored by section NAME match.                            | A tenant whose regulated section is Alcohol/Vape/CRV gets no stock statement, no purchase view, no analytics carve-out; renaming the Tobacco section silently detaches the mirror.                                                                          | Add a stable marker column to `TrackedCategory` (e.g. `isLegacyTobaccoAnchor`) set once by migration so identity survives a rename; generalise the tobacco readers from `isTobacco` to `trackedCategoryId` behind a report byte-equivalence gate.                                    |
| MEDIUM   | A filing has no life after generation — no due date, submitted state, confirmation number, or amendment; the filing PDF route always 404s.                                                           | The product prepares the return and forgets it: nothing tells the tenant it's due or overdue, nothing records it was actually filed, and the dead PDF route is a broken promise on the API surface.                                                         | Add `dueDate`/`submittedAt`/`confirmationNumber`/`supersededById` plus SUBMITTED/AMENDED statuses; raise a due notification reusing the expiry-cron shape. Implement the filing PDF via the pattern already proven in `tobacco-report-pdf.tsx`, or delete the route.                 |
| MEDIUM   | Geographic scoping (`appliesScope`) is accepted and honoured but inert and fails closed — no UI writes it, and `deliveryCity` is never supplied to the guard.                                        | A tenant that sets scoping gets the opposite of what it asked for: the section gates every sale everywhere.                                                                                                                                                 | Thread `deliveryCity` from the order's delivery address into every guard call site, then add a scope editor to the section form.                                                                                                                                                     |
| MEDIUM   | The licence document itself is never stored — `documentKey` exists and persists, but no screen ever sets it.                                                                                         | "Show me the licence" still means a filing cabinet or a WhatsApp thread — the exact workflow the product set out to replace.                                                                                                                                | Wire the existing uploads pipeline into the licence capture/renew form on both operator and buyer sides, under the tenant-scoped prefix the isolation test already covers.                                                                                                           |
| LOW      | `Order.hasRegulated` is written at six sites but read nowhere in web or mobile.                                                                                                                      | No "show me regulated orders" filter exists despite the flag being maintained correctly on every write path.                                                                                                                                                | Expose it as a filter on `ListOrdersDto` and a chip in the orders list — a third instance of the same pattern already shipped for products (`?section=`) and customers (`?regulated=1`), so cheaper than a novel build.                                                              |
| LOW      | Filing-side subcategory aggregation is unfinished — `prepareFiling` still aggregates by section only despite the ledger snapshotting subcategory everywhere.                                         | The persisted (archived) filing cannot show the same cigarettes-vs-cigars split the live ledger view can; the two will visibly disagree in shape.                                                                                                           | Pass the subcategory dimension through `prepareFiling` and set `withSubcategory`, with a spec asserting per-subcategory totals sum exactly to the existing section totals.                                                                                                           |

## Cross-domain handoffs

- **Catalogue / Products → Regulated**: `Product.trackedCategoryId`/`trackedSubcategoryId` and the
  per-product `regItemType`/`regUomCase`/`regUomUnit` trio are the classification source.
  `assertRegConfigValid` REJECTS (never auto-clears) a section move whose codes the new template
  cannot express, because the ledger is append-only and the report resolves item type live from the
  product row.
- **Orders → Regulated**: the licence guard is called at six sites and returns 409
  `REGULATED_AUTH_REQUIRED` with `blockedCategories`, which each client turns into a
  capture/override/remove modal. Orders own the sale-time snapshot and `hasRegulated`.
  `Order.orderDate` backdating moves which filing period a sale lands in.
- **Invoices → Regulated**: invoices are where the ledger is actually written and reversed. Invoicing
  re-runs the licence guard inside the transaction as a backstop. `categoryTaxAmount` folds into
  `Invoice.taxAmount` at eight sites. SEPARATE_INVOICE sections split into paired siblings sharing
  `invoiceGroupId`.
- **Returns and Credit Notes → Regulated**: `reverseReturnEntries`/`unreverseReturnEntries` and
  `reverseCreditNoteEntries`/`unreverseCreditNoteEntries` key on the order line
  (`orderItemId ?? invoiceItemId`) so a delivered-basis reconcile cannot produce a negative filing.
- **Dispatch / Routes / POD → Regulated**: `RouteRunStop.{ageCheckRequired, identityCheckRequired}`
  are a driver-UI hint at run creation; the authoritative re-derivation happens at stop completion.
  `{ageVerified, identityVerified, identityType, identityVerifiedAt}` are the delivery-side
  compliance record — destroyed by route delete (B96), overwritable via pod-artifact (B121), and now
  wiped by reopen-stop (REG-M14). `GET /route-runs/:id/stops/:stopId/pod` is the read side of this
  record. The whole handoff is currently dormant because the category flags cannot be set (REG-N11).
- **Buyer Portal → Regulated**: `computeGate` (in `regulated-visibility.service.ts`, not
  `buyer-catalog.service.ts`) hides licence-required sections from listing, counts, favourites,
  `ids=` filter, product deep links, and the buyer dashboard — six call sites total, all sharing one
  predicate that must stay identical to the sale guard's.
- **Billing / Entitlements → Regulated**: the `tobacco_dealer` addon key bridges to the
  `REGULATED_ITEMS` SKU. Categorisation and licences are deliberately outside the gate; the ledger,
  filings and reports are inside it.
- **Analytics and Bookkeeping → Regulated**: analytics can exclude tobacco volume when both the
  addon and the tenant setting are on; bookkeeping and P&L are deliberately never carved out.
- **Uploads / Storage → Regulated**: filing CSVs live at
  `regulated-filings/<tenantId>/<categoryId>/<periodKey>.csv` and tobacco reports at
  `tobacco-reports/<tenantId>/<yyyy-MM>.{csv,pdf}`; both prefixes are tenant-scoped on the JWT path.
  A licence document upload, when built, must join the same scheme.
- **Notifications and Email → Regulated**: the expiry cron and buyer submission flow push to
  operators and the buyer, with idempotency carried on the authorization row. A filing-due
  notification, when built, should reuse this shape.
- **Customers → Regulated**: customer merge re-points licences and overrides to a single winning
  authorization by effective strength rather than silently dropping one, since the model is unique
  per (customer, section).
- **Platform Admin → Regulated**: the addon is toggled per tenant on `admin/tenants/[id]`, and
  `GET /platform-admin/audit-logs` is currently the only reader of the `AuditLog` every regulated
  mutation writes.

## What we could not verify

- Nothing in this domain was executed — no Jest run, no Playwright run, no live API call. All
  status calls are static reads of master at `6c8f1401` plus the code map, so a runtime-only
  failure (a guard not registered, a cron not scheduled in the deployed build, a migration not
  applied in production) would not show up here.
- Production data was not checked, so whether any live tenant actually has the `tobacco_dealer`
  addon, a licence-required section, or non-zero ledger rows is unconfirmed — the capability is
  proven, the adoption is not.
- MISSING calls in Advanced / future rest on absence-of-evidence (repo-wide greps for retention,
  `volumePerUnit`, interstate templates, a tenant-facing audit endpoint). A capability living under
  an unexpected name could in principle have been missed, though the highest-weight searches
  (`requiresAgeCheck`, `documentKey`, `hasRegulated`) completed cleanly with full file:line anchors.
- The three CRITICAL gaps (B149 age/ID writer, B65 `deleteOrder` ledger, B57 price-adjustment
  excise) are drawn from the existing adversarially-verified bug register and independently
  re-confirmed by reading the DTOs, `CategoryFormModal`'s field list, `regulated-delivery.ts` and
  `computeCategoryTax` directly.
- Mobile operator regulated forms were not read line by line; since the DTOs are the server
  contract and neither declares the age/ID flags, a mobile-only writer for REG-N11 is not possible
  regardless.
- Two evidence-citation errors were caught by adversarial verification and corrected above: REG-N2's
  `computeGate` lives in `regulated-visibility.service.ts`, not `buyer-catalog.service.ts`; REG-M11's
  isolation spec is at `apps/api/src/uploads/uploads-tenant-scope.security.spec.ts`. Both underlying
  capabilities remain SHIPPED — only the file anchors were wrong.
- Test criteria naming an existing spec file cite one present in the tree; criteria labelled "after
  build" or "FAILING TODAY" describe tests that do not yet exist.
