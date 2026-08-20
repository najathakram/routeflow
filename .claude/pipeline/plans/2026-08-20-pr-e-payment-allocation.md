# Plan: PR-E — payment allocation with running balances (AP + AR), on-account credit, bulk mark-paid

> Authored by Fable 5 on 2026-08-20. Status: APPROVED
> This file is the ONLY context the implementation and review agents receive.
> It must stand alone: no references to "the conversation", no "as discussed".

## Objective

A wholesaler pays a supplier one lump sum against many outstanding bills, and
gets paid one lump sum by a customer against many outstanding invoices. Today the
**receivable** side of that already works (see "What already exists"), but the
**payable** side does not: the only way to pay a supplier is bill-by-bill, there
is no supplier running balance, and an overpayment has nowhere to go. Build the
AP mirror of the AR flow, put a customer-level entry point where operators
actually are, make an overpayment become on-account credit instead of an error,
and add bulk mark-paid for bills and expenses.

**Carries migration #2** (additive only).

## Constraints & conventions

- **Stack**: npm + Turbo monorepo. NestJS 11 + Prisma 7 (`apps/api`), Next.js 14
  App Router (`apps/web`), Expo/RN (`apps/mobile`).
- **Tests**: Jest. `createMockPrisma()` from `apps/api/src/testing/prisma-mock.ts`.
  Mobile tests are pure-logic only. No snapshot tests, no Vitest.
- **Prettier**: semicolons, double quotes, `printWidth` 100, trailing commas.
- **Money**: `roundMoney` (2dp) from `apps/api/src/common/pricing.ts` — the ONLY
  rounding path. Comparisons use the house epsilon `0.001`.
- **Tenancy**: `forTenant()` injects `tenantId`; nested creates bypass it and land
  `tenantId = null`. Write child rows directly.
- **Migrations**: additive only. Generate the SQL with
  `npx prisma migrate diff --from-schema <old> --to-schema <new> --script`
  (a local Postgres is not available). **Never** run `prisma migrate dev`
  against production. CI replays the whole migration history against a fresh
  Postgres — that is the gate.
- **No new dependencies.**

### What ALREADY EXISTS — do not rebuild it (established by recon)

- **AR allocation is already implemented server-side.**
  `invoices.service.recordStandalonePayment(dto)` (~3828), route
  `POST /invoices/payments/record`, DTO `StandalonePaymentDto`
  (`dto/create-invoice.dto.ts:85`):
  `{ customerId, totalAmount, method, paidAt?, settledAt?, bankCharges?, reference?, notes?, status?, allocations: { invoiceId, amount }[] }`.
  It stamps ONE `paymentGroupId = randomUUID()` across every created row, one
  `settledAt/paidAt` for the whole group, validates each invoice belongs to the
  customer and isn't VOID, and — critically — **already turns the excess into an
  `AdvancePayment`** (`excess = totalAmount − Σallocations`, created when
  `> 0.001`, ~3898-3913). Returns `{ payments, paymentGroupId, excess }`.
- **The AR allocation UI already exists too**, but on a standalone hub page, not
  where operators are: web `apps/web/app/(dashboard)/finance/payments/page.tsx`
  (customer picker → open invoices sorted oldest-first at ~96-103, greedy
  waterfall pre-fill into editable rows at ~106-124, remainder shown as an excess
  badge), and mobile `apps/mobile/app/(operator)/payments/record.tsx` with the
  waterfall factored into `apps/mobile/lib/payments-logic.ts:121`.
- **The VOID-exclusion (bounced-cheque) rule** is `status: { not: "VOID" }` when
  summing payments — the single canonical predicate, used at 8 sites in
  `invoices.service.ts`. `recomputeStatus` (~111) trusts its caller to have
  filtered.
