# Plan: payment-terms model (migration 20260902; STACKED on fix/invoice-dates-terms)

> Status: IMPLEMENTED (2026-08-23, autopilot on upgraded pipeline; 14 findings fixed, final FULL gate green, split-modal label-clear straggler hand-fixed) · Authored 2026-08-23. This file is the ONLY context implementers receive.
> Designs locked by the 2026-08-22 recon — implement, do not redesign.

## ⚠️ WORKTREE — read before anything else

ALL work happens in:

```
C:\ClaudeCode\routeflow\.claude\worktrees\ap-terms-model
```

Your process may start in `C:\ClaudeCode\routeflow` (main checkout) — do NOT touch files there.
`cd` into the worktree before ANY command; ABSOLUTE paths under the worktree for every file
read/edit. Branch is `feat/payment-terms-model`, cut from `fix/invoice-dates-terms` (PR #416) —
the sale-flow `dueDate`/`terms` overrides and the UTC-safe formatters ALREADY EXIST here; build on
them, do not re-implement or revert them. Do not commit, stage or push. NEVER touch production; the
migration is verified ONLY against a scratch DB you create in the local `routeflow_postgres`
container.

## Objective

Make payment terms a durable, per-customer concept, matching a live client's needs:

- a persisted "Net N" label that always agrees with the due date on every render surface
- per-customer default terms ("this customer is always Net 60")
- Net-terms selection on vendor bills, seeded from a per-supplier default
- a deposit schedule for "50% up front, 50% after Net 60" — deliberately minimal
- a narrow way to correct terms/due date on an issued invoice

## Schema (WP1) — migration `20260902000000_payment_terms`, additive only

- `Invoice.paymentTermsLabel String?` — the structured "Net 30"-style label. **Do NOT reuse
  `Invoice.terms`** — that column is the long-form Terms & Conditions text; conflating them is the
  documented historical bug (`invoices/new/page.tsx` ~L995 comment).
- `Invoice.depositPercent Decimal? @db.Decimal(5, 2)` and `Invoice.depositDueDate DateTime?`
- `Customer.defaultPaymentTerms String?`
- `Supplier.defaultTerms String?`
- `VendorBill.termsLabel String?`

Generate the SQL non-interactively (`prisma migrate dev` HANGS):
`git show ec67881e:apps/api/prisma/schema.prisma > /tmp/schema-old-terms.prisma` — NO, the diff
base must be THIS branch's parent schema: use
`git show HEAD:apps/api/prisma/schema.prisma > /tmp/schema-old-terms.prisma` BEFORE editing, then
edit `schema.prisma`, then
`npx prisma migrate diff --from-schema-datamodel /tmp/schema-old-terms.prisma --to-schema-datamodel apps/api/prisma/schema.prisma --script > apps/api/prisma/migrations/20260902000000_payment_terms/migration.sql`
(create the directory first), add a one-line header comment, then
`npx prisma generate --schema apps/api/prisma/schema.prisma`.

Scratch-DB replay (read `docker ps` for the container name and `docker-compose.yml` for local
credentials — NEVER production values):

```
docker exec <pg-container> psql -U <user> -d postgres -c "CREATE DATABASE terms_check"
DATABASE_URL="postgresql://<user>:<pass>@localhost:5432/terms_check" npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
docker exec <pg-container> psql -U <user> -d terms_check -c "\\d \"Invoice\"" | grep -iE "paymentTermsLabel|depositPercent"
docker exec <pg-container> psql -U <user> -d postgres -c "DROP DATABASE terms_check"
```

## Work packages

### WP1 — schema + migration + replay (files: `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20260902000000_payment_terms/migration.sql`)

As above. Report the replay output verbatim (pass/fail + the two column greps).

### WP2 — API: durable label + customer defaults + deposit fields (files: `apps/api/src/invoices/invoices.service.ts`, `apps/api/src/invoices/dto/create-invoice.dto.ts`, `apps/api/src/invoices/invoices.service.spec.ts`, `apps/api/src/customers/dto/create-customer.dto.ts`, `apps/api/src/customers/dto/update-customer.dto.ts`, `apps/api/src/customers/customers.service.ts`, `apps/api/src/orders/dto/create-sale.dto.ts`, `apps/api/src/orders/orders.service.ts`)

1. `CreateInvoiceDto`: optional `paymentTermsLabel` (`@IsOptional() @IsString() @MaxLength(40)`),
   `depositPercent` (`@IsOptional() @IsNumber() @Min(0.01) @Max(99.99)`), `depositDueDate`
   (`@IsOptional() @IsDateString()`). `create()` persists them. `update()` (DRAFT path) accepts
   the same. `duplicate()` copies `paymentTermsLabel` verbatim, but NOT deposit fields (a duplicate
   is a fresh invoice; note this choice in a comment).
2. The sale-flow overrides object (added by the parent branch) gains `paymentTermsLabel`:
   `CreateSaleDto` gets the same optional field; `createSale` threads it;
   `createInvoiceFromOrder`/`WithTenant`/`createPartialFromOrder` persist it, defaulting to the
   RESOLVED default-terms label (the string `resolveDefaultTerms()` already computes) so
   order-generated invoices are labeled too. INVARIANT: whenever this code path computes a dueDate
   from a terms string, it persists THAT string as `paymentTermsLabel` — label and arithmetic can
   never disagree again.
3. Customer defaults: add `defaultPaymentTerms` to customer create/update DTOs
   (`@IsOptional() @IsIn(["Due on Receipt","Net 15","Net 30","Net 45","Net 60",""])` — check the
   settings VALID_TERMS list in `apps/api/src/system-config/dto/update-invoice-settings.dto.ts`
   and reuse/import its values; empty string clears). `customers.service` persists it. Make
   `resolveDefaultTerms()` customer-aware: new signature
   `resolveDefaultTerms(customerId?: string)` → when the customer has `defaultPaymentTerms`, that
   wins over the tenant SystemConfig; keep the existing 0-arg behavior otherwise, and update the
   invoice-from-order paths to pass the order's customerId.
4. Deposit semantics (deliberately minimal — Tier 1): deposit amount is DERIVED, never stored:
   `roundMoney(Number(total) * Number(depositPercent) / 100)` via `common/pricing.ts` `roundMoney`.
   `findOne`/`findAll` responses expose derived `depositAmount` and
   `depositOverdue = depositDueDate < now && totalPaid < depositAmount` (both computed, not
   persisted). **`recomputeStatus` and AR aging are NOT touched** — the invoice's status contract
   (PAID/PARTIAL/OVERDUE off the single final dueDate) is pinned by existing specs and stays
   byte-identical.
5. Specs: label persists on direct create AND on a sale (and equals the string that derived the
   due date); customer `defaultPaymentTerms` beats tenant default; deposit amount rounds to the
   cent (e.g. 50% of $1,234.5678 total → exactly half, rounded); `recomputeStatus` untouched
   (existing suite green is the proof — do not modify those specs).

### WP3 — API: narrow post-issue terms edit (files: `apps/api/src/invoices/invoices.controller.ts`, `apps/api/src/invoices/dto/update-invoice-terms.dto.ts`, `apps/api/src/invoices/invoices.module.ts`)

New `PATCH /invoices/:id/terms` accepting ONLY `{ dueDate?, paymentTermsLabel?, referenceNumber?, subject? }`
(new small DTO) — never items/discount/shipping/deposit. Allowed on any status EXCEPT `VOID` and
`WRITTEN_OFF` (mirror `applyPriceAdjustment`'s status posture, ~L4334). Implementation lives in a
new focused service method in `invoices.service.ts` — NOTE: WP2 owns that file; to stay
conflict-free, WP3 implements the CONTROLLER route + DTO + module wiring and defines the service
method signature in its report; the service method body itself is WP2's item 6:

> **WP2 item 6 (add to WP2):** `updateTerms(id, dto)`: load, status-gate (reject VOID/WRITTEN_OFF),
> apply the ≤4 fields, re-run `recomputeStatus` (a dueDate change can flip SENT↔OVERDUE), append an
> `internalNotes` breadcrumb (`"Terms updated: <old dueDate> → <new>"` — match
> `applyPriceAdjustment`'s convention ~L4407), and if `AuditService` is injectable without module
> gymnastics, log `{before, after}`; if wiring AuditService into InvoicesService is invasive, the
> internalNotes breadcrumb alone is acceptable — report the choice. Spec: PAID invoice accepts a
> label fix; VOID rejects; dueDate edit flips OVERDUE correctly; a bare terms edit does NOT
> trigger `recomputeOrderFromInvoices` (pin with a spec).

### WP4 — API: vendor-bill terms + supplier default (files: `apps/api/src/vendor-bills/dto/create-vendor-bill.dto.ts`, `apps/api/src/vendor-bills/dto/update-vendor-bill.dto.ts`, `apps/api/src/vendor-bills/vendor-bills.service.ts`, `apps/api/src/suppliers/dto/create-supplier.dto.ts`, `apps/api/src/suppliers/dto/update-supplier.dto.ts`, `apps/api/src/suppliers/suppliers.service.ts`)

`termsLabel` optional on vendor-bill create/update DTOs, persisted verbatim. `defaultTerms` on
supplier DTOs (same @IsIn list as WP2), persisted. NO server-side due-date computation for bills
(the client computes; the server stores what it is sent — bills have no tenant-default machinery
and this PR does not add one). Touch NOTHING near vendor-bill money logic (duplicate detection,
receiving, payment allocation).

### WP5 — web surfaces (files: `apps/web/app/(dashboard)/invoices/new/page.tsx`, `apps/web/app/(dashboard)/invoices/[id]/page.tsx`, `apps/web/app/(dashboard)/invoices/[id]/edit/page.tsx`, `apps/web/lib/api/invoices.ts`, `apps/web/lib/api/customers.ts`, `apps/web/app/(dashboard)/finance/expenses/page.tsx`, `apps/web/lib/api/vendor-bills.ts`, `apps/web/lib/api/suppliers.ts`)

1. New-invoice page: send `paymentTermsLabel: terms || undefined` in BOTH submit paths (standalone
   `buildInvoiceDto` and `handleSubmitSale`); prefill the Terms dropdown from the selected
   customer's `defaultPaymentTerms` (falling back to the existing tenant-default seeding — the
   customer effect runs when a customer is picked and must respect a term/date the operator
   already chose, same guard pattern as the existing seeding effect). Deposit UI: a small optional
   "Deposit" row (percent input + deposit due date input, hidden behind a "+ Add deposit" link)
   sending `depositPercent`/`depositDueDate`.
2. Invoice detail: render "Terms: {paymentTermsLabel}" when present (falls back to nothing — the
   T&C text keeps its own section); deposit badge when `depositOverdue`; an "Edit terms" affordance
   (dueDate + label + reference/subject) calling the new PATCH, visible on non-VOID/WRITTEN_OFF.
3. Invoice edit page (DRAFT): expose the Net-N dropdown (same TERMS_OPTIONS as the create page)
   bound to `paymentTermsLabel`, recomputing dueDate exactly like the create page.
4. Vendor bills — `CreateBillModal` in `finance/expenses/page.tsx`: add the Net-N dropdown; picking
   a term computes Due Date = Bill Date + days (client-side); prefill from the selected supplier's
   `defaultTerms` when present; send `termsLabel`. Supplier form: a "Default payment terms" select
   (locate the supplier create/edit form — likely `suppliers/page.tsx` or a component; report the
   real file if different and edit it INSTEAD of guessing).
5. Update the typed clients (`lib/api/*.ts`) for every new field.

### WP6 — PDF/email/portal/mobile label render (files: `apps/api/src/invoices/invoice-pdf-template.tsx`, `apps/api/src/email/email.service.ts`, `apps/web/app/buyer/portal/[seller]/invoices/[id]/page.tsx`, `apps/mobile/app/(operator)/(tabs)/invoices/[id].tsx`, `apps/mobile/app/(customer)/invoices/[id].tsx`, `apps/mobile/lib/api/invoices.ts`)

Render `paymentTermsLabel` as the "Terms:" line on: the PDF template (near the existing
issue/due-date block; the T&C text block stays separate), the invoice email builder
(`buildInvoiceEmail` — find where due date renders and add the label beside it), the buyer-portal
invoice detail, and both mobile invoice detail screens. Null label → render nothing (historical
invoices). Mobile typings updated.

## Acceptance criteria

1. Label and due date can never disagree on any NEW invoice: every path that derives a dueDate from
   a terms string persists that string — spec-proven on sale + order-generated + direct create.
2. Customer default beats tenant default; supplier default prefills bill terms.
3. Deposit math to the cent via `roundMoney`; status/AR-aging code byte-untouched.
4. Terms correctable post-issue except VOID/WRITTEN_OFF; order back-sync not triggered (spec).
5. Migration replays clean on scratch; all columns nullable; historical rows render unchanged.
6. Full gates green.

## Out of scope

An `InvoiceInstallment` table / deposit-aware statuses or AR-aging buckets (explicitly deferred —
say so in comments where tempted) · reminders/dunning · mobile editing UIs ·
`.claude/code-map` (orchestrator updates it).

## Verification commands (from the worktree root)

```
cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-terms-model && npm run check-types
cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-terms-model && npm run lint
cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-terms-model && npm run test
```
