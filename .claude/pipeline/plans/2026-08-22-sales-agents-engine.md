# Plan: Sales Agents & commissions — the ENGINE (PR-C)

> ## ⚠️ WORKTREE — read before anything else (added 2026-08-23 for the autopilot run)
>
> ALL work happens in the git worktree
> `C:\ClaudeCode\routeflow\.claude\worktrees\ap-sales-agents` (branch
> `feat/sales-agents-engine`, already checked out). Your process may start in
> `C:\ClaudeCode\routeflow` (the main checkout) — you must NOT touch files there. `cd` into the
> worktree before ANY command (git, npm, npx, docker) and use ABSOLUTE paths under the worktree
> for every file read/edit. Every relative path in this plan is relative to the worktree root.
> "Repo root" below means the WORKTREE root. Do not commit, stage, or push — the orchestrator
> handles git. The migration replay check runs ONLY against a scratch database you create in the
> local `routeflow_postgres` container — never any other database.

> Authored by Fable 5 on 2026-08-22. Status: IMPLEMENTED (2026-08-23, autopilot; pipeline clean + Fable adversarial pass: 1 CRIT + 2 MAJOR found and fixed by hand, 2 MINOR flagged; gate green 2678 api tests)
> This file is the ONLY context the implementation and review agents receive.
> It must stand alone: no references to "the conversation", no "as discussed".
>
> Grounded in a 4-agent code recon (2026-08-22) run against branch
> `feat/msrp-on-invoices` @ `bab970e9` — i.e. **the state master will have after PR #411
> (MSRP) merges**. Every line anchor below is from that state. If PR #411 gains more
> commits before merging, re-find anchors by the quoted method names, not line numbers.

## Objective

Sales agents bring customers in and earn a commission % on those customers' invoices.
Build the **records + engine + API** for that: agent records (no login), effective-dated
rates and customer attribution, an idempotent commission ledger that accrues when an
invoice is issued and releases payable **pro-rata as the invoice is paid** (no commission
on bad debt), statements → approval → payouts that land in the books as
`COMMISSIONS_AND_FEES` expenses. Everything behind `flag.sales_agents` (default OFF for
every tenant); when the flag is off the engine no-ops and nothing is visible.
**No web/mobile UI in this PR** — that is PR-D. This PR must be shippable dark.

### Owner decisions (locked — do not re-litigate)

1. **Hybrid trigger**: commission ACCRUES on invoice issue; becomes PAYABLE pro-rata as
   the invoice is paid. No commission on bad debt.
2. **Agents are records-only v1** — no login, no new UserRole. Design a nullable
   `userId` seat for a future AGENT role; build nothing on it.
3. **Commission base** = product subtotal after discounts, **EXCLUDING tax and shipping**.
4. **Entitlement**: `flag.sales_agents`, default OFF, one trunk — variation is
   configuration, never a per-tenant branch.

## Landing order & collision contract with PR-B (MSRP, PR #411)

**PR-B lands first. This is not optional.** PR-C's implementer MUST branch off master
only after PR #411 (`feat/msrp-on-invoices`) has merged — verify with
`git log --oneline -5 | grep -i msrp` before starting; if it is not there, STOP.

Resources PR-B has already claimed (do NOT reuse):

| Slot                   | PR-B (claimed, in flight)                                             | PR-C (this plan) takes                                                                |
| ---------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Migration              | `20260831000000_add_msrp_pricing`                                     | **`20260901000000_add_sales_agents_commissions`**                                     |
| Catalog publish script | `apps/api/prisma/publish-plan-catalog-v9.ts` (adds the MSRP SKU only) | **new `publish-plan-catalog-v10.ts`** (adds the SALES_AGENTS SKU only; never edit v9) |
| npm script             | `db:publish:catalog:v9` (apps/api/package.json:26)                    | **`db:publish:catalog:v10`** appended below it                                        |
| Flag / SKU             | `flag.msrp` / `"MSRP"` (last entries in `FLAG_KEYS` / `ADDON_SKUS`)   | **`flag.sales_agents` / `"SALES_AGENTS"`** appended after them                        |

Files BOTH PRs touch — expect PR-B's changes already on master; **rebase, don't collide**
(PR-C's edits are additive next to PR-B's):

- `apps/api/prisma/schema.prisma` — PR-B added `Product.msrp`, `CustomerPrice.msrp`
  (+nullable tier), `InvoiceItem.msrp`. PR-C adds whole new models + `Order.commissionRatePct`.
- `apps/api/src/billing/plan-catalog.constants.ts` — PR-B appended `"flag.msrp"` /
  `"MSRP"` / both map entries; PR-C appends its own directly after each.
- `apps/api/src/invoices/invoices.service.ts` — PR-B added `applyMsrpSnapshots` + ~10
  call sites. PR-C adds commission hooks (WP4). All WP4 anchors already account for PR-B.
- `apps/api/src/invoices/invoices.module.ts` — PR-B appended `EntitlementsModule` to
  imports; PR-C appends `CommissionsModule` after it.
- `apps/api/src/invoices/invoices.service.spec.ts` — PR-B added the `EntitlementsService`
  mock provider; PR-C adds a `CommissionEngineService` mock provider beside it.
- `apps/api/src/customers/customers.service.ts` (+ `customers.service.spec.ts`) — PR-B
  reworked `upsertCustomerPrice`; PR-C touches only `create()` (~L397-451) — different region.
- `apps/api/src/estimates/estimates.service.ts` — PR-B touched `convertToInvoice`. PR-C
  needs **no change there** (conversion creates DRAFT only — verified), so no conflict.
- `apps/web/app/(platform-admin)/admin/tenants/[id]/page.tsx` — PR-B appended the `msrp`
  entry to `AVAILABLE_ADDONS` (~L133-138); PR-C appends `sales_agents` after it.
- `apps/api/package.json` — PR-B added the `:v9` script; PR-C adds `:v10` below it.
- `apps/api/src/orders/orders.service.spec.ts` — PR-B touched it; PR-C adds the engine
  mock provider (WP4) — additive.
- Docs both PRs touch (`.claude/code-map/*`, `HANDOFF.md`): resolve by appending.

**Deploy order for PR-C** (the human runs these, per the standing prod routine — the
implementer only writes the artifacts): (1) prod migration `20260901000000_...` via
`prod-migrate.mjs`, (2) deploy the app (engine is dark: no plan grants the flag),
(3) `railway run npm run db:publish:catalog:v10 -w apps/api` — v9 must already be
published (PR-B's landing step), the v10 script tolerates any order but assume v9 first,
(4) enable the `sales_agents` addon per requesting tenant from the platform-admin panel.
PR-B's entitlements fallback (pinned `PlanVersion` predating a SKU falls back to the
PUBLISHED catalog, `entitlements.service.ts:174-202`) already covers grandfathered
tenants for the new SKU — nothing extra needed.

## Constraints & conventions

- npm + Turbo monorepo; NestJS 11 API (`apps/api`), Prisma 7 + Postgres. Prettier:
  semicolons, double quotes, printWidth 100, trailing commas. ESLint per workspace only.
- **Money discipline**: every monetary write goes through `roundMoney` from
  `apps/api/src/common/pricing.ts`. Money columns are `Decimal @db.Decimal(10, 2)`.
  Commission is computed ONCE per document (never summed per line). Epsilon for
  paid/complete comparisons is `0.005` (the codebase uses `0.001` in `recomputeStatus`;
  the engine uses 0.005 consistently — both are sub-cent, do not mix within the engine).
- **Tenant isolation**: `this.prisma.forTenant()` / `this.prisma.tenantTransaction(fn)`
  (`apps/api/src/prisma/prisma.service.ts:24/36/223`). `tenantTransaction` auto-injects
  `tenantId` on create and auto-filters reads. Cron jobs have NO tenant context — they
  must loop tenants and wrap each in `this.tenantCtx.run(tenant.id, ...)` (see WP3).
- **The engine must never break an invoice or payment flow.** Hooks call a `...Safe`
  wrapper that catches, logs loudly, and returns — the hourly reconciliation heals drift.
  The only intentionally-throwing paths are the engine's own API and the delete guards.
- **Do NOT touch** `bookkeeping.service.ts`, `invoice-pdf*`, `email.service.ts`, any web
  page other than the one-line `AVAILABLE_ADDONS` entry, anything mobile. No new UserRole.
- Migrations are **never** auto-applied on deploy. Write the SQL, replay it only on a
  local scratch DB. Prisma 7 does not auto-load `.env` when `prisma.config.ts` exists —
  export `DATABASE_URL` explicitly for CLI calls; `prisma migrate dev` hangs
  non-interactively, never run it.
- Conventional Commits; branch `feat/sales-agents-engine`.

## Verified codebase facts (post-PR-B anchors — trust these, they were read)

**Invoice reality** (`apps/api/prisma/schema.prisma:1762-1825`):

