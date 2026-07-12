# Phase 4 — Regulated Items: Completion Plan

> Scoped 2026-07-06 via a 4-agent gap-analysis workflow. **Phase 4 is XL, high
> money/compliance risk, and genuinely multi-session** — do NOT attempt in one
> sitting. Source of truth: `project/specs/regulated-items-spec.md`; design
> `project/unified/{compliance,tracked-categories,buyer-licenses,product-detail,invoice-detail,action-modals}.html`;
> endpoint map `project/specs/backend-wiring-index.md`. Follow the **db-migration**
> and **rebuild** skills + `CLAUDE_SESSION_PREAMBLE.md` for every migration/deploy.

## STATUS — updated 2026-07-12 (READ THIS FIRST; the per-block text below is the original plan and is now STALE)

**The entire W1→W7b ladder SHIPPED and is LIVE in prod.** All migrations are applied
(`20260706120000_regulated_items_foundation`, `20260707120000_add_regulated_filing`,
`20260709000000_add_authorization_expiry_notify`, `20260710000000_add_credit_note_item`,
`20260710010000_regulated_pod_age_id`). Ignore the "BUILT on a branch / awaiting user
approval" wording in the W-block list below — it predates the deploys. Authoritative
signature-level status lives in `.claude/code-map/api.md` (regulated section) + `web.md`/`mobile.md`.

