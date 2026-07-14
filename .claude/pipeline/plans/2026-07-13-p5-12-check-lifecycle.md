## Status

PLANNED — 2026-07-13

## Context

**P5-12 "Check lifecycle (Recorded→Deposited→Cleared→Bounced)" [money] — api + web only** (mobile is the P10 wave, out of scope).

**CRITICAL DESIGN CORRECTION (verified against source):** the design-package doc says to put `checkStatus/depositedAt/clearedAt/bouncedAt/nsfFeeAmount` on `Payment`. **That is wrong — `Payment`→`Transaction` is dead code**: nothing in the repo ever creates a `Payment` row and `Transaction.totalPaid` stays 0 forever. The LIVE AR system is **`InvoicePayment`→`Invoice`** (`apps/api/prisma/schema.prisma:1764-1790`). ALL new fields go on **`InvoicePayment`**.

Verified facts this plan builds on (all re-read from source 2026-07-13, HEAD `7cb9f5d`):

- `InvoicePayment` has `amount Decimal(10,2), method PaymentMethod, status PaymentStatus @default(PAID), paymentNumber? @unique, bankCharges?, paymentGroupId?, tenantId?`. `enum PaymentStatus { DRAFT PAID VOID }` (schema:142), `enum PaymentMethod` includes `CHECK` (schema:132).
- **Balance is never stored** — everywhere computed as `Number(invoice.total) − Σ(non-VOID InvoicePayment.amount)`, with `Invoice.total`/`Invoice.subtotal` as STORED columns.
- Central status engine `InvoicesService.recomputeStatus(totalPaid, total, dueDate, currentStatus)` at `apps/api/src/invoices/invoices.service.ts:82-101` (DRAFT/VOID/WRITTEN_OFF terminal; ≥total−0.001→PAID; >0→PARTIAL; past due→OVERDUE; else SENT).
- The NSF primitive already exists: `voidPayment(invoiceId, paymentId)` (invoices.service.ts:2461-2507) sets `status=VOID`, re-sums non-VOID payments, `recomputeStatus`, `invoice.update{status,paidAt}`, `emitInvoiceUpdated`. **BOUNCED is modeled on this exact pattern**, inside one `tenantTransaction` (auto-injects `tenantId` on creates — prisma.service.ts:28-51).
- Payment creation points: `recordPayment` (invoices.service.ts:2102, `invoicePayment.create` at 2145, `tx.paymentCounter.upsert` at 2138), `recordStandalonePayment` (2372, create at 2401), `BookkeepingService.recordPayment` (bookkeeping.service.ts:128, create at 148).
- `roundMoney` at `apps/api/src/common/pricing.ts:28`. Every money write is wrapped.
- **Invoice total invariant (verified):** `total = roundMoney(subtotal − invDiscount + shipping + Σ(item.subtotal × item.taxRate))` (invoices.service.ts:202-203). A non-taxable (`taxRate:0`) fee line of `fee` raises Σitem.subtotal by `fee` and tax by 0, so bumping STORED `subtotal += fee` and `total += fee` is exactly consistent.
- `findOne` (invoices.service.ts:1312-1362) returns `payments` (ALL, incl. VOID) + computes `paidAmount` over **all** payments — a pre-existing void-blindness this increment fixes (one-line filter): a bounced/voided check must not count as paid.
- `prisma-mock.ts`: `invoice`/`invoiceItem`/`invoicePayment` registered in BOTH `allModels()` (78-80) and `txModels()` (170-172); **`paymentCounter` is NOT registered** — must be added or the new recordPayment specs crash.
- Operator page `apps/web/app/(dashboard)/invoices/[id]/page.tsx`; buyer detail `apps/web/app/buyer/portal/[seller]/invoices/[id]/page.tsx` renders `invoice.payments` from `GET /buyer/invoices/:id` → `invoicesService.findOne(id)`. Live refresh: operator `useRealtimeUpdates.ts` already invalidates `["invoices"]` on `invoice.updated`; buyer side only pushes a notification (`useBuyerNotifications.ts`) — WP4 adds a query invalidation so the badge/balance goes live.
- **Out-of-scope / DO NOT TOUCH:** `routes.service.ts:1384-1408` (completeStop payment path reads a non-existent `Invoice.balance` — divergent legacy path). Do NOT add anything to `PaymentMethod`/`PaymentStatus`. No other money math beyond the fee line + subtotal/total bump.
- Buyer page's payment date reads `p.recordedAt`, a field the API never returns (rows carry `paidAt`/`createdAt`) — renders "N/A". WP4 fixes that field name in passing (only consumer, verified by grep).