- **`AdvancePayment`** (schema ~2481): `{ id, customerId, amount, balance, method,
reference?, notes?, receivedAt, createdAt, updatedAt, tenantId? }`, back-relation
  `applications InvoicePayment[]`. No status machine — fully drawn is just
  `balance = 0`. Drawdown is `customers.service.applyAdvancePaymentToInvoice`
  (~860), which opens **its own** transaction (not reusable inside a caller's tx).
- **Bulk-action UI precedent, same file, one tab away**: `finance/expenses/page.tsx`
  `OtherExpensesTab` (~1474) already has a select-mode + action bar doing bulk
  "Mark Paid" for Expense rows (~1627-1656), and `InventoryPurchasesTab` (~815) —
  which IS the vendor-bills list — already has multi-select + bulk delete
  (~827-879, ~1088-1204).

### Landmines (recon-verified — these WILL bite)

1. **`VendorBillStatus.PARTIAL` is overloaded.** It is written by two unrelated
   paths: `receive()` writes it for a SHORT RECEIPT (~755
   `status: fullyReceived ? "RECEIVED" : "PARTIAL"`), and `recordPayment` writes it
   for a PART PAYMENT (~1679). Three existing guards already work around this by
   checking `receivedDate` instead of trusting status (see the comments at ~576-580,
   ~798-804, ~912-919). **Allocation eligibility must therefore be computed as
   `totalOwed − totalPaid > 0.001`, NEVER from status.** Every existing reader
   already does this arithmetic (`suppliers.service.ts:63`, and the two web pages).
2. **`Expense.vendorBillId` is `String? @unique` with NO Prisma `@relation` on
   either side.** There is no `expense.vendorBill` / `vendorBill.expense`. Any join
   needs a manual second `vendorBill.findUnique`.
3. **`BillPayment` is much thinner than `InvoicePayment`**: no `status` (so **no
   VOID concept on AP at all**), no `paymentGroupId`, no `settledAt`. Do not assume
   AR fields exist on AP.
4. **`recordPayment` for bills has NO status precondition** — it will happily pay a
   DRAFT or VOID bill and flip it to PARTIAL/PAID. Keep that behaviour for the
   existing single-bill route (changing it is out of scope), but the NEW supplier
   -level allocation must only target bills with a real outstanding balance.
5. **`recordPayment` currently discards `notes`** — the DTO accepts it but the
   `billPayment.create` call omits it (~1670). Fix that in passing (one line).
6. **Neither existing bulk endpoint uses a class-validator DTO** — both use an
   inline `@Body()` type, which the ValidationPipe cannot validate. **Break that
   convention deliberately**: the new bulk endpoint takes a real DTO class, because
   it moves money.
7. `customers.service.applyAdvancePaymentToInvoice` re-implements the invoice
   status thresholds inline instead of calling `recomputeStatus`. Do not add a
   third copy — reuse one of the existing two.

## Work packages

File lists are DISJOINT.

### WP1 — Migration #2 + schema

- **files:** `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20260821000000_add_supplier_credit_and_bill_payment_group/migration.sql`
- **brief:** Two additive changes only.
  1. `BillPayment.paymentGroupId String?` with `@@index([paymentGroupId])` — mirrors
     `InvoicePayment.paymentGroupId`, so one supplier payment split across N bills is
     one recognisable event.
  2. New `SupplierCredit` model mirroring `AdvancePayment` exactly in shape:

     ```prisma
     /// On-account credit held for a supplier — the AP mirror of AdvancePayment.
     /// Created when a supplier payment exceeds everything currently owed; drawn
     /// down automatically against the next bill. No status machine: fully drawn
     /// is simply balance = 0.
     model SupplierCredit {
       id         String   @id @default(uuid())
       supplierId String
       amount     Decimal  @db.Decimal(10, 2) // original, immutable
       balance    Decimal  @db.Decimal(10, 2) // remaining drawable
       method     PaymentMethod
       reference  String?
       notes      String?
       receivedAt DateTime @default(now())
       createdAt  DateTime @default(now())
       updatedAt  DateTime @updatedAt
       tenantId   String?

       supplier Supplier @relation(fields: [supplierId], references: [id])
       tenant   Tenant?  @relation(fields: [tenantId], references: [id])

       @@index([supplierId])
       @@index([tenantId])
     }
     ```

     Add the back-relations on `Supplier` and `Tenant`.
     Generate the migration SQL with `prisma migrate diff` as described in the
     constraints; confirm it contains **no** `ALTER … DROP` and no data migration.

- **spec:** none (schema only) — WP2's specs exercise it.

### WP2 — API: supplier-level payment allocation + on-account credit

- **files:** `apps/api/src/vendor-bills/vendor-bills.service.ts`, `apps/api/src/vendor-bills/vendor-bills.controller.ts`, `apps/api/src/vendor-bills/dto/supplier-payment.dto.ts`, `apps/api/src/vendor-bills/supplier-payment.spec.ts`
- **brief:**
  **DTO** (`supplier-payment.dto.ts`) — a real class-validated DTO:

  ```ts
  export class SupplierAllocationDto {
    @IsString() vendorBillId!: string;
    @IsNumber() @Type(() => Number) @Min(0) amount!: number;
  }
  export class RecordSupplierPaymentDto {
    @IsString() supplierId!: string;
    @IsNumber() @Type(() => Number) @IsPositive() totalAmount!: number;
    @IsEnum(PaymentMethod) method!: PaymentMethod;
    @IsOptional() @IsDateString() paidAt?: string;
    @IsOptional() @IsString() @MaxLength(200) reference?: string;
    @IsOptional() @IsString() @MaxLength(1000) @StripHtml() notes?: string;
    @IsArray()
    @ArrayMaxSize(500)
    @ValidateNested({ each: true })
    @Type(() => SupplierAllocationDto)
    allocations!: SupplierAllocationDto[];
  }
  ```

  **`recordSupplierPayment(dto)`** — one `tenantTransaction`, mirroring
  `recordStandalonePayment`'s shape so AP and AR read alike:
  1. Generate `paymentGroupId = randomUUID()` and resolve `paidAt`.
  2. For each allocation with `amount > 0.001`: load the bill, **verify it belongs
     to `dto.supplierId`** (400 otherwise — money must never land on another
     supplier's bill), compute `alreadyPaid` by summing its `BillPayment` rows (the
     ledger, exactly as `recordPayment` does — not the denormalised column), and
     reject an allocation exceeding `totalOwed − alreadyPaid + 0.001`.
  3. Create one `BillPayment` per bill, all sharing `paymentGroupId`, and recompute
     each bill's `totalPaid`/`status` using the SAME rule as `recordPayment`
     (`newPaid >= totalOwed - 0.001 ? "PAID" : "PARTIAL"`).
  4. **Remainder becomes credit, never an error**:
     ```ts
     // Overpayment is on-account credit, not a rejection: the operator paid what
     // they paid. Mirrors recordStandalonePayment's excess -> AdvancePayment.
     const excess = roundMoney(dto.totalAmount - allocatedTotal);
     if (excess > 0.001) {
       await tx.supplierCredit.create({
         data: {
           supplierId: dto.supplierId,
           amount: excess,
           balance: excess,
           method: dto.method,
           reference: dto.reference ?? null,
           notes: dto.notes ?? null,
         },
       });
     }
     ```
     Reject `allocatedTotal > dto.totalAmount + 0.001` (you cannot allocate more
     than you paid).
  5. Return `{ paymentGroupId, payments, excess, bills: [{ id, status, totalPaid }] }`.

  **`getSupplierStatement(supplierId)`** — a pure read returning a running-balance
  timeline: bills (up) and payments/credits (down) merged and sorted by date, each
  row carrying a running `balance`, plus a headline
  `{ totalOwed, totalPaid, outstanding, creditBalance }`. `outstanding` is
  `Σ(totalOwed − totalPaid)` over non-VOID bills — **arithmetic, never status**.

  **Auto-apply available credit to a new bill**: when a bill is created and the
  supplier has `SupplierCredit.balance > 0`, draw it down oldest-first inside the
  same transaction, creating a `BillPayment` with `method: PaymentMethod.CREDIT_NOTE`
  (there is no ADVANCE-equivalent for AP; pick the closest existing enum value and
  set `reference: "SUPPLIER_CREDIT-<id8>"` so it is unambiguous), decrementing
  `balance`, and recomputing the bill's status. **Never draw more than the bill
  owes.** Surface it as a "Paid $X from account credit" note on the payment row.

  Also fix landmine 5: pass `notes: dto.notes ?? null` through in the existing
  single-bill `recordPayment`'s `billPayment.create`.

- **specs** (`supplier-payment.spec.ts`, new) — all must fail without the fix:
  1. One payment across three bills creates three `BillPayment` rows **sharing one
     `paymentGroupId`**, and each bill's status recomputes correctly.
  2. An allocation to a bill belonging to a DIFFERENT supplier throws 400 and
     writes nothing.
  3. An allocation exceeding a bill's remaining balance throws 400.
  4. `Σallocations > totalAmount` throws 400.
  5. Overpayment creates a `SupplierCredit` with `amount === balance === excess`.
  6. **Eligibility is arithmetic, not status**: a bill with
     `status: "PARTIAL"` because it was SHORT-RECEIVED (not part-paid) and
     `totalPaid = 0` is fully payable for its whole `totalOwed`.
  7. Auto-apply draws credit oldest-first, never exceeds the bill's balance, and
     leaves the remaining credit balance correct.

### WP3 — API: bulk mark-paid for bills and expenses

- **files:** `apps/api/src/vendor-bills/dto/bulk-mark-paid.dto.ts`, `apps/api/src/bookkeeping/bookkeeping.service.ts`, `apps/api/src/bookkeeping/bookkeeping.controller.ts`, `apps/api/src/bookkeeping/bulk-mark-paid.spec.ts`
- **brief:** Add a bulk "mark paid" that is implemented as **full-remaining payments
  per bill** — the same ledger every other payment writes, no special status jump.
  - New DTO class (breaking the inline-`@Body()` convention on purpose, landmine 6):
    `{ ids: string[] (@ArrayMaxSize(500)), method: PaymentMethod, paidAt?: string, reference?: string }`.
  - Follow the **partition-and-report** convention of `vendor-bills bulkDelete`
    (precompute eligibility, never throw for an individual item) and return
    `{ paid: number, totalAmount: number, skipped: { id, billNumber, reason }[] }`.
    A bill with no outstanding balance is skipped with a reason, not an error.
  - **An Expense linked 1:1 to a VendorBill must mark its BILL, not just itself**
    (landmine 2 — fetch the bill manually, there is no relation). Today
    `bookkeeping.updateExpense` sets `Expense.status` and never touches the bill;
    that divergence is the bug this closes. Keep `buildStatusPatch`'s existing
    auto-stamping of `receivedAt`/`paidAt`.
- **spec:** new file. Cover: mixed eligible/ineligible ids partition correctly and
  the ineligible ones are reported not thrown; the total is the sum of remaining
  balances actually paid; **a linked expense's bill gets a payment and reaches PAID**;
  an unlinked expense behaves as before.

### WP4 — web: supplier statement + supplier-level payment + customer entry point

- **files:** `apps/web/app/(dashboard)/suppliers/[id]/page.tsx`, `apps/web/components/RecordSupplierPaymentModal.tsx`, `apps/web/components/CustomerRecordPaymentModal.tsx`, `apps/web/lib/api/supplier-payments.ts`
- **brief:**
  1. **`RecordSupplierPaymentModal`** — the AP mirror of the existing AR allocation
     UI. **Reuse the proven interaction from
     `apps/web/app/(dashboard)/finance/payments/page.tsx` (~96-124)**: open bills
     sorted **oldest-first by `billDate`, then `createdAt`**, a greedy waterfall
     pre-fill of `totalAmount` across them, **every row editable before confirm**
     (oldest-first is the default, not a cage), each row showing owed → applied →
     after, and a remainder line reading "→ $X stays on account". Eligibility is
     `totalOwed − totalPaid > 0.001` (landmine 1). Hand-roll the overlay at
     `max-w-2xl` like `GroupAsVariantsModal` — the shared `Modal` is capped at
     `max-w-lg`.
  2. **Supplier page** gains a "Record payment" action and a **running-balance
     timeline** (bills up, payments/credits down, balance column) with the
     open-balance headline, fed by `getSupplierStatement`.
  3. **`CustomerRecordPaymentModal`** — the missing customer-level AR entry point.
     It must **reuse the existing allocation logic rather than duplicating it**:
     extract the waterfall/allocation-row logic from `finance/payments/page.tsx`
     into a shared piece both use, passing `customerId` as a fixed prop instead of
     rendering the picker. Attach it next to the existing "Record Advance Payment"
     button on the customer Billing tab (~3027-3043) — that button is the pattern to
     copy.
  4. **`lib/api/supplier-payments.ts`** — hooks for the new endpoints, invalidating
     `["suppliers"]`, `["vendor-bills"]`, `["expenses"]`, `["finance-dashboard"]`.

### WP5 — web: bulk mark-paid UI

- **files:** `apps/web/app/(dashboard)/finance/expenses/page.tsx`
- **brief:** `InventoryPurchasesTab` (~815) already has multi-select + a bulk-delete
  button; add a **"Mark paid"** action beside it using the **action-bar pattern the
  `OtherExpensesTab` in this same file already uses** (~1627-1656). It takes one
  shared date/method and shows a **preview total before confirming**, e.g.
  "Mark 14 bills paid — $12,480.20". Compute that total from
  `totalOwed − totalPaid` per selected bill (never from status). Wire it to WP3's
  endpoint and report the skipped list in the toast, matching how bulk delete
  already reports skips.

### WP6 — mobile: AP parity

- **files:** `apps/mobile/app/(operator)/suppliers/[id].tsx`, `apps/mobile/components/RecordSupplierPaymentSheet.tsx`, `apps/mobile/lib/api/supplier-payments.ts`, `apps/mobile/lib/supplier-payment-logic.ts`, `apps/mobile/__tests__/supplier-payment-logic.test.ts`
- **brief:** Supplier detail gains "Record payment" opening a `FormSheet`-based
  allocation sheet (the mobile modal convention), plus the running-balance summary.
  Put the waterfall/clamping/remainder rules in `supplier-payment-logic.ts` and
  **unit-test them** — mirror `apps/mobile/lib/payments-logic.ts:121`, which already
  does exactly this for the AR side; reuse its shape so AP and AR behave identically.
  Also add a **"Record payment"** link on the mobile customer detail screen next to
  the existing "Record advance payment" (~260-261), pushing to the existing
  `/(operator)/payments/record` screen **pre-filled with that customer** so the
  picker step is skipped.
- **spec:** `__tests__/supplier-payment-logic.test.ts` — waterfall order, per-row
  clamping, remainder computation, and that a short-received PARTIAL bill with
  `totalPaid = 0` is fully allocatable.

## Acceptance criteria

1. Migration #2 is additive only (no `DROP`, no data migration) and CI's
   migrate-deploy step replays the full history clean.
2. `POST` supplier payment creates one `BillPayment` per allocated bill, all sharing
   one `paymentGroupId`, inside a single transaction.
3. Allocating to a bill of a different supplier, over a bill's remaining balance, or
   beyond `totalAmount` each returns 400 and writes nothing.
4. An overpayment creates a `SupplierCredit` with `amount === balance === excess`;
   nothing is rejected and nothing is lost.
5. A new bill auto-applies available `SupplierCredit` oldest-first, never exceeding
   what the bill owes, and the payment row identifies itself as account credit.
6. **Eligibility everywhere is `totalOwed − totalPaid > 0.001`** — a short-received
   `PARTIAL` bill with no payments is fully payable. A spec pins this.
7. Bulk mark-paid pays each bill's full remaining balance through the normal ledger,
   partitions ineligible ids into a reported `skipped` list rather than throwing, and
   marks the linked **bill** when given a bill-linked expense.
8. The supplier page shows a running-balance timeline and an open-balance headline;
   the customer Billing tab gains a customer-level "Record payment" that reuses the
   existing allocation logic (not a second copy of it).
9. Mobile reaches supplier payment allocation and customer payment recording, with
   the allocation rules unit-tested.
10. `recordPayment` no longer discards `notes`.
11. No new dependencies; no changes to existing route paths or response shapes
    beyond additive fields.

## Verification commands

From the repo root:

- `npm run verify` — Turbo `check-types`, `lint`, `test`.

Lint must report **0 errors** (pre-existing warnings expected); all suites pass.

## Risks & rollback

- **Highest risk: paying the wrong supplier's bill.** The per-allocation
  `supplierId` check is the guard; criterion 3 pins it.
- **Second: trusting `VendorBillStatus`.** Any eligibility check written against
  status instead of arithmetic will silently refuse to pay short-received bills, or
  worse, double-pay. Review every new comparison for this.
- **Auto-apply of supplier credit** is the one place money moves without an explicit
  operator action per bill — keep it strictly capped at the bill's balance, make the
  payment row self-describing, and never apply credit to a VOID bill.
- **AP has no VOID concept** (`BillPayment` has no `status`), so a mistaken supplier
  payment cannot currently be voided the way an AR one can. Do **not** invent that in
  this PR — note it as a follow-up so the gap is visible rather than assumed handled.
- **Rollback**: the migration is additive, so reverting the code leaves two unused
  tables/columns and no behaviour change. The new endpoints are additive; removing
  them plus the UI entry points restores the previous flow exactly.