### DONE (wired + deployed)
- **W1** schema foundation + tobacco backfill (seed row #1, `taxType=NONE`, `requiresLicense=false`).
- **W2** tracked-categories CRUD (`apps/api/src/tracked-categories/`) + web **Regulated Items hub**
  (`apps/web/app/(dashboard)/compliance/page.tsx`), `CategoryFormModal` + `AssignProductsModal`.
- **W4** invoice split — `SEPARATE_INVOICE` categories emit paired sibling invoices (`invoiceGroupId`, `-R1/-R2`).
- **W5a/b/c** regulated ledger writer + generic filings (`prepareFiling`/CSV, web filings table WIRED) +
  credit-note/return ledger reversal. (`apps/api/src/regulated/`.)
- **W6a/b** authorization lifecycle + point-of-sale license guard (409 `REGULATED_AUTH_REQUIRED`, 3 exits) +
  buyer self-serve `/buyer/authorizations` + invoice-time backstop. (`apps/api/src/authorizations/`.)
- **W7** license-expiry cron (30/7/1-day), buyer catalog visibility gate, **W7b** POD age/ID delivery gate
  (`common/regulated-delivery.ts`, 400 `REGULATED_POD_REQUIRED`) + driver/buyer surfaces.
- **Mobile parity** (buyer licenses, POS guard modal, catalog gate + expiry bell, driver POD capture) shipped in #225.

### LEFT for the next session (nothing is in flight)
1. **In-invoice regulated SECTION heading** (`SEPARATE_SECTION` treatment) — the requested "group regulated
   vs unregulated under a heading on the same invoice." **Display-only, no migration, no money math.** Today
   `invoices.service.groupOrderLinesForInvoicing` (:465-515) only splits `SEPARATE_INVOICE`; `SEPARATE_SECTION`/
   `LINE_TAX` lines fold flat with a warn (:497-501). Path: join `TrackedCategory.name`+`invoiceTreatment` onto
   invoice-line payloads (`findOne` items include :1325, `invoice-pdf.service` include :47, PDF template item
   shape, web `lib/api/invoices.ts` line type, mobile `lib/api/invoices.ts` line type — all product-only today);
   add one pure `groupInvoiceItems(items)` helper (web+mobile mirror); render an unheaded standard group then one
   heading per non-null-category group on web detail (:1618-1734), PDF template (:472-508), mobile operator/customer
   invoice detail. Any regulated line co-resident on a mixed invoice is by definition `SEPARATE_SECTION`/`LINE_TAX`
   (SEPARATE_INVOICE is already hived off), so grouping on `trackedCategoryId != null` is correct.
2. **W3 category TAX is inert** — `taxType`/`rate` are stored + editable, but `RegulatedSalesLedger.categoryTax`
   is snapshot 0 and `createSplitInvoices` (:562-568) hard-blocks any non-zero category rate. Actually computing
   per-`taxType` tax (EXCISE_PER_UNIT/PERCENT_OF_SALE/PER_VOLUME/DEPOSIT_PER_CONTAINER, boxed-line interaction)
   is the real money-path block — adversarial review + `06-critical-paths.spec.ts` gate REQUIRED.
3. **Product-form category picker** — assigning a product to a tracked category is bulk-only (`AssignProductsModal`);
   no `trackedCategoryId` selector on product create/edit (web or mobile). Scope selector (`appliesScope`) also unbuilt.
4. **Ledger completeness** — writes only on the split-invoice path; `reconcileOrderDraftInvoice`/manual-create/
   partial/draft-update sync, `orderItemId` provenance, `unitBasisQty` conversion, and a **filing cron** (filings
   are manual "prepare" only) are deferred.
5. **Authorization edges** — license-DOCUMENT upload (`documentKey` unwired, buyer+operator); §8 create-path override
   post-create binding; geo `deliveryCity` scope threading; cross-seller license propagation.
6. **Nav gating** — the Regulated Items hub is nav-gated behind the tobacco addon (`layout.tsx:785`); a non-tobacco
   regulated tenant can't see it in the sidebar. Consider gating on "≥1 active TrackedCategory" instead.
7. **W1 follow-ups still open** — customer merge/delete does NOT re-point `CustomerAuthorization`/`AuthorizationOverride`
   (`customers.service.ts` merge ~1198-1217); **no operator tracked-category MANAGEMENT or customer-authorization
   approve/reject/renew on MOBILE** (web-only).

## The one idea

Everything routes to a generic **`TrackedCategory`** that replaces the hardcoded
`Product.isTobacco` boolean. **Tobacco becomes seed row #1** of a generic system.
The money-split primitive (`SplitInvoiceModal` + `createPartialFromOrder`,
proportional tax) and the filing/report primitive (tobacco CDTFA CSV/PDF, monthly
cron) **already exist for tobacco** — Phase 4 GENERALIZES them, it does not invent
them.

## (A) Already done — do NOT rebuild
- `Product.isTobacco`, `Customer.tobaccoLicenseNo/Expiry`, `Supplier.tobaccoLicenseNo` — **migrate, don't delete** (W1).
- Tobacco service/controller/report (CDTFA CSV/PDF, monthly cron, addon gating), tobacco web page — keep live; the report service is the reference impl for the generic filing service.
- `SplitInvoiceModal.tsx` + `createPartialFromOrder` (manual qty split, proportional tax) — **reuse as the money-math base for category split; do not rewrite.**
- POD: `RouteRunStop.podPhotoUrls[]`/`signatureUrl`, mobile signature+photo capture, `podStore` — fields + capture exist; only the regulated linkage/flags are missing (W7).

## (C) Backend wiring blocks — ordered by value × safety
Each W-block = one PR (at least). Money/compliance blocks need adversarial review + E2E money-invariant gates before release.

- **W1 — Schema foundation + tobacco migration** `[migration][data-integrity]` — **BUILT (branch `feat/regulated-items-w1-schema`); migration `20260706120000_regulated_items_foundation` awaiting user approval to apply to prod.** `npm run verify` 18/18 green.
  New models `TrackedCategory`, `CustomerAuthorization`, `AuthorizationOverride`,
  `RegulatedSalesLedger`; columns `Product.trackedCategoryId` (FK, one-max),
  `OrderItem.trackedCategoryId+categoryTaxAmount`, `InvoiceItem.trackedCategoryId+categoryTaxAmount`,
  `Invoice.invoiceGroupId`, `Order.hasRegulated`, `RouteRunStop.ageCheckRequired/identityCheckRequired`.
  **Additive + reversible**: create a Tobacco row per tenant, backfill
  `Product.trackedCategoryId`, and **keep `isTobacco` as a shadow column for one
  release**. All models tenant-scoped. Prod via `railway run npx prisma migrate deploy` only.
- **W2 — Tracked-categories CRUD API** `[low risk]` — `GET/POST/PATCH /tracked-categories`, `/:id/toggle`, `/:id/products/assign`. **Unblocks all of B2.** Ship right after W1.
- **W3 — Category tax calculator + order snapshot** `[money-path][adversarial review REQUIRED]` — pure fn per `taxType` (EXCISE_PER_UNIT, PERCENT_OF_SALE, PER_VOLUME, DEPOSIT_PER_CONTAINER); honors `unitBasis`/`priceIncludesTax`/geo-scope; snapshots onto OrderItem. Route through `pricing.ts roundMoney`; **never re-derive boxed lines** — this is a 4th tax dimension on top of boxed proration; the interaction is the danger. Add specs to the `pricing.spec.ts` mirror set.
- **W4 — Invoice split service** `[money-path][adversarial review REQUIRED][pair-program]` — group `createInvoiceFromOrder` lines by `trackedCategoryId`, emit one Invoice per `SEPARATE_INVOICE` category, `invoiceGroupId`, `-R1/-R2` numbering, snapshot. **Reuse `createPartialFromOrder` proportional tax.** Hard gate: per-invoice `total=subtotal+tax (±0.01)`, siblings sum == pre-split order total → add to `06-critical-paths.spec.ts` before release. Handle `SEPARATE_SECTION`/`LINE_TAX` or explicitly defer with a fallback.
- **W5 — Regulated ledger writer + filings** `[compliance][money review]` — write `RegulatedSalesLedger` on invoice-line creation; **reverse on credit note/return against the correct sibling invoice**; `GET /regulated/ledger`, `POST /regulated/filings/:category/prepare` (reuse tobacco generator). Compliance gate: E2E asserts **ledger sum == filing export == invoice category tax** to the cent.
- **W6 — Authorization lifecycle + license guard** `[compliance][atomicity-critical][own session]` — customer authorization API (+ approve/reject/renew), buyer-submitted `/buyer/authorizations` propagating to sellers, override endpoint (reason/scope/ack → **audit-log + invoice footnote + follow-up task**). **License guard at point-of-sale**: if `requiresLicense && status != VERIFIED`, block with 3 exits (capture / override / remove), **atomic — no partial sale**, enforced on web + buyer + mobile. Audit immutability is the crux.
- **W7 — Lifecycle + POD + buyer visibility** `[lower risk, ship last]` — license-expiry notifications (bell+email @ 30/7/1d, new cron), standing-order skip of EXPIRED-auth regulated lines, buyer-portal visibility guard (hide unverified-category products + "unlocks after license verified" tile), POD regulated linkage (signatureUrl → order/invoice, age/ID-check stop flags web+mobile).

## (B) Reskin batches (safe, ship like Phase 3) — mostly BLOCKED on the models
- **B1 unblocked now:** compliance hub page shell (bind KPIs to the existing tobacco overview endpoint initially), product-detail "Separately handled" field placement (visual), paired-invoice chip component (renders once `invoiceGroupId` exists).
- **B2 blocked on W1/W2 (reskin-shaped only after backend):** Tracked Categories manager + New Category modal, category chip selector / filings table / rules card, customer-detail Authorizations section, buyer Licenses page, Scope selector (All/Standard/Regulated/Custom, localStorage+URL). **Do not treat B2 as "safe reskin" — the data binding is net-new.**

## Recommended sequencing
1. **W1** (migration review gate) → unblocks everything.
2. **W2 + B1** in parallel (CRUD is safe; visible progress) → then **B2** unblocks.
3. **W3** → **W4** — **separate sessions, pair-programmed, adversarial money review each.** Do not release until `06-critical-paths.spec.ts` money invariants pass.
4. **W5** (ledger+filings) → compliance E2E: ledger == filing == invoice.
5. **W6** (auth guard + audit) → atomicity + audit E2E (own session).
6. **W7** (expiry/POD/buyer-gate) → last.

## Non-negotiable gates (every money/compliance release)
- `npm run verify` + smoke + `post-deploy-check` (rebuild routine — standing).
- Adversarial money review (`/code-review high`) on W3/W4/W5 — focus per-invoice ±0.01 and the boxed-line × category-tax interaction.
- Migration safety per `db-migration`; keep `isTobacco` shadow column one release.

## W1 review follow-ups (deferred, tracked)

From the W1 adversarial review (verdict: **GO, no blockers**). Applied in W1: seed
`requiresLicense=false` (behavior-preserving), added FK-less actor-name snapshots
(`verifiedByName`/`acceptedByName`), rewrote the Step-3 backfill as a semi-join,
added `ROLLBACK.md`. **Deferred (do in the named block):**
- **Deploy-time (W1 apply):** the whole migration runs in ONE transaction; Step-3
  `Order.hasRegulated` backfill is the only data-scaling statement. Confirm prod
  `Order`/`OrderItem` counts are modest + apply off-peak. Pre-apply probe:
  `SELECT count(*) FROM "Product" WHERE "isTobacco"=true AND "tenantId" IS NULL`
  should be 0 (a null-tenant tobacco product would be a data-hygiene bug).
- **W2/W6 — tobacco license enablement:** the Tobacco seed is `requiresLicense=false`.
  Enabling the point-of-sale license block for tobacco is an **explicit per-tenant**
  action (W2 CRUD toggle), never an automatic flip when the W6 guard ships. If a
  global default-on is ever wanted, gate it behind an explicit rollout, not a seed.
- **W6 — customer merge/delete:** `CustomerAuthorization`/`AuthorizationOverride`
  are `ON DELETE CASCADE` on `customerId`. `customers.service.ts` merge (~1198-1217)
  re-points invoices/templates but has NO authorization handling — the W6 merge/delete
  paths must re-point/dedupe authorizations (against `@@unique([customerId,trackedCategoryId])`)
  and the immutable §8 responsibility record must also land in `AuditLog` (not rely
  solely on `AuthorizationOverride`).
- **W5 — app-layer validation** of the intentionally free-text columns: a zod/const-union
  for `reportTemplate` (CA_CDTFA|CA_ABC|CALRECYCLE|GENERIC), a strict `YYYY-MM` check
  when writing `periodBucket`, and a single parser for override `scope`
  (`ORDER:<id>`|`UNTIL:<date>`). Keep the ledger source pointers FK-less/null-tolerant;
  key reversal matching on the `invoiceItemId` index, never a join through a possibly-deleted row.
- **W7 — expiry cron index:** consider `@@index([status, expiresAt])` (or `[tenantId, expiresAt]`)
  on `CustomerAuthorization` so the 30/7/1-day scan filters VERIFIED + upcoming selectively.

## File anchors
`apps/api/prisma/schema.prisma` (OrderItem ~879, Invoice ~1240, InvoiceItem ~1295, TobaccoReport ~2065) · the `pricing.ts` triple mirror (`apps/{api/src/common,web/lib,mobile/lib}/pricing.ts`) + `apps/api/src/common/pricing.spec.ts` · `apps/api/src/invoices/invoices.service.ts` (`createInvoiceFromOrder`/`createPartialFromOrder`) · `apps/web/e2e/06-critical-paths.spec.ts` · new modules `apps/api/src/{tracked-categories,regulated,authorizations}/`.