**Orchestrator validation (2026-07-13):** InvoiceItem required fields are `invoiceId/description/qty/unitPrice/subtotal` (all supplied by the fee-line create); `discount/taxRate/priceType` default; `productId` nullable; `tenantId` auto-injected by tenantTransaction. Total invariant confirmed above. Money mechanics APPROVED.

**WP order:** WP1 → WP2 → (WP3 ∥ WP4) → WP5. Run `npx prisma generate` (from `apps/api`) after WP1 before compiling — `CheckStatus` comes from the generated client. `git add -f` the migration.

## Acceptance

1. Migration `20260724000000_add_check_lifecycle` applies cleanly (additive: 1 enum, 5 nullable columns, RECORDED backfill for existing non-VOID checks); `npx prisma generate` + `npm run check-types` pass.
2. Recording a payment with `method=CHECK` stamps `checkStatus=RECORDED`; non-check stays null. The check still counts as paid immediately (`status=PAID`).
3. `PATCH /invoices/:id/payments/:paymentId/check-status` (OPERATOR): RECORDED→DEPOSITED→CLEARED stamp `depositedAt`/`clearedAt`, keep `PaymentStatus=PAID`, change NO balance; any non-BOUNCED→BOUNCED sets `bouncedAt` + `nsfFeeAmount=roundMoney(fee)` and flips `status=VOID`, then re-sums non-VOID → `recomputeStatus` → invoice re-opens; fee>0 additionally creates a non-taxable NSF `InvoiceItem` line AND bumps stored `Invoice.subtotal`/`total` by `roundMoney(fee)` in the same transaction. Illegal jumps / non-CHECK / already-VOID → 400. Every path emits `emitInvoiceUpdated`.
4. Operator invoice detail: each CHECK payment row shows a lifecycle badge + a "Check ▾" control; Mark bounced opens a confirm modal with an optional NSF-fee input; voided/bounced payments render struck + excluded from Paid/Balance.
5. Buyer invoice detail: check-status badge per CHECK payment (Bounced = danger + struck amount); balance due excludes VOID payments so a bounce re-opens it; updates live on `invoice.updated`.
6. Jest: new `setCheckStatus` + record-stamp specs pass; `invoices.service.spec`, `bookkeeping.service.spec`, `routes.service.spec` still compile and pass.
7. `routes.service.ts` payment path, `PaymentMethod`, `PaymentStatus` untouched.

## Work Packages

### WP1 — Schema: `CheckStatus` enum + `InvoicePayment` columns + migration + prisma-mock

files:

- `apps/api/prisma/schema.prisma` (edit)
- `apps/api/prisma/migrations/20260724000000_add_check_lifecycle/migration.sql` (new)
- `apps/api/src/testing/prisma-mock.ts` (edit)

brief: Additive enum + 5 nullable columns on `InvoicePayment`; hand-written migration sorting after `20260723000000_add_stock_alerts`, with a safe RECORDED backfill; register `paymentCounter` in the prisma mock (`invoiceItem` already registered — confirm only). Run `npx prisma generate` from apps/api; `git add -f` the migration.sql.

**1. schema.prisma — after the `PaymentStatus` enum, add:**

