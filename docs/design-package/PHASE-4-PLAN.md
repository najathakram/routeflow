# Phase 4 — Regulated Items: Completion Plan

> Scoped 2026-07-06 via a 4-agent gap-analysis workflow. **Phase 4 is XL, high
> money/compliance risk, and genuinely multi-session** — do NOT attempt in one
> sitting. Source of truth: `project/specs/regulated-items-spec.md`; design
> `project/unified/{compliance,tracked-categories,buyer-licenses,product-detail,invoice-detail,action-modals}.html`;
> endpoint map `project/specs/backend-wiring-index.md`. Follow the **db-migration**
> and **rebuild** skills + `CLAUDE_SESSION_PREAMBLE.md` for every migration/deploy.

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

- **W1 — Schema foundation + tobacco migration** `[migration][data-integrity]`
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

## File anchors
`apps/api/prisma/schema.prisma` (OrderItem ~879, Invoice ~1240, InvoiceItem ~1295, TobaccoReport ~2065) · the `pricing.ts` triple mirror (`apps/{api/src/common,web/lib,mobile/lib}/pricing.ts`) + `apps/api/src/common/pricing.spec.ts` · `apps/api/src/invoices/invoices.service.ts` (`createInvoiceFromOrder`/`createPartialFromOrder`) · `apps/web/e2e/06-critical-paths.spec.ts` · new modules `apps/api/src/{tracked-categories,regulated,authorizations}/`.