- Money fields: `subtotal`, `taxAmount`, `discount`, `shippingFee`, `total` — all
  `Decimal(10,2)`. **There is NO `paidAmount` column** — paid state is always derived by
  summing `InvoicePayment` rows. `issueDate DateTime @default(now())` is the canonical
  document date. No soft-delete on Invoice.
- `InvoiceStatus` (schema:201-210): `DRAFT SENT VIEWED PARTIAL PAID OVERDUE VOID
WRITTEN_OFF`. "Issued" for commission purposes = NOT `DRAFT` and NOT `VOID`
  (`WRITTEN_OFF` counts as issued — it froze, it didn't un-happen).
- `InvoicePayment` (schema:1890-1940): `amount`, `method PaymentMethod`,
  `status PaymentStatus @default(PAID)` where `PaymentStatus = DRAFT | PAID | VOID`,
  `settledAt`, check fields (`checkStatus`, `bouncedAt`). **Commission cash math counts
  ONLY `status: PAID` rows** — DRAFT payments are unsettled placeholders (the repo's
  known "DRAFT-payment trap"), VOID are dead. Note this deliberately diverges from
  `recomputeStatus` (invoices.service.ts:135-154) which filters only `!== VOID`.
- A credit-note application against an invoice IS an `InvoicePayment` with
  `method: CREDIT_NOTE` and `creditNoteId` set. There is no separate application model.
- Invoice numbering does NOT use `NumberingSequence` (that table exists but is only
  consumed by `import/numbering.service.ts` — its own doc comment says live minting is
  deferred). Live numbers come from a max+1 scan: `generateInvoiceNumber` at
  `invoices.service.ts:2090-2100`, backstopped by `@@unique([tenantId, invoiceNumber])`.
  Statement numbering copies this pattern (prefix `CST-YYYY-`), NOT `NumberingSequence`.

**Order / recurring** (schema): `Order.orderDate DateTime?` (schema:1237 — the business
date; staff-only, backdatable via `parseOrderDate`, orders.service.ts:1381-1410, gated to
OPERATOR/TENANT_ADMIN, rejects future and >2y-old dates). `Order.templateId` →
`orderTemplate OrderTemplate?` (schema:1258; `OrderTemplate.createdAt` at 1608).
`Invoice.recurringInvoiceId` → `RecurringInvoice.createdAt` (schema:2668). These two
`createdAt`s are the grandfathering pivots.

**Entitlements** (all in `apps/api/src/billing/`):

- `FLAG_KEYS` (plan-catalog.constants.ts:14-30, `flag.msrp` currently last);
  `ADDON_SKUS` (:77-88, string-literal tuple, `"MSRP"` last); `FLAG_TO_ADDON_SKU`
  (:171-177); `LEGACY_ADDON_KEY_TO_SKU` (:191-194, `msrp: "MSRP"` last).
- `EntitlementsService.hasFlag(tenantId, flagKey)` (entitlements.service.ts:83), 30s
  cache, `invalidate(tenantId)` at :110. `EntitlementsModule`
  (entitlements.module.ts) provides+exports `PlanCatalogService, EntitlementsService,
MeterService, PlanFlagGuard`; it is re-exported by `BillingModule`.
- Guard wiring precedent (products.controller.ts:83-93): class keeps
  `@UseGuards(JwtAuthGuard, RolesGuard)`; the gated route adds method-level
  `@UseGuards(PlanFlagGuard)` + `@RequirePlanFlag("flag.msrp")`. **Verified:**
  `PlanFlagGuard` reads metadata with `getAllAndOverride([handler, class])`
  (plan-flag.guard.ts:35-37), so for PR-C's all-gated controllers put
  `@UseGuards(JwtAuthGuard, RolesGuard, PlanFlagGuard)` + `@RequirePlanFlag("flag.sales_agents")`
  at CLASS level once. Guard fails closed; SUPER_ADMIN (null tenant) passes.
- v9 publish script structure (publish-plan-catalog-v9.ts): raw `pg.Pool` + `PrismaPg`,
  self-check ADDON_SKUS↔seeds, `alreadyPublished` marker guard, DRAFT-resume only if the
  draft carries its own marker SKU, publish = prior PUBLISHED → SUPERSEDED in one
  `$transaction`, version = max+1 (never hardcoded). v10 = clone with marker
  `"SALES_AGENTS"` and one appended seed.
- Platform-admin addon toggle: `AVAILABLE_ADDONS` (admin/tenants/[id]/page.tsx:96-144,
  legacy free-text keys); server side `POST /platform-admin/tenants/:id/addons/enable|disable`
  (platform-admin.controller.ts:321-349) upserts the key as-is (no whitelist — a typo'd
  key silently grants nothing) and calls `recordAdminAction` (audited).

**Finance**:

- `ExpenseCategory` (schema:1954-1967, `@@unique([tenantId, code])`); IRS seed row
  `{ code: "COMMISSIONS_AND_FEES", name: "Commissions and Fees" }`
  (bookkeeping/irs-categories.constant.ts:9); categories are seeded at tenant create and
  idempotently backfillable (`ensureSystemCategories`, bookkeeping.service.ts:292-312).
- `Expense` (schema:1976-2023): `categoryId?`, `amount`, `date` (the P&L date),
  `paymentMethod String?`, `status ExpenseStatus (PENDING RECEIVED PAID VOID)`, `paidAt?`,
  `deletedAt?`. `getProfitAndLoss` (bookkeeping.service.ts:912) reads
  `expense.findMany({ deletedAt: null, date: range })` and groups by category name — so a
  payout-linked `COMMISSIONS_AND_FEES` Expense surfaces in P&L **with zero bookkeeping
  changes**. That is the v1 books story: commission expense is booked at PAYOUT (cash);
  accrual-basis reporting is PR-D's report.
- Payout allocation pattern to mirror: `recordSupplierPayment`
  (vendor-bills.service.ts:1894): validate first, one `tenantTransaction`, **re-derive
  already-paid from the ledger rows inside the tx (never trust a snapshot column)**,
  re-derive status from the just-written sum.

**Module/DI/test conventions**:

- Feature modules are flat entries in `app.module.ts` imports (:118-167).
  `ScheduleModule.forRoot()` is already registered (:116); 12 `@Cron` jobs exist; the
  multi-tenant cron pattern (recurring-invoices.service.ts:227-260) is: fetch ACTIVE
  tenants → `this.tenantCtx.run(tenant.id, async () => { ...forTenant()... })` per
  tenant. `TenantContextService` is the injectable (`tenantCtx`).
- `AuditModule` is `@Global()` — `AuditService.log(dto)` (audit.service.ts:18-34,
  `CreateAuditLogDto { tenantId, userId, action, entityType, entityId?, meta? }`) is
  injectable anywhere without imports; it swallows its own errors.
- Specs: `createMockPrisma()` from `apps/api/src/testing/prisma-mock.ts`; services
  mocked at the provider boundary (see invoices.service.spec.ts:111-137 — PR-B's
  `EntitlementsService` mock `{ hasFlag: jest.fn().mockResolvedValue(false) }` is the
  template). Jest config is embedded in apps/api/package.json (`rootDir: src`,
  `testRegex .spec.ts`) — new spec files are picked up automatically. Pure-math specs
  follow `common/pricing.spec.ts` (no TestingModule).
- Partial-unique-index precedent (raw SQL in a migration — Prisma DSL can't express it):
  `migrations/20260826000000_stripe_connect_event_ledger/migration.sql:53`.
- Only Users↔Auth use `forwardRef` — do not add more. `CommissionsModule` imports only
  `PrismaModule` + `EntitlementsModule`; consumer modules import `CommissionsModule`
  one-way. No cycles.

## Engine design (the part that must not be reinvented downstream)

### Money semantics — exact formulas

For one invoice, using ONLY `status: PAID` payment rows:

```
goods          = max(0, subtotal − discount)                       // tax+shipping excluded by construction
creditApplied  = Σ payments where method = CREDIT_NOTE             // returns applied to this invoice
cashCollected  = Σ payments where method ≠ CREDIT_NOTE             // CASH/CHECK/ACH/ZELLE/CREDIT_CARD/ADVANCE/OTHER
creditPrincipal= total > ε ? roundMoney(creditApplied × goods / total) : 0
                                                                   // pre-tax share of the credit — a $54 credit
                                                                   // against a $108 invoice with $100 goods
                                                                   // reduces base by $50, not $54
base           = roundMoney(max(0, goods − creditPrincipal))
collectible    = roundMoney(total − creditApplied)                 // what cash can still arrive
ratio          = collectible ≤ ε ? 1
               : (collectible − cashCollected ≤ ε) ? 1             // full-payment snap
               : clamp(cashCollected / collectible, 0, 1)
accrued        = roundMoney(base × ratePct / 100)                  // earned at issue
payable        = roundMoney(accrued × ratio)                       // released as cash lands
ε = 0.005
```

Consequences (all intentional, all spec'd): ADVANCE counts as cash (it is money the
customer really deposited); a bounced check flips its payment to VOID → ratio drops →
payable drops; WRITTEN_OFF needs **no special engine handling** — payable = accrued ×
cash ratio, the uncollected remainder simply never releases (= no commission on bad
debt), and any later recovery payment releases naturally; a fully-credited invoice
(collectible ≈ 0) has base ≈ 0 so ratio=1 is harmless; zero/negative documents produce
zero accruals.

### Rate resolution (precedence, anchored on basisDate)

```
basisDate = order?.orderDate ?? invoice.issueDate
1. Order.commissionRatePct        — per-order override; 0 is a VALID value meaning "exempt"
2. newest CustomerCommissionRate  where effectiveFrom ≤ basisDate  (per customer)
3. newest SalesAgentRate          where effectiveFrom ≤ basisDate  (per agent)
4. NONE → write a ZERO accrual row (ratePct 0, source NONE, amounts 0) so a later
   backdated rate has something the recompute sweep will find and fix
```

The attributed agent = the `AgentAssignment` row covering basisDate
(`effectiveFrom ≤ basisDate AND (effectiveTo IS NULL OR effectiveTo > basisDate)`).
No covering assignment → house account → target zero (no row; delete any stale ones).

### Agent lifecycle semantics

- `ACTIVE` — normal.
- `PAUSED` — blocks **creation** of new accrual rows; existing rows keep releasing
  payable as payments land. **Default taken (flag to owner in review):** pause DEFERS
  rather than forfeits — after resume, the next sync/reconciliation backfills invoices
  issued during the pause. Forfeiting is what STOPPED_FOR_NEW and the 0-override are
  for. (A forfeiting pause would require pause-interval history — out of v1 scope.)
- `STOPPED_FOR_NEW` + `stopNewBusinessAt` — for `basisDate ≥ stopNewBusinessAt`, accrue
  ONLY if grandfathered: `order.orderTemplate.createdAt < stopNewBusinessAt` OR
  `invoice.recurringInvoice.createdAt < stopNewBusinessAt`. All four quadrants spec'd.
- Soft-delete (`deletedAt`) only; blocked while any accrual has `claimedAmount > 0`
  outstanding or an unpaid statement exists. Deactivated ≠ deleted; history stays.

### The ledger invariant (how mutable meets append-only)

Per accrual A (one row per `[tenantId, invoiceId, agentId]` — the double-accrual lock):

```
claims(A)   = Σ CLAIM-line amounts on non-VOID statements referencing A   (denormalized as A.claimedAmount)
adjTotal(A) = Σ CommissionAdjustment.amount referencing A                  (append-only, signed)
drift(A)    = payable(A) − claims(A) − adjTotal(A)

at SYNC:        payable(A) is recomputed freely (rows are mutable until claimed);
                if drift < −ε  → append ONE CommissionAdjustment(amount = drift, kind by cause).
                Never mutate claims; never re-emit (the formula self-limits: after the
                append, drift = 0).
at GENERATION:  claim line amount = drift when > ε. Plus sweep every unclaimed
                adjustment (negative lines) and the unabsorbed negative residual of prior
                statements (CARRYFORWARD line).
INVARIANT:      over all time, Σ(statement lines) + Σ(unclaimed adjustments) → payable.
                Convergence is what makes backdating, clawbacks, reassignment, and order
                edits all the same code path.
```

Adjustment kinds: `CLAWBACK` (void/credit/payment-void after claiming), `RATE_CHANGE`
(backdated rate), `REASSIGNMENT` (backdated attribution change), `MANUAL` (operator).
A sync that changes the resolved agent zero-targets every OTHER agent's row on that
invoice through the same drift rule.

### Statement / payout lifecycle

- At most ONE `PENDING` statement per agent (generation 409s otherwise). Generation runs
  in a Serializable `tenantTransaction`; approval re-validates every line against live
  drift and 409s `"stale — regenerate"` if anything moved in between (same optimistic
  pattern as `send`'s Serializable tx).
- `VOID` allowed only from PENDING: delete the lines in-tx (decrement `claimedAmount`,
  which releases swept adjustments and carryforwards automatically via the unique refs).
- APPROVED statements are immutable; payouts only on APPROVED with `totalAmount > 0`;
  cap = `totalAmount − Σ(existing payouts)` **re-derived from payout rows inside the tx**
  (the `recordSupplierPayment` landmine rule). Each payout creates one linked
  `COMMISSIONS_AND_FEES` Expense (`status: PAID`, `date = paidAt`) in the same tx; when
  Σ payouts ≥ total − ε → statement `PAID`.
- Negative statements (clawbacks dominate) can be generated + approved (they record the
  netting); payouts are blocked on them; the next generation sweeps their residual as a
  CARRYFORWARD line (each prior statement swept at most once — unique ref).

## Work packages

Waves: **WP1 ∥ WP2** → **WP3** → **WP4 ∥ WP5**. WP3 and WP5 share
`commissions.module.ts` (they are already sequential). WP4/WP5 import types and
signatures pinned in WP3 — transplant them, do not redesign.

### WP1 — Schema + migration

- **files:** `apps/api/prisma/schema.prisma`,
  `apps/api/prisma/migrations/20260901000000_add_sales_agents_commissions/migration.sql`
- **brief:**
  1. Add the models/enums below verbatim (adjust only relation back-fields). Add
     back-relations on `Tenant` (one array field per new model, matching house style),
     `Customer` (`agentAssignments AgentAssignment[]`, `commissionRates
CustomerCommissionRate[]`, `commissionAccruals CommissionAccrual[]` — beside
     `tagAssignments`/`prices` in the relation block, schema:756-786), `Invoice`
     (`commissionAccruals CommissionAccrual[]`), `User`
     (`salesAgentSeat SalesAgent?`), and `Order.commissionRatePct Decimal? @db.Decimal(5, 2)`
     with a comment: staff-set per-order override; `0` = exempt; `null` = no override.
  2. Generate the migration SQL non-interactively:
     `git show master:apps/api/prisma/schema.prisma > /tmp/schema-old.prisma` then
     `npx prisma migrate diff --from-schema-datamodel /tmp/schema-old.prisma
--to-schema-datamodel apps/api/prisma/schema.prisma --script >
apps/api/prisma/migrations/20260901000000_add_sales_agents_commissions/migration.sql`
     (NEVER `prisma migrate dev` — it hangs). Then append the partial unique index by
     hand (below) and a header comment. Then `npx prisma generate`.
  3. Replay check on a scratch DB (see Verification) — the full chain, PR-B's
     `20260831000000` included.
- **exact code — Prisma models** (money `Decimal(10,2)`, rates `Decimal(5,2)` 0–100):

  ```prisma
  enum SalesAgentStatus {
    ACTIVE
    PAUSED
    STOPPED_FOR_NEW
  }

  enum CommissionRateSource {
    ORDER_OVERRIDE
    CUSTOMER_RATE
    AGENT_DEFAULT
    NONE
  }

  enum CommissionAccrualStatus {
    PENDING // issued, nothing collected yet
    PARTIAL // some cash landed, ratio < 1
    PAYABLE // ratio = 1, not fully claimed
    SETTLED // fully claimed and converged
    VOID    // invoice un-issued / reassigned away — target 0
  }

  enum CommissionAdjustmentKind {
    CLAWBACK
    RATE_CHANGE
    REASSIGNMENT
    MANUAL
  }

  enum CommissionStatementStatus {
    PENDING
    APPROVED
    PAID
    VOID
  }

  enum CommissionStatementLineKind {
    CLAIM        // positive: unclaimed payable on one accrual
    ADJUSTMENT   // signed: sweeps one CommissionAdjustment exactly once
    CARRYFORWARD // negative: absorbs a prior statement's negative residual
  }

  model SalesAgent {
    id                String           @id @default(uuid())
    name              String
    email             String?
    phone             String?
    notes             String?
    status            SalesAgentStatus @default(ACTIVE)
    // Set when status -> STOPPED_FOR_NEW; the grandfathering pivot (see engine rules).
    stopNewBusinessAt DateTime?
    // Future AGENT-role login seat (owner decision: records-only v1, seat designed now).
    userId            String?          @unique
    deletedAt         DateTime?
    createdAt         DateTime         @default(now())
    updatedAt         DateTime         @updatedAt
    tenantId          String?

    tenant        Tenant?                  @relation(fields: [tenantId], references: [id])
    user          User?                    @relation(fields: [userId], references: [id])
    rates         SalesAgentRate[]
    assignments   AgentAssignment[]
    customerRates CustomerCommissionRate[]
    accruals      CommissionAccrual[]
    adjustments   CommissionAdjustment[]
    statements    CommissionStatement[]

    @@index([tenantId])
    @@index([tenantId, status])
  }

  model SalesAgentRate {
    id            String   @id @default(uuid())
    agentId       String
    ratePct       Decimal  @db.Decimal(5, 2)
    // Rate rows are INSERT-ONLY history: newest effectiveFrom <= basisDate wins.
    effectiveFrom DateTime
    createdAt     DateTime @default(now())
    tenantId      String?

    tenant Tenant?    @relation(fields: [tenantId], references: [id])
    agent  SalesAgent @relation(fields: [agentId], references: [id])

    @@unique([tenantId, agentId, effectiveFrom])
    @@index([agentId, effectiveFrom])
    @@index([tenantId])
  }

  model CustomerCommissionRate {
    id            String   @id @default(uuid())
    customerId    String
    agentId       String // who negotiated it, for display; resolution is per-customer
    ratePct       Decimal  @db.Decimal(5, 2)
    effectiveFrom DateTime
    createdAt     DateTime @default(now())
    tenantId      String?

    tenant   Tenant?    @relation(fields: [tenantId], references: [id])
    customer Customer   @relation(fields: [customerId], references: [id])
    agent    SalesAgent @relation(fields: [agentId], references: [id])

    @@unique([tenantId, customerId, effectiveFrom])
    @@index([customerId, effectiveFrom])
    @@index([tenantId])
  }

  model AgentAssignment {
    id            String    @id @default(uuid())
    customerId    String
    agentId       String
    effectiveFrom DateTime
    // null = current holder. History is never rewritten: reassignment closes the open
    // row (sets effectiveTo) and inserts a new one. Partial unique index (raw SQL in
    // the migration): one open row per (tenantId, customerId).
    effectiveTo   DateTime?
    createdAt     DateTime  @default(now())
    tenantId      String?

    tenant   Tenant?    @relation(fields: [tenantId], references: [id])
    customer Customer   @relation(fields: [customerId], references: [id])
    agent    SalesAgent @relation(fields: [agentId], references: [id])

    @@index([customerId, effectiveFrom])
    @@index([agentId])
    @@index([tenantId])
  }

  model CommissionAccrual {
    id            String                  @id @default(uuid())
    invoiceId     String
    agentId       String
    customerId    String
    // order.orderDate ?? invoice.issueDate — the attribution + rate anchor.
    basisDate     DateTime
    baseAmount    Decimal                 @db.Decimal(10, 2)
    ratePct       Decimal                 @db.Decimal(5, 2)
    rateSource    CommissionRateSource
    accruedAmount Decimal                 @db.Decimal(10, 2)
    payableAmount Decimal                 @db.Decimal(10, 2)
    // Denormalized Σ of CLAIM lines on non-VOID statements. Source of truth is the lines.
    claimedAmount Decimal                 @default(0) @db.Decimal(10, 2)
    status        CommissionAccrualStatus @default(PENDING)
    createdAt     DateTime                @default(now())
    updatedAt     DateTime                @updatedAt
    tenantId      String?

    tenant      Tenant?                   @relation(fields: [tenantId], references: [id])
    invoice     Invoice                   @relation(fields: [invoiceId], references: [id])
    agent       SalesAgent                @relation(fields: [agentId], references: [id])
    customer    Customer                  @relation(fields: [customerId], references: [id])
    adjustments CommissionAdjustment[]
    lines       CommissionStatementLine[]

    @@unique([tenantId, invoiceId, agentId]) // the double-accrual lock
    @@index([agentId, status])
    @@index([customerId])
    @@index([tenantId, basisDate])
  }

  model CommissionAdjustment {
    id        String                   @id @default(uuid())
    accrualId String
    agentId   String
    kind      CommissionAdjustmentKind
    // Signed; in practice negative (drift < -epsilon emission rule). Append-only.
    amount    Decimal                  @db.Decimal(10, 2)
    reason    String?
    createdAt DateTime                 @default(now())
    tenantId  String?

    tenant  Tenant?                  @relation(fields: [tenantId], references: [id])
    accrual CommissionAccrual        @relation(fields: [accrualId], references: [id])
    agent   SalesAgent               @relation(fields: [agentId], references: [id])
    line    CommissionStatementLine?

    @@index([agentId])
    @@index([accrualId])
    @@index([tenantId])
  }

  model CommissionStatement {
    id              String                    @id @default(uuid())
    statementNumber String
    agentId         String
    periodFrom      DateTime?
    periodTo        DateTime?
    status          CommissionStatementStatus @default(PENDING)
    totalAmount     Decimal                   @db.Decimal(10, 2)
    paidAmount      Decimal                   @default(0) @db.Decimal(10, 2)
    approvedAt      DateTime?
    notes           String?
    createdAt       DateTime                  @default(now())
    updatedAt       DateTime                  @updatedAt
    tenantId        String?

    tenant       Tenant?                   @relation(fields: [tenantId], references: [id])
    agent        SalesAgent                @relation(fields: [agentId], references: [id])
    lines        CommissionStatementLine[]
    payouts      CommissionPayout[]
    carriedInto  CommissionStatementLine[] @relation("CarryForwardSource")

    @@unique([tenantId, statementNumber])
    @@index([agentId, status])
    @@index([tenantId])
  }

  model CommissionStatementLine {
    id                     String                      @id @default(uuid())
    statementId            String
    kind                   CommissionStatementLineKind
    // Exactly ONE of the three refs is set, matching kind.
    accrualId              String?
    adjustmentId           String?                     @unique
    carriedFromStatementId String?                     @unique
    amount                 Decimal                     @db.Decimal(10, 2)
    description            String?
    tenantId               String?

    tenant             Tenant?               @relation(fields: [tenantId], references: [id])
    statement          CommissionStatement   @relation(fields: [statementId], references: [id])
    accrual            CommissionAccrual?    @relation(fields: [accrualId], references: [id])
    adjustment         CommissionAdjustment? @relation(fields: [adjustmentId], references: [id])
    carriedFrom        CommissionStatement?  @relation("CarryForwardSource", fields: [carriedFromStatementId], references: [id])

    @@index([statementId])
    @@index([accrualId])
    @@index([tenantId])
  }

  model CommissionPayout {
    id          String        @id @default(uuid())
    statementId String
    amount      Decimal       @db.Decimal(10, 2)
    method      PaymentMethod
    reference   String?
    notes       String?
    paidAt      DateTime      @default(now())
    // The linked COMMISSIONS_AND_FEES Expense — how payouts reach P&L/cash reports
    // with zero bookkeeping.service changes.
    expenseId   String        @unique
    createdAt   DateTime      @default(now())
    tenantId    String?

    tenant    Tenant?             @relation(fields: [tenantId], references: [id])
    statement CommissionStatement @relation(fields: [statementId], references: [id])
    expense   Expense             @relation(fields: [expenseId], references: [id])

    @@index([statementId])
    @@index([tenantId])
  }
  ```

  (`Expense` gains the back-relation `commissionPayout CommissionPayout?`.)

- **exact SQL — append after the generated script:**

  ```sql
  -- One OPEN assignment per customer (effectiveTo IS NULL = current holder).
  -- Prisma DSL cannot express partial unique indexes; precedent:
  -- 20260826000000_stripe_connect_event_ledger (BuyerPaymentRequest_open_request_key).
  CREATE UNIQUE INDEX "AgentAssignment_open_assignment_key"
    ON "AgentAssignment"("tenantId", "customerId")
    WHERE "effectiveTo" IS NULL;
  ```

### WP2 — Flag + catalog + admin wiring

- **files:** `apps/api/src/billing/plan-catalog.constants.ts`,
  `apps/api/prisma/publish-plan-catalog-v10.ts`, `apps/api/package.json`,
  `apps/web/app/(platform-admin)/admin/tenants/[id]/page.tsx`
- **effort:** low
- **brief:**
  1. `plan-catalog.constants.ts`: append `"flag.sales_agents"` to `FLAG_KEYS` (after
     `"flag.msrp"`), `"SALES_AGENTS"` to `ADDON_SKUS` (after `"MSRP"`),
     `"flag.sales_agents": "SALES_AGENTS"` to `FLAG_TO_ADDON_SKU`, and
     `sales_agents: "SALES_AGENTS"` to `LEGACY_ADDON_KEY_TO_SKU`.
  2. `publish-plan-catalog-v10.ts`: clone v9's script; change the marker checks
     (`alreadyPublished` / `isOurDraft`) from `"MSRP"` to `"SALES_AGENTS"`; keep
     `DEFINITIONS` byte-identical (no plan grants the flag — OFF for everyone including
     Enterprise, mirroring how v9 excludes `flag.msrp` in `ENTERPRISE_FLAGS`); append one
     seed to `ADDON_SEEDS`:
     ```ts
     {
       sku: "SALES_AGENTS",
       name: "Sales agents & commissions",
       monthlyPrice: 0,
       unit: "FLAT",
       includedAtPlan: null,
       meteredKey: null,
       capacityPerUnit: null,
       stackable: false,
       grantsFlags: ["flag.sales_agents"],
       sortOrder: 9,
     },
     ```
     Also carry forward the MSRP seed v9 added (the self-check requires every
     `ADDON_SKUS` code to have a seed row).
  3. `apps/api/package.json`: add
     `"db:publish:catalog:v10": "ts-node -r tsconfig-paths/register prisma/publish-plan-catalog-v10.ts",`
     directly under the `:v9` entry (line ~26). Do not touch the unsuffixed alias.
  4. `AVAILABLE_ADDONS` (admin tenants page, after the `msrp` entry ~L138):
     ```ts
     {
       key: "sales_agents",
       name: "Sales agents & commissions",
       description:
         "Agent records, customer attribution, commission accrual on invoices, statements and payouts",
     },
     ```

### WP3 — Commission engine core (new files + module + registration)

- **files:** `apps/api/src/sales-agents/commission-math.ts`,
  `apps/api/src/sales-agents/commission-math.spec.ts`,
  `apps/api/src/sales-agents/commission-engine.service.ts`,
  `apps/api/src/sales-agents/commission-engine.service.spec.ts`,
  `apps/api/src/sales-agents/commission-reconciliation.service.ts`,
  `apps/api/src/sales-agents/commissions.module.ts`, `apps/api/src/app.module.ts`
- **brief:** the pure math lives in `commission-math.ts` (pricing.spec.ts style — no
  Nest, no mocks); the orchestration in `CommissionEngineService`. Public surface
  (pin these signatures — WP4/WP5 compile against them):

  ```ts
  // commission-engine.service.ts
  @Injectable()
  export class CommissionEngineService {
    // Derive-from-current-state sync for one invoice. Idempotent: unchanged state
    // writes nothing. `db` = a tenantTransaction tx or forTenant() client; when
    // omitted, opens its own tenantTransaction.
    async syncInvoiceCommission(invoiceId: string, db?: any): Promise<void>;
    // Hook-safe wrapper: catches EVERYTHING, logs loudly, never throws — a commission
    // bug must never block an invoice or payment write. Cron heals missed syncs.
    async syncInvoiceCommissionSafe(invoiceId: string, db?: any): Promise<void>;
    // All non-DRAFT invoices of one order (per-order override changes, order edits).
    async syncOrderInvoices(orderId: string, db?: any): Promise<void>;
    // Pre-delete: throws ConflictException if any accrual has claimedAmount > 0;
    // otherwise deletes the invoice's accrual rows (+ their unclaimed adjustments).
    async removeInvoiceCommission(invoiceId: string, db: any): Promise<void>;
    // Backdated rate/assignment sweep. Enumerates candidate invoices (see below) and
    // syncs each in its OWN sequential tenantTransaction (crash-resumable), then
    // audit-logs { action: "commission.recompute", meta: { scope, fromDate, count } }.
    async recomputeCommissionRange(
      scope: { agentId?: string; customerId?: string },
      fromDate: Date,
    ): Promise<{ invoicesSynced: number }>;
  }
  ```

  **`syncInvoiceCommission` algorithm (exact):**
  1. `tenantId = this.prisma.getTenantId()`; if null or
     `!(await this.entitlements.hasFlag(tenantId, "flag.sales_agents"))` → return.
  2. Load (via `db`): invoice with `payments` (id, amount, method, status),
     `order: { select: { orderDate: true, commissionRatePct: true, orderTemplate:
{ select: { createdAt: true } } } }`, `recurringInvoice: { select: { createdAt:
true } }`, plus existing `commissionAccruals` with their `adjustments`. Invoice
     gone → return (removal path owns deletes).
  3. `basisDate = order?.orderDate ?? invoice.issueDate`. Resolve assignment covering
     basisDate; resolve rate per precedence (order override incl. `0` → customer rate →
     agent rate → NONE).
  4. Compute `issued = status !== DRAFT && status !== VOID`. Targets: for the resolved
     agent (if any, and issued): base/accrued/payable per the formulas; for every OTHER
     agent holding an accrual row on this invoice: target zero (payable 0, status VOID).
  5. Creation gates (only when NO row exists yet for the resolved agent): skip creation
     if agent is PAUSED, or fails the STOPPED_FOR_NEW grandfathering check, or agent is
     soft-deleted, or !issued. Existing rows are ALWAYS re-synced (pause defers new
     accruals; it never freezes existing ones).
  6. Upsert rows to their targets (`roundMoney` every write; skip the write when nothing
     changed — idempotency). Refresh `status` (PENDING/PARTIAL/PAYABLE/SETTLED/VOID
     derivation: VOID if target 0 with no claims; SETTLED if `|drift| ≤ ε ∧ ratio = 1 ∧
claimedAmount > 0`; PAYABLE if ratio = 1; PARTIAL if 0 < ratio < 1; else PENDING).
     A zero-target row with `claimedAmount = 0 ∧ adjustments = []` is DELETED, not kept.
  7. Drift rule: `drift = payable − claimedAmount − Σadjustments`; if `drift < −ε` →
     `create CommissionAdjustment({ accrualId, agentId, kind, amount: roundMoney(drift),
reason })` with kind = CLAWBACK (invoice void/credit/payment reversal),
     REASSIGNMENT (agent changed), RATE_CHANGE (rate changed), else MANUAL never
     auto-emitted. One emission per sync by construction.
  8. Steps 2–7 run inside ONE transaction (the caller's `db`, else its own).

  **`recomputeCommissionRange` candidate query:** invoices (non-DRAFT) of customers that
  have ANY `AgentAssignment` for `scope.agentId` (or `customerId = scope.customerId`),
  where `issueDate ≥ fromDate` OR `order.orderDate ≥ fromDate`; sync each sequentially.

  **`CommissionReconciliationService`:** `@Cron("30 * * * *")` (minute 30 — the existing
  hourly jobs fire at :00, orders.service.ts:1366 / billing-cron). Copy the multi-tenant
  cron shape from `recurring-invoices.service.ts:227-260` EXACTLY: fetch
  `tenant.findMany({ where: { status: "ACTIVE" }, select: { id: true } })`, per tenant
  `await this.tenantCtx.run(tenant.id, async () => {...})`; inside: skip unless
  `hasFlag`; `invoice.findMany({ where: { status: { not: "DRAFT" }, updatedAt: { gte:
new Date(Date.now() - 25 * 3600_000) } }, select: { id: true } })` via `forTenant()`;
  `syncInvoiceCommissionSafe(id)` each. Idempotency makes the 25h/1h overlap harmless.
  Constructor: `PrismaService`, `TenantContextService`, `EntitlementsService`,
  `CommissionEngineService`.

  **`commissions.module.ts`:**

  ```ts
  @Module({
    imports: [PrismaModule, EntitlementsModule],
    providers: [CommissionEngineService, CommissionReconciliationService],
    exports: [CommissionEngineService],
  })
  export class CommissionsModule {}
  ```

  Register `CommissionsModule` in `app.module.ts` imports with a banner comment
  `// ─── Sales agents & commissions (flag.sales_agents) ───` after `RegulatedModule`'s
  group (~L167).

  **Specs:** `commission-math.spec.ts` — base (tax/shipping excluded; credit pro-rating
  $54-on-$108→$50; clamp ≥0; one-round), ratio (snap at ε; credit-only invoice → 1;
  bounced check void → drops; DRAFT payments ignored), rate precedence (0-override
  exempt beats customer rate; future-dated rows excluded; NONE), grandfathering (all
  four quadrants as a pure predicate). `commission-engine.service.spec.ts`
  (createMockPrisma + `{ hasFlag: jest.fn() }`) — flag OFF writes nothing; idempotent
  re-run (second sync performs zero writes); reassignment zero-targets the old agent;
  drift emits exactly one adjustment and re-run emits none; removeInvoiceCommission
  throws on claimedAmount > 0.

- **exact code — `commission-math.ts`:**

  ```ts
  import { roundMoney } from "../common/pricing";

  /** Sub-cent tolerance for paid/complete comparisons. */
  export const COMMISSION_EPS = 0.005;

  export interface InvoiceMoneyState {
    subtotal: number;
    discount: number;
    total: number;
    /** Σ InvoicePayment.amount, status PAID, method !== CREDIT_NOTE. */
    cashCollected: number;
    /** Σ InvoicePayment.amount, status PAID, method === CREDIT_NOTE. */
    creditApplied: number;
  }

  /**
   * Owner decision: base = goods subtotal after discounts, excluding tax and shipping.
   * Credit notes reduce the base by their PRE-TAX share (a credit is applied against
   * the tax-inclusive total, so scale it back to goods terms before subtracting).
   */
  export function commissionBase(s: InvoiceMoneyState): number {
    const goods = Math.max(0, s.subtotal - s.discount);
    const creditPrincipal =
      s.total > COMMISSION_EPS ? roundMoney(s.creditApplied * (goods / s.total)) : 0;
    return roundMoney(Math.max(0, goods - creditPrincipal));
  }

  /**
   * Fraction of the still-collectible cash that has actually landed. Credit-note
   * applications are excluded from BOTH sides: they already shrank the base, so
   * counting them as collection would release commission on money never received.
   */
  export function collectionRatio(s: InvoiceMoneyState): number {
    const collectible = roundMoney(s.total - s.creditApplied);
    if (collectible <= COMMISSION_EPS) return 1;
    if (collectible - s.cashCollected <= COMMISSION_EPS) return 1; // full-payment snap
    return Math.max(0, Math.min(1, s.cashCollected / collectible));
  }

  export type RateSource = "ORDER_OVERRIDE" | "CUSTOMER_RATE" | "AGENT_DEFAULT" | "NONE";

  export interface RateRow {
    ratePct: number;
    effectiveFrom: Date;
  }

  /**
   * Precedence: per-order override (0 IS a value — "exempt") -> newest customer rate
   * effective on basisDate -> newest agent rate effective on basisDate -> NONE.
   */
  export function resolveRate(
    orderOverridePct: number | null | undefined,
    customerRates: RateRow[],
    agentRates: RateRow[],
    basisDate: Date,
  ): { ratePct: number; source: RateSource } {
    if (orderOverridePct != null)
      return { ratePct: Number(orderOverridePct), source: "ORDER_OVERRIDE" };
    const pick = (rows: RateRow[]) =>
      rows
        .filter((r) => r.effectiveFrom.getTime() <= basisDate.getTime())
        .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];
    const c = pick(customerRates);
    if (c) return { ratePct: Number(c.ratePct), source: "CUSTOMER_RATE" };
    const a = pick(agentRates);
    if (a) return { ratePct: Number(a.ratePct), source: "AGENT_DEFAULT" };
    return { ratePct: 0, source: "NONE" };
  }

  /** STOPPED_FOR_NEW: new business stops, pre-stop recurring relationships keep earning. */
  export function passesGrandfathering(args: {
    stopNewBusinessAt: Date | null;
    basisDate: Date;
    orderTemplateCreatedAt: Date | null;
    recurringInvoiceCreatedAt: Date | null;
  }): boolean {
    const stop = args.stopNewBusinessAt;
    if (!stop || args.basisDate.getTime() < stop.getTime()) return true;
    return (
      (args.orderTemplateCreatedAt != null &&
        args.orderTemplateCreatedAt.getTime() < stop.getTime()) ||
      (args.recurringInvoiceCreatedAt != null &&
        args.recurringInvoiceCreatedAt.getTime() < stop.getTime())
    );
  }

  export const accruedCommission = (base: number, ratePct: number): number =>
    roundMoney((base * ratePct) / 100);

  export const payableCommission = (accrued: number, ratio: number): number =>
    roundMoney(accrued * ratio);
  ```

### WP4 — Hooks into the invoice / credit-note / order / customer lifecycle

- **files:** `apps/api/src/invoices/invoices.service.ts`,
  `apps/api/src/invoices/invoices.module.ts`, `apps/api/src/invoices/invoices.service.spec.ts`,
  `apps/api/src/credit-notes/credit-notes.service.ts`, `apps/api/src/credit-notes/credit-notes.module.ts`,
  `apps/api/src/orders/orders.service.ts`, `apps/api/src/orders/orders.controller.ts`,
  `apps/api/src/orders/orders.module.ts`, `apps/api/src/orders/dto/create-order.dto.ts`,
  `apps/api/src/orders/orders.service.spec.ts`,
  `apps/api/src/customers/customers.service.ts`, `apps/api/src/customers/dto/create-customer.dto.ts`,
  `apps/api/src/customers/customers.module.ts`, `apps/api/src/customers/customers.service.spec.ts`,
  `apps/api/src/customers/customers.security.spec.ts`, `apps/api/src/customers/portal-approvals.spec.ts`,
  `apps/api/src/credit-notes/credit-notes.service.spec.ts` (if it exists — grep first)
- **brief:** inject `CommissionEngineService` into `InvoicesService`,
  `CreditNotesService`, `OrdersService` (NOT CustomersService — its change is a plain
  tx insert). Import `CommissionsModule` in the three module files. Every hook is ONE
  line: `await this.commissionEngine.syncInvoiceCommissionSafe(<invoiceId>, <tx>);`.

  **Hook sites in `invoices.service.ts`** (anchors post-PR-B; find by method name):

  | Method (decl. line)                    | Where the hook goes                                                                                                                                                                                                                                                                                                                                                 |
  | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `send` (2578)                          | inside the Serializable tx, ~L2629 right before `return { updated, auto };`                                                                                                                                                                                                                                                                                         |
  | `sendEmail` (2663)                     | its own twin tx block, ~L2799 before `return { updated, auto };`                                                                                                                                                                                                                                                                                                    |
  | `voidInvoiceInTx` (2987)               | ~L2993 after `reverseInvoiceEntries`, before `return voided;` — covers both `voidInvoice` and every in-tx caller                                                                                                                                                                                                                                                    |
  | `revertInvoiceToDraft` (3084)          | **currently NOT in a tx** — wrap the existing guard + `invoice.update` (~L3101) in ONE `tenantTransaction` and hook inside it                                                                                                                                                                                                                                       |
  | `reopenInvoice` (3174)                 | **currently NOT in a tx** — same wrap around ~L3180 (PAID→DRAFT is the nastiest clawback path; if claimed, sync emits the negative adjustment)                                                                                                                                                                                                                      |
  | `writeOff` (3881)                      | **currently NOT in a tx** — same wrap around ~L3892 (materially a no-op for money — payable derives from payments — but refreshes accrual display status)                                                                                                                                                                                                           |
  | `recordPayment` (3463)                 | ~L3544 before `return { ...paid, createdPaymentId }`                                                                                                                                                                                                                                                                                                                |
  | `recordDeliveryPaymentInTx` (3573)     | **per-invoice inside** the `for (const inv of invoices)` loop, after the `tx.invoice.update` ~L3696-3703                                                                                                                                                                                                                                                            |
  | `updatePayment` (3731)                 | ~L3798 before `return updated;`                                                                                                                                                                                                                                                                                                                                     |
  | `deletePayment` (3802)                 | ~L3866 before `return updated;` (inside the tx — storage cleanup stays outside)                                                                                                                                                                                                                                                                                     |
  | `voidPayment` (4075)                   | ~L4137 before `return { success: true };`                                                                                                                                                                                                                                                                                                                           |
  | `setCheckStatus` (4156)                | ONLY the BOUNCED branch, right after the invoice update ~L4265-4272. The DEPOSITED/CLEARED early-return (~L4207) changes no balances — no hook                                                                                                                                                                                                                      |
  | `applyPriceAdjustment` (4384)          | inside the `applyToInvoice` closure right after the `invoice.update` ~L4458-4466, per `inv.id`, passing NO tx (the method is pre-existingly non-atomic — do NOT refactor it here; the Safe wrapper + hourly cron cover the gap; leave a one-line comment saying exactly that)                                                                                       |
  | `rebuildSiblingDrafts` (1270, private) | **the real order-edit resync site**: inside the `for (const pd of perDraft)` loop after the `db.invoice.update` ~L1384-1398 (after `resyncInvoiceLedger` ~L1401), gated `if (nextStatus !== InvoiceStatus.DRAFT)` — this is what fires when an order edit rewrites the money of an already-issued invoice via `resyncOrderInvoicesForEdit` (`preserveStatus: true`) |
  | `deleteInvoice` (3909)                 | `await this.commissionEngine.removeInvoiceCommission(id, tx);` ~L3953 before the return — throws 409 when claimed commission exists (note: this method deletes zero-payment SENT invoices too, so removal MUST be guarded)                                                                                                                                          |

  Deliberate NON-sites (all verified DRAFT-only or no-balance-change — do not hook):
  `create` (born DRAFT; `dto.send` triggers the separate `send()`), `update`
  (DRAFT-guarded at L2315), `unvoidInvoice` (VOID→DRAFT), `reconcileOrderDraftInvoice`,
  `createSplitInvoices`, `createPartialFromOrder`, `duplicate`, and
  `estimates.service.ts convertToInvoice` (writes a DRAFT directly — verified L255-259;
  **estimates files are untouched by this PR**).

  **Hook sites in `credit-notes.service.ts`** (money only ever moves through these two):

  | Method                                        | Where                                                                                                                                                                          |
  | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | `applyCreditInTx` (367, private)              | right before `return { applied: applyAmount, invoiceStatus: newStatus };` ~L443, on `inv.id` — covers `applyToInvoice`, `autoApplyOldestCreditsInTx`, `settleOrderCreditsInTx` |
  | `restoreCreditFromPaymentInTx` (608, private) | right after the `tx.invoice.update` ~L662-668, on `payment.invoiceId` — covers `releaseCreditsInTx` wrappers, `unapplyFromInvoice`, order-credit settlement                    |

  `create` and `voidCreditNote` never touch Invoice/InvoicePayment — no hooks.

  **`orders.service.ts`:**
  1. `deleteOrder` (4165): inside its tx (~L4190), the loop over `order.invoices`
     (~L4192-4200) hard-deletes invoices WITHOUT going through `deleteInvoice` — add
     `await this.commissionEngine.removeInvoiceCommission(inv.id, tx);` per invoice
     before `tx.invoice.delete`. (This is a real bypass found in recon; without it,
     order-cascade deletes strand or silently destroy accruals.)
  2. Persist `commissionRatePct` on order create: `CreateOrderDto` gains
     `@IsOptional() @IsNumber() @Min(0) @Max(100) commissionRatePct?: number;` — gate it
     exactly like `parseOrderDate` (orders.service.ts:1381-1410): if present and role is
     not OPERATOR/TENANT_ADMIN → `ForbiddenException("Only staff can set a commission
rate")`. Wire it in BOTH creation paths (the `parseOrderDate` call sites, ~L1416
     and ~L1976 — grep `parseOrderDate(` to find them).
  3. New endpoint in `orders.controller.ts`:
     `PATCH /orders/:id/commission-rate` → `@Roles(OPERATOR)` (follow the controller's
     existing role import; TENANT_ADMIN passes RolesGuard the same way it does for other
     operator routes) with body `{ commissionRatePct: number | null }` (same validation;
     null clears). Service method `setCommissionRate(orderId, ratePct, user)`: staff
     gate → `tenantTransaction`: update order, then
     `await this.commissionEngine.syncOrderInvoices(orderId, tx);`. Do NOT touch
     `updateOrderItems` for this — the `rebuildSiblingDrafts` hook already covers
     item-edit money changes.

  **`customers.service.ts` `create()` (397):** `CreateCustomerDto` gains
  `@IsOptional() @IsUUID() salesAgentId?: string;`. Inside the existing
  `tenantTransaction` (L418-451), after `tx.customer.create` (~L429), add:

  ```ts
  if (dto.salesAgentId) {
    const agent = await tx.salesAgent.findFirst({
      where: { id: dto.salesAgentId, deletedAt: null },
      select: { id: true },
    });
    if (!agent) throw new BadRequestException("Unknown sales agent");
    await tx.agentAssignment.create({
      data: { customerId: customer.id, agentId: agent.id, effectiveFrom: new Date() },
    });
  }
  ```

  (No entitlement check here: writing an assignment for an un-flagged tenant is inert —
  the engine never reads it while the flag is off — and the field is only surfaced in
  UI in PR-D. No engine injection into CustomersService.)

  **Spec upkeep (build breaks without this):** every TestingModule that constructs
  `InvoicesService` / `CreditNotesService` / `OrdersService` needs
  `{ provide: CommissionEngineService, useValue: mockCommissionEngine }` where
  `mockCommissionEngine = { syncInvoiceCommissionSafe: jest.fn(), syncOrderInvoices:
jest.fn(), removeInvoiceCommission: jest.fn() }`. Grep
  `Test.createTestingModule` across `apps/api/src/{invoices,credit-notes,orders}` plus
  the customers spec files listed above (customers specs need only the DTO change to
  keep compiling — no provider). Add one behavioral assertion to
  `invoices.service.spec.ts`: `send()` calls `syncInvoiceCommissionSafe` once with the
  invoice id.

### WP5 — Agents + statements API (controllers/services/DTOs + numbering)

- **files:** `apps/api/src/sales-agents/sales-agents.controller.ts`,
  `apps/api/src/sales-agents/sales-agents.service.ts`,
  `apps/api/src/sales-agents/commission-statements.controller.ts`,
  `apps/api/src/sales-agents/commission-statements.service.ts`,
  `apps/api/src/sales-agents/commission-statements.service.spec.ts`,
  `apps/api/src/sales-agents/sales-agents.service.spec.ts`,
  `apps/api/src/sales-agents/dto/sales-agent.dto.ts`,
  `apps/api/src/sales-agents/dto/commission-statement.dto.ts`,
  `apps/api/src/sales-agents/commissions.module.ts` (add controllers + services to the
  WP3 module — the ONLY shared file, WP5 runs after WP3)
- **brief:** both controllers gated at CLASS level:
  `@UseGuards(JwtAuthGuard, RolesGuard, PlanFlagGuard)` + `@Roles(UserRole.OPERATOR)` +
  `@RequirePlanFlag("flag.sales_agents")` (guard reads class metadata — verified).
  DTO style: one-line class-validator fields (create-customer.dto.ts is the template).
  All money via `roundMoney`; all rates validated `@Min(0) @Max(100)`.

  **`SalesAgentsController` (`@Controller("sales-agents")`) → `SalesAgentsService`:**
  - `GET /` list (query: `status?`, `search?`, `includeDeleted?` default false) —
    include current open-assignment count + latest default rate per agent.
  - `POST /` create `{ name, email?, phone?, notes?, defaultRatePct?, rateEffectiveFrom? }`
    → creates agent + (if rate given) first `SalesAgentRate`
    (`effectiveFrom = rateEffectiveFrom ?? now`).
  - `GET /:id` detail (agent + rates history + open assignments + accrual totals).
  - `PATCH /:id` contact fields only.
  - `PATCH /:id/status` `{ status, stopNewBusinessAt? }` — entering STOPPED_FOR_NEW sets
    `stopNewBusinessAt` (default now); leaving clears it; every transition audit-logged
    via `AuditService.log({ action: "salesAgent.status", ... })`.
  - `DELETE /:id` soft-delete; 409 if any accrual `claimedAmount > 0` with unconverged
    drift or any non-PAID statement exists.
  - `POST /:id/rates` `{ ratePct, effectiveFrom }` — insert-only; if
    `effectiveFrom < now` → after insert, run
    `recomputeCommissionRange({ agentId }, effectiveFrom)` and return
    `{ rate, recompute: { invoicesSynced } }`.
  - `DELETE /:id/rates/:rateId` — only rows with `effectiveFrom > now` (future); past
    rows are history, insert a correcting row instead (400 explains this).
  - `POST /:id/customer-rates` `{ customerId, ratePct, effectiveFrom }` — same backdate
    → recompute (`{ customerId }` scope) behavior.
  - `POST /:id/assignments` `{ customerId, effectiveFrom? }` — in one tx: close the
    customer's open assignment row (`effectiveTo = effectiveFrom`), insert the new one
    (the partial unique index backstops races); backdated `effectiveFrom` → recompute
    (`{ customerId }`, from effectiveFrom).
  - `POST /:id/assignments/bulk` `{ customerIds: string[], effectiveFrom? }`
    (`@ArrayMaxSize(500)`) — same, per customer; the uniform path for imports and
    existing books of business.
  - `POST /assignments/close` `{ customerId, effectiveTo? }` — end attribution (house
    account from `effectiveTo ?? now`).
  - `GET /:id/accruals` — the ledger (query `status?`, `from?`, `to?` on basisDate,
    paginated) incl. per-row drift so the UI can show "unclaimed".
  - `POST /:id/recompute` `{ fromDate }` — manual sweep, returns `{ invoicesSynced }`.

  **`CommissionStatementsController` (`@Controller("commission-statements")`):**
  - `GET /` list (query `agentId?`, `status?`).
  - `POST /generate` `{ agentId, periodFrom?, periodTo? }` — 409 if a PENDING statement
    exists for the agent. In ONE Serializable `tenantTransaction`: pick accruals of the
    agent with `drift > ε` (period filter on basisDate when given) → CLAIM lines
    (`amount = drift`, bump `claimedAmount`); sweep unclaimed adjustments → ADJUSTMENT
    lines; sweep prior non-VOID statements whose `totalAmount − paidAmount < −ε` and are
    not yet carried → CARRYFORWARD lines; `totalAmount = roundMoney(Σ lines)`;
    `statementNumber` from the max+1 scan pattern (copy `generateInvoiceNumber`,
    invoices.service.ts:2090-2100, prefix `CST-${year}-`, backstop
    `@@unique([tenantId, statementNumber])`). Empty statement (no lines) → 400.
  - `GET /:id` detail with lines (join accrual → invoiceNumber for display).
  - `POST /:id/approve` — Serializable tx: for every CLAIM line recompute live drift as
    of now (`payable − (claimedAmount − line.amount) − adjTotal`); if any
    `|expected − line.amount| > ε` → 409 `"Statement is stale — regenerate"`; else
    status APPROVED + `approvedAt`, refresh accrual statuses (SETTLED where converged).
  - `POST /:id/void` — PENDING only: delete lines, decrement `claimedAmount`, releasing
    swept adjustments/carryforwards (unique refs free on delete); status VOID.
  - `POST /:id/payouts` `{ amount, method, reference?, notes?, paidAt? }` — APPROVED
    only; `totalAmount > 0` required; in one tx re-derive
    `alreadyPaid = Σ payout rows` (never trust `paidAmount`), reject
    `amount > totalAmount − alreadyPaid + ε`; find-or-create the tenant's
    `ExpenseCategory` `code: "COMMISSIONS_AND_FEES"` (create with
    `{ name: "Commissions and Fees", code: "COMMISSIONS_AND_FEES", isCustom: false }` on
    miss — unique `[tenantId, code]` backstops); create the `Expense`
    (`{ categoryId, amount, date: paidAt ?? now, paymentMethod: method, status: "PAID",
paidAt, description: "Commission payout <CST-...> — <agent name>" }`), create the
    `CommissionPayout` with `expenseId`, update `paidAmount`/status
    (`PAID` when `Σ ≥ total − ε`). Partial payouts are the normal case.
  - `GET /:id/payouts` list.

  **Specs:** statements spec (mock prisma) — generate claims drift only; double-generate
  409s; approve 409s after a mid-flight clawback (simulate by changing the accrual
  between generate and approve); void releases sweeps; payout over cap rejected; payout
  creates the linked Expense and flips to PAID at the cap; negative statement blocks
  payouts and is swept by the next generation exactly once. Agents spec — status
  transitions set/clear `stopNewBusinessAt`; future-only rate delete; backdated rate
  triggers recompute (assert the engine method was called with the right scope/date).

## Out of scope (PR-D — do not build any of this now)

Web UI (nav entries, `sales-agents/*` pages, `finance/commissions/*` pages, agent select
in CustomerFormModal, per-order override input in CreateOrderModal), statement PDF/CSV
export, `GET /bookkeeping/reports/commissions-by-agent` (mirror of `getSalesByDriver`,
bookkeeping.service.ts:1798), mobile read-only agent row, `feature-smoke.mjs` section,
Playwright e2e, `useHasAddon` client constants. PR-C ships the engine dark.

## Acceptance criteria

1. Migration `20260901000000_add_sales_agents_commissions` creates the 6 enums, 9
   models, `Order.commissionRatePct`, and the `AgentAssignment_open_assignment_key`
   partial unique index; the FULL migration chain (including PR-B's `20260831000000`)
   replays clean on a scratch DB.
2. `flag.sales_agents` / `"SALES_AGENTS"` appended to `FLAG_KEYS` / `ADDON_SKUS` with
   both map entries; `publish-plan-catalog-v10.ts` is idempotent (marker
   `"SALES_AGENTS"`), keeps plan definitions byte-identical, grants the flag through the
   addon only (NO plan grants it); `db:publish:catalog:v10` script exists; the
   `sales_agents` entry is in `AVAILABLE_ADDONS`.
3. Flag OFF ⇒ `syncInvoiceCommission*` returns before any read/write of commission
   tables, every `/sales-agents` and `/commission-statements` route 403s with the
   PLAN_GATE body, and the entire pre-existing api test suite passes unchanged.
4. `send`/`sendEmail` on an attributed customer's invoice creates ONE accrual
   (`@@unique([tenantId, invoiceId, agentId])` enforced): `accrued = roundMoney(max(0,
subtotal − discount) × rate/100)`, `payable = 0`; tax and shipping never enter;
   commission is computed once per document, never per line.
5. Rate precedence: order override (including `0` = exempt) → newest customer rate with
   `effectiveFrom ≤ basisDate` → newest agent rate → NONE (zero-amount row with
   `rateSource: NONE`). `basisDate = order.orderDate ?? invoice.issueDate`; the agent is
   whoever held the customer on basisDate per assignment history.
6. Payments: only `status: PAID` `InvoicePayment` rows count; `method: CREDIT_NOTE`
   rows reduce the base (pre-tax pro-rating) and are excluded from cash; payable
   releases pro-rata with a full-payment snap at ε = 0.005; `recordPayment`,
   `recordDeliveryPaymentInTx` (per invoice in its loop), `updatePayment`,
   `deletePayment`, `voidPayment`, and `setCheckStatus` (BOUNCED only) all resync.
7. Void invoice → target zero; if claimed, exactly ONE compensating CLAWBACK adjustment
   (re-running sync emits no duplicate). `unvoid` leaves commission at zero until a
   future `send`.
8. `revertInvoiceToDraft`, `reopenInvoice`, and `writeOff` are each wrapped in a
   `tenantTransaction` together with their status write and hook. WRITTEN_OFF releases
   nothing beyond cash already collected.
9. Order edits that rebuild issued invoices resync via the `rebuildSiblingDrafts` hook
   (gated `nextStatus !== DRAFT`); `deleteInvoice` AND `OrdersService.deleteOrder`'s
   invoice-cascade call `removeInvoiceCommission`, which 409s when `claimedAmount > 0`
   and otherwise removes the rows.
10. Idempotency: calling `syncInvoiceCommission` twice with unchanged state performs
    zero writes the second time (spec-asserted).
11. Backdated rate/assignment changes trigger `recomputeCommissionRange`: unclaimed
    accruals are recomputed in place; claimed ones converge via a single adjustment;
    the sweep is audit-logged with the affected-invoice count.
12. Grandfathering: with `stopNewBusinessAt` set, accruals are created for
    `basisDate ≥ stop` ONLY when the order's template or the invoice's recurring
    template predates the stop (all four quadrants spec-covered). PAUSED blocks new
    accrual creation, existing accruals keep releasing, and post-resume syncs backfill
    (defer-not-forfeit — documented default).
13. Statements: one PENDING per agent; CLAIM lines equal drift; unclaimed adjustments
    and prior negative residuals are swept exactly once (unique refs); approve
    re-validates and 409s on staleness; void (PENDING only) releases everything;
    payouts are capped by ledger-derived remaining, create a linked
    `COMMISSIONS_AND_FEES` Expense (visible in P&L with zero bookkeeping-code changes),
    and flip the statement to PAID at the cap; negative statements block payouts.
14. `CreateCustomerDto.salesAgentId` opens an assignment inside the existing create tx;
    `CreateOrderDto.commissionRatePct` and `PATCH /orders/:id/commission-rate` are
    staff-gated exactly like `parseOrderDate`.
15. The hourly reconciliation cron fires at minute 30, iterates ACTIVE tenants inside
    `tenantCtx.run`, skips unflagged tenants, and re-syncs invoices updated in the last
    25h via the Safe wrapper (which never throws).
16. `npm run check-types`, `npm run lint`, `npm run test` all green; every touched
    service's existing spec files compile with the new mock provider.

## Verification commands

Run from the repo root:

- `npm run check-types`
- `npm run lint`
- `npm run test`

Migration replay check (NEVER against the working dev DB):
`docker exec routeflow_postgres psql -U user -d postgres -c "CREATE DATABASE commissions_check;"`
then from `apps/api` with `DATABASE_URL` pointed at `/commissions_check`:
`npx prisma migrate deploy`, then drop the database. (Prisma 7 ignores `.env` when
`prisma.config.ts` exists — export `DATABASE_URL` inline.)

## Risks & rollback

- **Blast radius of WP4** is the real risk: ~16 one-line hooks across the money paths.
  Mitigations are structural — the Safe wrapper never throws into a payment tx, hooks
  are one-liners at verified anchors, and the hourly cron self-heals anything missed.
  Reviewers should diff-walk every hook against the WP4 table and check no hook landed
  inside a loop it shouldn't repeat in (recordDeliveryPaymentInTx is per-invoice BY
  DESIGN).
- **Serializable transactions** (`generate`/`approve`) can throw P2034 serialization
  failures under contention — acceptable v1 (client retries); same posture as `send`.
- **Adding a constructor dependency to three high-traffic services breaks every
  TestingModule that builds them** — WP4's spec-upkeep list is load-bearing; the gate
  will catch any missed file.
- **`applyPriceAdjustment` remains non-atomic** (pre-existing). The hook rides along
  un-tx'd; the cron heals. Do not refactor that method in this PR.
- **Backfill**: enabling the flag for a tenant with existing history creates NO
  retroactive accruals until assignments/rates are entered; entering backdated ones
  triggers recompute — that IS the onboarding path (bulk-assign + backdated rate), no
  separate backfill script needed. Document this in the PR description.
- **Rollback**: everything is flag-gated and schema-additive. Reverting the code leaves
  inert tables; disabling the addon per tenant stops all engine activity instantly
  (30s entitlements cache). The migration needs no down-path (additive only).