```prisma
// P5-12: lifecycle of a CHECK InvoicePayment. Always null on non-check payments.
enum CheckStatus {
  RECORDED
  DEPOSITED
  CLEARED
  BOUNCED
}
```

**2. schema.prisma — in `model InvoicePayment`, after `status PaymentStatus @default(PAID)` add:**

```prisma
  // P5-12 check lifecycle — only ever set when method = CHECK. BOUNCED (NSF)
  // also flips `status` to VOID so every existing non-VOID paid-sum /
  // status:PAID aggregation excludes the bounced check automatically.
  checkStatus      CheckStatus?
  depositedAt      DateTime?
  clearedAt        DateTime?
  bouncedAt        DateTime?
  nsfFeeAmount     Decimal?      @db.Decimal(10, 2)
```

**3. NEW `apps/api/prisma/migrations/20260724000000_add_check_lifecycle/migration.sql`:**

```sql
-- P5-12: check lifecycle (Recorded → Deposited → Cleared → Bounced) on the LIVE
-- AR payment table (InvoicePayment — the Payment/Transaction tables are dead code).
-- Additive-only: one new enum + five nullable columns + a safe backfill that
-- stamps existing non-void CHECK payments as RECORDED. No amounts are touched.
CREATE TYPE "CheckStatus" AS ENUM ('RECORDED', 'DEPOSITED', 'CLEARED', 'BOUNCED');

ALTER TABLE "InvoicePayment" ADD COLUMN "checkStatus" "CheckStatus";
ALTER TABLE "InvoicePayment" ADD COLUMN "depositedAt" TIMESTAMP(3);
ALTER TABLE "InvoicePayment" ADD COLUMN "clearedAt" TIMESTAMP(3);
ALTER TABLE "InvoicePayment" ADD COLUMN "bouncedAt" TIMESTAMP(3);
ALTER TABLE "InvoicePayment" ADD COLUMN "nsfFeeAmount" DECIMAL(10,2);

-- Backfill: existing check payments enter the lifecycle at RECORDED. VOID checks
-- are left null — they were manually voided before the lifecycle existed and we
-- cannot know whether they bounced.
UPDATE "InvoicePayment"
SET "checkStatus" = 'RECORDED'
WHERE "method" = 'CHECK' AND "status" <> 'VOID';
```

**4. prisma-mock.ts — add `paymentCounter: modelProxy()` in BOTH `allModels()` and `txModels()`, right after `invoicePayment: modelProxy(),` (before `creditNote`).**

### WP2 — API: `setCheckStatus` + NSF void-reuse + endpoint/DTO + RECORDED-at-record + `findOne` void fix + specs

files:

- `apps/api/src/invoices/invoices.service.ts` (edit)
- `apps/api/src/invoices/invoices.controller.ts` (edit)
- `apps/api/src/invoices/dto/create-invoice.dto.ts` (edit)
- `apps/api/src/bookkeeping/bookkeeping.service.ts` (edit)
- `apps/api/src/invoices/invoices.service.spec.ts` (edit)

brief: New forward-only lifecycle method modeled on `voidPayment`; BOUNCED = void + optional real fee line + stored subtotal/total bump in one `tenantTransaction`; stamp RECORDED at all three live record points; exclude VOID from `findOne`'s `paidAmount`; Jest coverage.

**1. dto/create-invoice.dto.ts** — import `CheckStatus` from `@prisma/client`, append:

```ts
/** P5-12: advance a CHECK payment through its lifecycle. */
export class SetCheckStatusDto {
  @IsEnum(CheckStatus) status: CheckStatus;
  /** NSF fee to bill the customer when status = BOUNCED (omit or 0 = no fee). */
  @IsOptional() @IsNumber() @Min(0) nsfFeeAmount?: number;
}
```

**2. invoices.service.ts:**

(a) import `CheckStatus` from `@prisma/client`; add `SetCheckStatusDto` to the dto import.

(b) After the `TERM_DAYS` const add the forward-only transition map:

```ts
/**
 * P5-12: legal FORWARD transitions for the check lifecycle.
 * RECORDED → DEPOSITED → CLEARED (strict sequence); any non-bounced state can
 * go to BOUNCED (a deposited or even cleared check can be returned by the
 * bank). BOUNCED is terminal.
 */
const CHECK_TRANSITIONS: Record<CheckStatus, readonly CheckStatus[]> = {
  RECORDED: ["DEPOSITED", "BOUNCED"],
  DEPOSITED: ["CLEARED", "BOUNCED"],
  CLEARED: ["BOUNCED"],
  BOUNCED: [],
};
```

(c) In `recordPayment`'s `invoicePayment.create` add:
`checkStatus: dto.method === "CHECK" ? CheckStatus.RECORDED : null,`

(d) In `recordStandalonePayment`'s `invoicePayment.create` add the same `checkStatus` line.

(e) In `findOne`, change the paid sum to exclude VOID:

```ts
// P5-12: VOID payments (manually voided OR bounced checks) must not count
// toward the paid amount — every other paid-sum already excludes non-VOID.
const paidAmount = inv.payments
  .filter((p) => p.status !== "VOID")
  .reduce((s, p) => s + Number(p.amount), 0);
```

(f) Insert the new method directly after `voidPayment`:

```ts
  // ─── P5-12: check lifecycle (Recorded→Deposited→Cleared→Bounced) ──────────

  /**
   * Advance a CHECK payment through its lifecycle.
   *
   * DEPOSITED / CLEARED are bookkeeping-only: the payment stays PAID and no
   * balance changes. BOUNCED (NSF) is modeled on voidPayment(): the payment
   * flips to PaymentStatus VOID so every existing non-VOID paid-sum /
   * status:PAID aggregation (P&L, AR aging, cash flow, statements) excludes it
   * automatically — then the invoice status is recomputed, re-opening the
   * balance. When an NSF fee is given, the customer genuinely owes it: a
   * non-taxable ad-hoc InvoiceItem line is appended AND the STORED
   * Invoice.subtotal/total are bumped by roundMoney(fee) in the same
   * transaction (all balance readers use the stored total).
   */
  async setCheckStatus(invoiceId: string, paymentId: string, dto: SetCheckStatusDto) {
    return this.prisma.tenantTransaction(async (tx) => {
      const payment = await tx.invoicePayment.findFirst({
        where: { id: paymentId, invoiceId },
      });
      if (!payment) throw new NotFoundException("Payment not found");
      if (payment.method !== "CHECK")
        throw new BadRequestException("Check status can only be set on CHECK payments");
      if (payment.status === "VOID")
        throw new BadRequestException("Payment is voided — its check status can no longer change");

      const current: CheckStatus = payment.checkStatus ?? "RECORDED";
      if (!CHECK_TRANSITIONS[current].includes(dto.status)) {
        throw new BadRequestException(`Cannot move check from ${current} to ${dto.status}`);
      }

      const now = new Date();

      if (dto.status === "DEPOSITED" || dto.status === "CLEARED") {
        await tx.invoicePayment.update({
          where: { id: paymentId },
          data: {
            checkStatus: dto.status,
            ...(dto.status === "DEPOSITED" ? { depositedAt: now } : { clearedAt: now }),
          },
        });
        const invoice = await tx.invoice.findUnique({
          where: { id: invoiceId },
          select: { invoiceNumber: true, customerId: true, status: true, total: true },
        });
        if (!invoice) throw new NotFoundException("Invoice not found");
        this.gateway.emitInvoiceUpdated(this.prisma.getTenantId(), {
          invoiceId,
          invoiceNumber: invoice.invoiceNumber,
          customerId: invoice.customerId,
          status: invoice.status,
          total: Number(invoice.total),
        });
        return { success: true, checkStatus: dto.status };
      }

      // ── BOUNCED (NSF) — mirror voidPayment()'s recompute exactly ──────────
      const fee = roundMoney(dto.nsfFeeAmount ?? 0);
      await tx.invoicePayment.update({
        where: { id: paymentId },
        data: {
          checkStatus: "BOUNCED",
          bouncedAt: now,
          nsfFeeAmount: fee,
          status: "VOID" as any,
        },
      });

      const invoice = await tx.invoice.findUnique({
        where: { id: invoiceId },
        include: { payments: { where: { status: { not: "VOID" as any } } } },
      });
      if (!invoice) throw new NotFoundException("Invoice not found");

      let newSubtotal = Number(invoice.subtotal);
      let newTotal = Number(invoice.total);
      if (fee > 0) {
        await tx.invoiceItem.create({
          data: {
            invoiceId,
            description: `NSF fee — returned check${
              payment.paymentNumber
                ? ` ${payment.paymentNumber}`
                : payment.reference
                  ? ` ${payment.reference}`
                  : ""
            }`,
            qty: 1,
            unitPrice: fee,
            discount: 0,
            taxRate: 0,
            subtotal: fee,
          },
        });
        newSubtotal = roundMoney(newSubtotal + fee);
        newTotal = roundMoney(newTotal + fee);
      }

      const totalPaid = invoice.payments
        .filter((p) => p.id !== paymentId)
        .reduce((s, p) => s + Number(p.amount), 0);
      const newStatus = this.recomputeStatus(totalPaid, newTotal, invoice.dueDate, invoice.status);
      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          status: newStatus,
          paidAt: newStatus === InvoiceStatus.PAID ? invoice.paidAt : null,
          ...(fee > 0 ? { subtotal: newSubtotal, total: newTotal } : {}),
        },
      });

      this.gateway.emitInvoiceUpdated(this.prisma.getTenantId(), {
        invoiceId,
        invoiceNumber: invoice.invoiceNumber,
        customerId: invoice.customerId,
        status: newStatus,
        total: newTotal,
      });
      return { success: true, checkStatus: "BOUNCED" as CheckStatus };
    });
  }
```

> **FLAG — InvoiceItem ad-hoc line shape (VALIDATED by orchestrator):** supplies `description/qty/unitPrice/discount/taxRate/subtotal`; relies on defaults for `priceType`(STANDARD)/`categoryTaxAmount`(0), `productId`/`boxes`/`pieces` null; `tenantId` auto-injected by tenantTransaction. Confirm `npx prisma generate` compiles this create with no extra required field before proceeding.

> **NOTE:** `updatePayment` is deliberately NOT touched — the UI badge is gated on `method==="CHECK"`.

**3. invoices.controller.ts** — import `SetCheckStatusDto`; add the endpoint BETWEEN `voidPayment` and the `:id/payments/:paymentId` catch-all (specific path must be first):

```ts
  /** P5-12: advance a CHECK payment through Recorded→Deposited→Cleared→Bounced. */
  @Patch(":id/payments/:paymentId/check-status")
  @Roles(UserRole.OPERATOR)
  setCheckStatus(
    @Param("id") id: string,
    @Param("paymentId") paymentId: string,
    @Body() dto: SetCheckStatusDto,
  ) {
    return this.invoicesService.setCheckStatus(id, paymentId, dto);
  }
```

**4. bookkeeping.service.ts** — import `CheckStatus`; in `recordPayment`'s `invoicePayment.create` add `checkStatus: dto.method === "CHECK" ? CheckStatus.RECORDED : null,`.

**5. invoices.service.spec.ts** — append a `describe("P5-12 — setCheckStatus")` block covering: DEPOSITED stamps checkStatus+depositedAt, status stays PAID, no invoice.update; CLEARED (from DEPOSITED) stamps clearedAt, no invoice change; BOUNCED with fee=25 flips status VOID + creates a taxRate:0 NSF InvoiceItem (unitPrice 25, subtotal 25) + invoice.update{status SENT, paidAt null, subtotal 125, total 125} (base 100, no survivors); BOUNCED without fee: no invoiceItem.create, survivors of 40 → status PARTIAL, total/subtotal undefined in update; illegal CLEARED→DEPOSITED 400; RECORDED→CLEARED 400; non-CHECK 400; already-VOID 400; legacy null checkStatus treated as RECORDED. Plus a `describe("P5-12 — recordPayment stamps checkStatus")`: CHECK → checkStatus RECORDED, CASH → null (stub `prisma.paymentCounter.upsert`). Full spec bodies were provided in the planning pass — implement them faithfully at the Prisma/gateway mock boundary.

### WP3 — Web operator: per-payment check-status controls + NSF-fee modal + hook + types

files:

- `apps/web/lib/api/invoices.ts` (edit)
- `apps/web/app/(dashboard)/invoices/[id]/page.tsx` (edit)

brief: `CheckStatus` web type + extended `InvoicePayment` (add `status/checkStatus/depositedAt/clearedAt/bouncedAt/nsfFeeAmount/paymentNumber` + `CREDIT_CARD` to the method union); `useSetCheckStatus` hook (`PATCH …/check-status`; invalidate invoices + invoice detail + payments). Invoice-detail payment rows get a lifecycle badge (`effectiveCheckStatus`: null⇒RECORDED, manually-voided-not-bounced⇒no badge) + a "Check ▾" DropdownMenu (Mark deposited/cleared/bounced…, available even on a PAID invoice) + a `MarkBouncedModal` (optional NSF-fee input). Paid/Balance + `editPaymentMax` now exclude `status==="VOID"` payments; voided rows render struck. All icons (`XCircle/AlertTriangle/ChevronDown/CheckCircle2`) already imported. Exact JSX was provided in the planning pass — implement faithfully; do not touch pricing/`RecordPaymentModal` money logic.

### WP4 — Web buyer: invoice-detail check-status badge + VOID-aware balance + live refetch

files:

- `apps/web/lib/api/buyer.ts` (edit)
- `apps/web/app/buyer/portal/[seller]/invoices/[id]/page.tsx` (edit)
- `apps/web/lib/hooks/useBuyerNotifications.ts` (edit)

brief: `BuyerInvoiceDetail.payments[]` += `status?/checkStatus?/nsfFeeAmount?/paidAt?/createdAt?` (drop the never-returned `recordedAt`). Invoice-detail: a `checkBadgeFor` helper (CHECK only; manually-voided-not-bounced ⇒ no badge) renders a lifecycle badge per payment; the paid total filters `status!=="VOID"` so a bounce re-opens the displayed balance; payment date reads `p.paidAt ?? p.createdAt` (fixes the always-"N/A" bug). `useBuyerNotifications.ts`: on `invoice.updated`, ALSO `qc.invalidateQueries({ queryKey: ["buyer","invoice"] })` (was notification-only) so the badge/balance goes live. NO new buyer endpoint. Exact JSX provided in the planning pass.

### WP5 — Code-map update

files: `.claude/code-map/api.md`, `.claude/code-map/web.md`, `.claude/code-map/_meta.json`

brief: invoices api bullet (fields on InvoicePayment, setCheckStatus, BOUNCED=void+fee-line+total-bump, findOne void fix, prisma-mock paymentCounter, routes path untouched); operator + buyer invoice-detail web bullets (badge, Check▾, MarkBouncedModal, VOID-aware balance, buyer recordedAt fix + invoice.updated invalidation); bump `_meta` generatedAt + prepend a P5-12 note.

### Critical Files for Implementation

- apps/api/src/invoices/invoices.service.ts
- apps/api/prisma/schema.prisma
- apps/web/app/(dashboard)/invoices/[id]/page.tsx
- apps/web/lib/api/invoices.ts
- apps/web/app/buyer/portal/[seller]/invoices/[id]/page.tsx
