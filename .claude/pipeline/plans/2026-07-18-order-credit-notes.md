# Plan: Apply customer credit notes on orders (create + any-stage edit)

> Authored by Fable 5 on 2026-07-18. Status: IMPLEMENTED (pipeline wf_f6c7926b-e4e clean; verify green; 1 fix round — caught+fixed: merge-path credit drop, settle stale-snapshot under-apply, tenant-orphaned credit payments in the delivery path)
> This file is the ONLY context the implementation and review agents receive. It must stand alone.

## Objective

When creating or editing an order (any editable stage, INCLUDING a delivered order), an
operator can select the customer's open CREDIT NOTES to apply to that order. The customer's
open credits auto-populate in a picker once a customer is chosen. Applying a credit reduces
the **balance due** on the order's invoice(s) payment-style — order/invoice totals are NOT
changed. The credit's description (`CreditNote.reason`) is visible on the order, the invoice,
and the invoice PDF — rendered AT READ TIME through the relation, so a later edit of the
reason shows up everywhere automatically (never copy the text).

Architecture (intent vs money):

- **Intent** = new `OrderCreditNote` join table (orderId, creditNoteId, `amount Decimal?` —
  requested dollars, null = "up to the credit's remaining balance"). Survives every invoice
  rebuild because it never references invoice rows.
- **Money** = existing `InvoicePayment {method: CREDIT_NOTE, creditNoteId}` rows created ONLY
  by the existing private `applyCreditInTx` (clamps to min(remaining, invoiceBalance,
  requested), maintains `CreditNote.amountUsed`/status). Never a second money path.
- A new idempotent `settleOrderCreditsInTx(tx, orderId)` reconciles intent → money whenever
  the order's invoice picture changes (invoice creation, order edit, delivery, send).

Groundwork ALREADY DONE (do not redo): `schema.prisma` has the `OrderCreditNote` model +
back-relations (`Order.orderCreditNotes`, `CreditNote.orderLinks`, `Tenant.orderCreditNotes`);
migration `apps/api/prisma/migrations/20260729000000_add_order_credit_notes/migration.sql`
exists; `npx prisma generate` has been run.

## Constraints & conventions

- NestJS API `apps/api`, Next.js 14 web `apps/web`, Expo mobile `apps/mobile`. Prettier:
  double quotes, semicolons, printWidth 100. Jest via `Test.createTestingModule`, mocks at
  module boundary. No new dependencies. No unrelated reformatting.
- Money: every figure through `roundMoney` (imported already in all touched API files);
  `Number(...)`-coerce Prisma Decimals. `CreditNote.amountUsed` is the single wallet truth;
  `OrderCreditNote.amount` is a REQUEST, never a balance. Never store a derived "remaining".
- Tenancy: all new queries via the `tx` handed in by `tenantTransaction`, or
  `this.prisma.forTenant()`. Set `tenantId: this.prisma.getTenantId()` on OrderCreditNote
  creates (nested/explicit creates bypass the forTenant extension — existing convention).
- The credit-notes service already contains: `applyCreditInTx` (private, ~line 367),
  `autoApplyOldestCreditsInTx` (~448), `applyToInvoice` (~507), `voidCreditNote` (~555),
  private `recomputeStatus` (~38). InvoicesService also has its own private
  `recomputeStatus` and already injects `this.creditNotes` (constructor ~line 76).
- IMPORTANT status semantics: `recomputeStatus` treats DRAFT/VOID/WRITTEN_OFF as terminal.
  A credit applied to a DRAFT pending-mirror leaves it DRAFT with a reduced balance — correct;
  the send()-time fix below promotes it correctly at send.
- The shared Jest prisma mock (grep `paymentCounter: modelProxy()` under `apps/api/src` to
  find it) must gain `orderCreditNote: modelProxy()` in BOTH `allModels()` and `txModels()`.
  **Only WP1 edits that file** (single owner; other packages just rely on it).

## Work packages

### WP1 — CreditNotesService core primitives + controller + specs

- **files:** `apps/api/src/credit-notes/credit-notes.service.ts`,
  `apps/api/src/credit-notes/credit-notes.controller.ts`,
  `apps/api/src/credit-notes/credit-notes.service.spec.ts`,
  the shared prisma mock file (grep `paymentCounter: modelProxy()`)
- **brief:** Append the new primitives to CreditNotesService (after `voidCreditNote`), add
  `opts` to `autoApplyOldestCreditsInTx`, add two controller endpoints, extend specs.

1. **`restoreCreditFromPaymentInTx`** (private) — the inverse of `applyCreditInTx`:

   ```ts
   /**
    * Inverse of applyCreditInTx: give (part of) an applied credit back to the wallet.
    * Deletes (or shrinks) the CREDIT_NOTE InvoicePayment, decrements amountUsed,
    * reverts APPLIED→ISSUED when the credit is no longer fully consumed, and
    * recomputes the invoice's status from its remaining non-VOID payments.
    * Returns the dollars actually restored.
    */
   private async restoreCreditFromPaymentInTx(
     tx: any,
     payment: { id: string; invoiceId: string; creditNoteId: string | null; amount: unknown },
     reduceBy?: number,
   ): Promise<number> {
     if (!payment.creditNoteId) return 0;
     const payAmt = roundMoney(Number(payment.amount));
     const restore = roundMoney(Math.min(payAmt, reduceBy ?? payAmt));
     if (!(restore > 0.001)) return 0;

     if (restore >= payAmt - 0.001) {
       await tx.invoicePayment.delete({ where: { id: payment.id } });
     } else {
       await tx.invoicePayment.update({
         where: { id: payment.id },
         data: { amount: roundMoney(payAmt - restore) },
       });
     }

     const cn = await tx.creditNote.findUnique({ where: { id: payment.creditNoteId } });
     if (cn) {
       const newUsed = Math.max(0, roundMoney(Number(cn.amountUsed) - restore));
       const fullyApplied = newUsed >= Number(cn.amount) - 0.001;
       await tx.creditNote.update({
         where: { id: cn.id },
         data: {
           amountUsed: newUsed,
           // VOID stays VOID (defensive; callers pre-filter). Otherwise the wallet
           // state follows consumption: fully consumed = APPLIED, else ISSUED.
           status: cn.status === "VOID" ? "VOID" : fullyApplied ? "APPLIED" : "ISSUED",
           appliedToInvoiceId: fullyApplied ? cn.appliedToInvoiceId : null,
           ...(newUsed <= 0.001 ? { appliedAt: null, autoApplied: false } : {}),
         },
       });
     }

     const inv = await tx.invoice.findUnique({
       where: { id: payment.invoiceId },
       include: { payments: true },
     });
     if (inv) {
       const paid = roundMoney(
         (inv.payments ?? [])
           .filter((p: any) => p.status !== "VOID")
           .reduce((s: number, p: any) => s + Number(p.amount), 0),
       );
       const newStatus = this.recomputeStatus(paid, Number(inv.total), inv.dueDate, inv.status);
       await tx.invoice.update({
         where: { id: inv.id },
         data: {
           status: newStatus,
           paidAt: newStatus === InvoiceStatus.PAID ? (inv.paidAt ?? new Date()) : null,
         },
       });
     }
     return restore;
   }
   ```

2. **`validateSelectionsForCustomer(db, customerId, selections)`** (public). Throws
   BadRequest/NotFound on: duplicate creditNoteId in the list; unknown id; different
   customer; status VOID; expired (`expiresAt <= now`). Deliberately does NOT require
   remaining balance > 0 — an idempotent resubmit of an already-consumed selection must not
   fail (the apply clamp makes over-selection harmless).

3. **`syncOrderCreditSelections(tx, orderId, customerId, selections | undefined)`** (public):
   `undefined` → return immediately (backward compatible: clients that don't send the field
   leave credits untouched). Otherwise: `await this.validateSelectionsForCustomer(tx, customerId, selections)`,
   load existing `tx.orderCreditNote.findMany({ where: { orderId } })`, diff:
   - existing row NOT in selections → pull back this pair's money then delete the row;
   - existing row whose `amount` differs (null vs number, or different rounded number) →
     pull back this pair's money, update the row's amount (settle re-applies at the new
     request);
   - new selection → `tx.orderCreditNote.create({ data: { orderId, creditNoteId, amount:
  s.amount ?? null, tenantId: this.prisma.getTenantId() } })`.
     "Pull back this pair's money" =

   ```ts
   const pays = await tx.invoicePayment.findMany({
     where: {
       creditNoteId: row.creditNoteId,
       method: PaymentMethod.CREDIT_NOTE,
       status: { not: "VOID" },
       invoice: { orderId },
     },
     orderBy: { createdAt: "desc" },
   });
   for (const p of pays) await this.restoreCreditFromPaymentInTx(tx, p);
   ```

4. **`settleOrderCreditsInTx(tx, orderId)`** (public) — the idempotent core:

   ```ts
   /**
    * Reconcile the order's credit INTENTS (OrderCreditNote rows) with actual
    * CREDIT_NOTE InvoicePayments, inside the caller's transaction. Idempotent:
    * (a) SHRINK — if an order edit dropped an invoice total below what its
    *     payments cover, un-apply the excess from credit payments (newest first;
    *     cash is never auto-adjusted);
    * (b) APPLY — for each intent (oldest first), apply the unmet remainder
    *     across the order's non-VOID invoices (base number first, then -R#
    *     siblings). applyCreditInTx clamps everything, so re-runs are no-ops.
    * No-op when the order has no invoices yet (intent waits for one).
    */
   async settleOrderCreditsInTx(
     tx: any,
     orderId: string,
   ): Promise<{ applied: number; unapplied: number }> {
     const result = { applied: 0, unapplied: 0 };
     const intents = await tx.orderCreditNote.findMany({
       where: { orderId },
       orderBy: { createdAt: "asc" },
       include: { creditNote: true },
     });
     const invoices = await tx.invoice.findMany({
       where: { orderId, status: { not: "VOID" } },
       include: { payments: true },
       orderBy: { invoiceNumber: "asc" },
     });
     if (invoices.length === 0) return result;

     // (a) shrink
     for (const inv of invoices) {
       const nonVoid = (inv.payments ?? []).filter((p: any) => p.status !== "VOID");
       const paid = roundMoney(nonVoid.reduce((s: number, p: any) => s + Number(p.amount), 0));
       let excess = roundMoney(paid - Number(inv.total));
       if (!(excess > 0.001)) continue;
       const creditPays = nonVoid
         .filter((p: any) => p.method === "CREDIT_NOTE" && p.creditNoteId)
         .sort(
           (a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
         );
       for (const p of creditPays) {
         if (!(excess > 0.001)) break;
         const restored = await this.restoreCreditFromPaymentInTx(tx, p, excess);
         excess = roundMoney(excess - restored);
         result.unapplied = roundMoney(result.unapplied + restored);
       }
     }

     // (b) apply
     const now = new Date();
     for (const intent of intents) {
       const cn0 = intent.creditNote;
       if (!cn0 || cn0.status === "VOID") continue;
       if (cn0.expiresAt && new Date(cn0.expiresAt) <= now) continue;
       const appliedForPair = roundMoney(
         invoices
           .flatMap((inv: any) => inv.payments ?? [])
           .filter((p: any) => p.status !== "VOID" && p.creditNoteId === intent.creditNoteId)
           .reduce((s: number, p: any) => s + Number(p.amount), 0),
       );
       let unmet =
         intent.amount != null
           ? roundMoney(Math.max(0, Number(intent.amount) - appliedForPair))
           : roundMoney(Number(cn0.amount) - Number(cn0.amountUsed));
       for (const inv of invoices) {
         if (!(unmet > 0.001)) break;
         // Fresh reads — earlier loop iterations move money.
         const cn = await tx.creditNote.findUnique({ where: { id: intent.creditNoteId } });
         const freshInv = await tx.invoice.findUnique({
           where: { id: inv.id },
           include: { payments: true },
         });
         if (!cn || !freshInv) break;
         const res = await this.applyCreditInTx(tx, cn, freshInv, unmet);
         if (res.applied <= 0) continue;
         unmet = roundMoney(unmet - res.applied);
         result.applied = roundMoney(result.applied + res.applied);
       }
     }
     return result;
   }
   ```

5. **`unapplyFromInvoice(creditNoteId, invoiceId)`** (public, Serializable
   `tenantTransaction` — clone the `applyToInvoice` wrapper style): find this pair's active
   payments (`{ creditNoteId, invoiceId, method: CREDIT_NOTE, status: { not: "VOID" } }`,
   newest first); if none → BadRequest "no active application". Restore each via
   `restoreCreditFromPaymentInTx`, summing `restored`. Then reduce the order intent so a
   later settle doesn't just re-apply: look up the invoice's `orderId`; if set, find the
   `orderCreditNote` row for (orderId, creditNoteId): null-amount row → delete; numeric
   amount → `newAmt = roundMoney(amount − restored)`, update if > 0.001 else delete.
   Return the fresh credit note row.

6. **`updateCreditNote(id, dto: { reason?: string; expiresAt?: string | null })`** (public):
   reason editable at ANY status (descriptive text); `expiresAt` only while status is
   ISSUED (else BadRequest). Return the updated row. This is what makes "edit the
   description later" real — there is no reason-edit endpoint today.

7. **`autoApplyOldestCreditsInTx(tx, invoiceId, customerId, opts?)`** — add
   `opts?: { excludeCreditNoteIds?: string[] }` and thread
   `...(opts?.excludeCreditNoteIds?.length ? { id: { notIn: opts.excludeCreditNoteIds } } : {})`
   into the `creditNote.findMany` where-clause. (Send-time sweep must not override an
   operator's EXPLICIT-amount selection; null-amount intents are already fully consumed by
   settle before send, so the clamp makes the sweep harmless for them.)

8. **Controller** (`credit-notes.controller.ts` — follow the existing decorator style; add
   `Patch` to the @nestjs/common import):
   - `@Post(":id/unapply")` OPERATOR — body `{ invoiceId: string }` →
     `unapplyFromInvoice(id, body.invoiceId)`.
   - `@Patch(":id")` OPERATOR — body `{ reason?, expiresAt? }` → `updateCreditNote(id, body)`.

9. **Specs** (`credit-notes.service.spec.ts`, extend existing mock patterns; the prisma mock
   gains `orderCreditNote: modelProxy()` in allModels+txModels):
   - unapply restores `amountUsed`, flips APPLIED→ISSUED, clears `appliedToInvoiceId`.
   - unapply on a credit partially consumed by ANOTHER invoice restores only this pair's
     dollars (other pair untouched).
   - settle applies a stored intent once an invoice exists; a second settle call applies 0
     (idempotent).
   - settle shrink pass: invoice total dropped below Σ payments → credit payment reduced,
     `amountUsed` decremented, cash payment untouched.
   - explicit-amount intent: settle applies exactly min(amount, remaining, balance).
   - expired / cross-customer / duplicate selections rejected by
     `validateSelectionsForCustomer`; fully-consumed selection ACCEPTED (idempotency).
   - `autoApplyOldestCreditsInTx` skips ids in `excludeCreditNoteIds`.
   - `updateCreditNote` edits reason at APPLIED status but rejects expiresAt then.

### WP2 — Invoices wiring: settle hook, send fixes, payment guards, reason includes + PDF

- **files:** `apps/api/src/invoices/invoices.service.ts`,
  `apps/api/src/invoices/invoices.service.spec.ts`,
  `apps/api/src/invoices/invoice-pdf.service.ts`,
  `apps/api/src/invoices/invoice-pdf-template.tsx`
- **brief:**

1. **Settle hook at from-order creation** — in `createSplitInvoices`, inside `runCreation`
   (the atomic creation closure), AFTER the invoicedQty bump loop and before `return out;`:

   ```ts
   // Apply any order-selected credit notes to the freshly created invoice(s).
   await this.creditNotes.settleOrderCreditsInTx(tx, order.id);
   ```

   This single chokepoint covers `createInvoiceFromOrder`, `createInvoiceFromOrderWithTenant`,
   and `createSale`. NOTE: `settleOrderCreditsInTx` is a NEW public method on
   CreditNotesService (WP1 adds it; signature `(tx, orderId) → Promise<{applied, unapplied}>`).

2. **`send()` (~line 2424) and `sendEmail()` (~2476)** — both wrap the SENT flip +
   `autoApplyOldestCreditsInTx(tx, id, updated.customerId)` in a Serializable tx. Two changes
   in EACH:
   a. Exclusions: before the autoApply call, inside the tx:

   ```ts
   // An operator's EXPLICIT-amount order selection must not be overridden by the
   // oldest-first sweep; null-amount intents are already settled and clamp to 0.
   const explicitIds = updated.orderId
     ? (
         await tx.orderCreditNote.findMany({
           where: { orderId: updated.orderId, amount: { not: null } },
           select: { creditNoteId: true },
         })
       ).map((r: any) => r.creditNoteId)
     : [];
   const auto = await this.creditNotes.autoApplyOldestCreditsInTx(tx, id, updated.customerId, {
     excludeCreditNoteIds: explicitIds,
   });
   ```

   b. **Stuck-SENT fix** — right after the autoApply call, still inside the tx:

   ```ts
   // A credit pre-applied at order time can already cover this invoice. Auto-apply
   // returns {applied:0, invoiceStatus:null} on a zero balance, which used to leave
   // a fully-credited invoice stuck SENT — recompute from the payments it has.
   if (!auto.invoiceStatus) {
     const fresh = await tx.invoice.findUnique({ where: { id }, include: { payments: true } });
     if (fresh) {
       const paid = roundMoney(
         (fresh.payments ?? [])
           .filter((p: any) => p.status !== "VOID")
           .reduce((s: number, p: any) => s + Number(p.amount), 0),
       );
       const st = this.recomputeStatus(paid, Number(fresh.total), fresh.dueDate, fresh.status);
       if (st !== fresh.status) {
         await tx.invoice.update({
           where: { id },
           data: { status: st, paidAt: st === InvoiceStatus.PAID ? new Date() : null },
         });
         auto.invoiceStatus = st;
       }
     }
   }
   ```

   (If `auto` is typed const-shallow, restructure minimally — e.g. `let finalStatus`.)
   The post-tx code already uses `auto.invoiceStatus ?? updated.status` for the socket emit
   and re-fetches when `auto.applied > 0`; ALSO re-fetch when the status was promoted
   (`auto.invoiceStatus && auto.applied === 0`) so the caller gets the PAID row — simplest:
   change the re-fetch condition to `auto.applied > 0 || auto.invoiceStatus != null`.

3. **`deletePayment` and `voidPayment`** — after each fetches its payment row and BEFORE any
   mutation, add:

   ```ts
   if ((payment.method as any) === "CREDIT_NOTE") {
     throw new BadRequestException(
       "This payment is an applied credit note. Un-apply it from the credit note instead (POST /credit-notes/:id/unapply) so the credit's balance is restored.",
     );
   }
   ```

   (Use the local variable name each method actually has for the fetched payment.)
   ADVANCE payments share the orphan bug but are OUT OF SCOPE — do not touch them.

4. **Reason via relation on reads** — in `findOne` (the invoice detail read, ~2047 region),
   the include currently has `payments: { orderBy: { createdAt: "desc" } }` — change to:

   ```ts
   payments: {
     orderBy: { createdAt: "desc" },
     include: {
       creditNote: {
         select: { id: true, creditNoteNumber: true, reason: true, amount: true, amountUsed: true, status: true },
       },
     },
   },
   ```

   Do the same on the invoice load inside `invoice-pdf.service.ts` (payments are rendered in
   the PDF's Payment History).

5. **PDF template** (`invoice-pdf-template.tsx`): the payments prop type gains
   `creditNote?: { creditNoteNumber: string; reason: string | null } | null`. In the Payment
   History row rendering, for CREDIT_NOTE payments add a secondary line under the method:
   `Credit {creditNoteNumber}{reason ? ` — ${reason}` : ""}` (falls back to the existing
   reference line when no reason). Match the template's existing row/typography components.

6. **Specs** (`invoices.service.spec.ts`):
   - `send` flips a fully-pre-credited DRAFT to PAID, not SENT (stuck-SENT regression).
   - `send` passes the order's explicit-amount intent ids as `excludeCreditNoteIds`.
   - `deletePayment` / `voidPayment` throw for CREDIT_NOTE payments.
   - `createSplitInvoices` calls `settleOrderCreditsInTx` with the creation tx + order id
     (mock CreditNotesService — it's already a constructor dep).

### WP3 — Orders wiring: DTOs, module, create/edit/deliver hooks, findOne include + specs

- **files:** `apps/api/src/orders/dto/create-order.dto.ts`,
  `apps/api/src/orders/dto/create-sale.dto.ts`,
  `apps/api/src/orders/dto/update-order-items.dto.ts`,
  `apps/api/src/orders/orders.module.ts`,
  `apps/api/src/orders/orders.service.ts`,
  `apps/api/src/orders/orders.service.spec.ts`
- **brief:**

1. **DTO** — in `create-order.dto.ts` add + export (needs `IsArray`, `ArrayMaxSize`,
   `ValidateNested`, `IsString` from class-validator and `Type` from class-transformer —
   extend existing imports):

   ```ts
   export class AppliedCreditNoteDto {
     @IsString()
     creditNoteId!: string;

     /** Dollars to apply from this credit. Omit = up to the credit's remaining balance. */
     @IsOptional()
     @IsNumber()
     @Min(0.01)
     @Max(1_000_000)
     amount?: number;
   }
   ```

   and on `CreateOrderDto`, `CreateSaleDto` (import from create-order.dto), and
   `UpdateOrderItemsDto`:

   ```ts
   /** Credit notes to apply to this order's invoice(s). undefined = leave untouched;
    *  [] = remove all; otherwise the FULL desired set (server diffs). */
   @IsOptional()
   @IsArray()
   @ArrayMaxSize(50)
   @ValidateNested({ each: true })
   @Type(() => AppliedCreditNoteDto)
   appliedCreditNotes?: AppliedCreditNoteDto[];
   ```

2. **Module/DI** — `orders.module.ts`: add `CreditNotesModule` to imports (it exports
   CreditNotesService — same pattern InvoicesModule uses). `orders.service.ts` constructor:
   inject `private readonly creditNotes: CreditNotesService`.

3. **`create()`** (~1027): EARLY, right after the customer is resolved and before any stock
   mutation, validate:

   ```ts
   if (dto.appliedCreditNotes?.length) {
     await this.creditNotes.validateSelectionsForCustomer(
       this.prisma.forTenant(),
       customerId,
       dto.appliedCreditNotes,
     );
   }
   ```

   Then AFTER the order exists and any auto-merge resolution has produced the FINAL order id
   (the object the method will return — winner on the merge path), and after the
   invoice-mirror creation call if this path makes one, run:

   ```ts
   if (dto.appliedCreditNotes !== undefined) {
     await this.prisma.tenantTransaction(
       async (tx) => {
         await this.creditNotes.syncOrderCreditSelections(
           tx,
           finalOrderId,
           customerId,
           dto.appliedCreditNotes,
         );
         await this.creditNotes.settleOrderCreditsInTx(tx, finalOrderId);
       },
       { isolationLevel: "Serializable" },
     );
   }
   ```

   (Short, dedicated tx — NOT inside the stock/create transaction.) `createSale()` passes
   `appliedCreditNotes: dto.appliedCreditNotes` through to `create()` like discountAmount;
   the invoice-time settle hook (WP2) then applies them inside invoice creation, and this
   post-create block is a harmless idempotent no-op re-settle.

4. **`updateOrderItems()`** — after the existing invoice-reconcile routing block (~2515-2525:
   `resyncOrderInvoicesForEdit` / `reconcileOrderDraftInvoice` / the `hasPartialBilling` skip
   branch), ALWAYS run (covers the partial-billing skip too — credits still settle there):

   ```ts
   // Credit-note intents: sync operator selection changes, then settle (shrink or
   // top-up) against the order's current invoices. Runs even when line-resync was
   // skipped for partial billing — the credits are payment-level, not line-level.
   await this.prisma.tenantTransaction(
     async (tx) => {
       if (dto.appliedCreditNotes !== undefined) {
         await this.creditNotes.syncOrderCreditSelections(
           tx,
           orderId,
           order.customerId,
           dto.appliedCreditNotes,
         );
       }
       await this.creditNotes.settleOrderCreditsInTx(tx, orderId);
     },
     { isolationLevel: "Serializable" },
   );
   ```

   Staff-only: apply the same role gate as the shipping fee — when the caller is NOT
   OPERATOR/TENANT_ADMIN, treat `dto.appliedCreditNotes` as undefined (drivers/customers
   can't manage credits).

5. **`changeStatus()` DELIVERED branch** — after the reconcile/auto-create invoice work
   (both the awaited reconcile path and right after the fire-and-forget
   `createInvoiceFromOrderWithTenant` call — the latter settles inside invoice creation via
   the WP2 hook, so only the awaited-reconcile path needs it), add a best-effort settle:

   ```ts
   try {
     await this.prisma.tenantTransaction(
       async (tx) => {
         await this.creditNotes.settleOrderCreditsInTx(tx, id);
       },
       { isolationLevel: "Serializable" },
     );
   } catch (err) {
     // Delivery must not fail because a credit top-up hit contention — send()'s
     // auto-apply catches up. Money never moves twice (settle clamps).
     this.logger.warn(`Credit settle after delivery failed for order ${id}: ${err}`);
   }
   ```

6. **`findOne()` include** (~334): add

   ```ts
   orderCreditNotes: {
     include: {
       creditNote: {
         select: { id: true, creditNoteNumber: true, reason: true, amount: true, amountUsed: true, status: true, expiresAt: true },
       },
     },
   },
   ```

   and extend the existing `invoices` select with
   `payments: { where: { method: "CREDIT_NOTE", status: { not: "VOID" } }, select: { id: true, amount: true, creditNoteId: true } }`
   so clients can show per-credit applied dollars.

7. **Specs** (`orders.service.spec.ts`): create with `appliedCreditNotes` stores intent
   (sync+settle called with the created order id); create validates selections up-front
   (bad customer → throws before order creation); non-staff edit ignores
   `dto.appliedCreditNotes`; post-delivery edit path (partial-billing skip) still calls
   settle; changeStatus→DELIVERED settle failure is swallowed (warn) and does not throw.

### WP4 — Web UI

- **files:** `apps/web/lib/api/credit-notes.ts`, `apps/web/lib/api/orders.ts`,
  `apps/web/app/(dashboard)/orders/_components/CreditNotePicker.tsx` (new),
  `apps/web/app/(dashboard)/orders/_components/CreateOrderModal.tsx`,
  `apps/web/app/(dashboard)/orders/[id]/page.tsx`,
  `apps/web/app/(dashboard)/invoices/[id]/page.tsx`,
  `apps/web/app/(dashboard)/credit-notes/[id]/page.tsx`
- **brief:**

1. `lib/api/credit-notes.ts`: ensure the `useCreditNotes` params type accepts `customerId`
   (API supports it); add `useUnapplyCreditNote()` (POST `/credit-notes/${id}/unapply`
   `{invoiceId}`, invalidate `["credit-notes"]`, `["credit-note", id]`, `["invoices"]`,
   `["invoice", invoiceId]` — match the file's existing queryKey shapes) and
   `useUpdateCreditNote()` (PATCH `/credit-notes/${id}` `{reason?, expiresAt?}`).
   Export a small pure helper `openCreditBalance(cn) = roundMoney/Number(amount) − Number(amountUsed)`
   (match how the file handles money strings elsewhere; plain `Math.round(x*100)/100` is fine
   client-side — display only).
2. `lib/api/orders.ts`: add `appliedCreditNotes?: { creditNoteId: string; amount?: number }[]`
   to the create-order DTO, `CreateSaleDto`, and `useUpdateOrderItems` variables/body; add
   `orderCreditNotes?: Array<{ id: string; creditNoteId: string; amount?: number | string | null; creditNote?: { id: string; creditNoteNumber: string; reason?: string | null; amount: number | string; amountUsed: number | string; status: string } }>`
   to the `Order` interface (optional — additive).
3. **New `CreditNotePicker.tsx`** (client component, styled like the surrounding form
   sections): props `{ customerId: string | null; value: { creditNoteId: string; amount?: number }[]; onChange(next): void; estimatedOrderTotal?: number }`.
   Fetches `useCreditNotes({ customerId: customerId ?? undefined, limit: 100 })` gated on
   customerId (`enabled`-style guard matching the file's hooks; if the hook lacks an enabled
   option, fetch and render nothing when no customer). Rows = credits with open balance > 0
   OR already in `value` (so edit mode shows consumed selections). Each row: checkbox,
   `CN-#`, the reason (truncate w/ title), `$remaining available`, expiry hint when set, and
   when checked an optional "Amount" number input (placeholder "up to remaining"). Below:
   `Credits to apply at invoicing: −$X` and, when `estimatedOrderTotal` given,
   `Estimated balance due: $max(0, total − X)` — clearly display-only, NOT a discount (totals
   unchanged).
4. **`CreateOrderModal.tsx`**: render `<CreditNotePicker customerId={selectedCustomer?.id ?? null} …/>`
   in the totals/summary column (near the discount/shipping inputs); state
   `appliedCredits`; reset it when the customer changes; include
   `...(appliedCredits.length ? { appliedCreditNotes: appliedCredits } : {})` in BOTH the
   create-order payload and the bill-now/createSale payload. Persist into the parked-draft
   payload only if trivially easy; otherwise leave a `// not draft-persisted (see drafts.ts)`
   comment — do NOT let this expand scope.
5. **`orders/[id]/page.tsx`**:
   - Read mode: an "Applied credits" list in/under the totals card when
     `order.orderCreditNotes?.length`: per row `CN-# · reason · requested (or "up to
remaining") · applied $Y so far` where applied = Σ over `order.invoices[].payments`
     (CREDIT_NOTE, matching creditNoteId — WP3 adds this data).
   - Edit mode: the same `CreditNotePicker`, initialized from `order.orderCreditNotes`
     (map to `{creditNoteId, amount}`); a `creditsTouched` flag flips on first change; on
     save include `...(creditsTouched ? { appliedCreditNotes: editedCredits } : {})` in the
     updateItems payload — **in BOTH save paths** (`handleSaveItems` AND the DRAFT
     `saveThenPublish`), mirroring how `shippingFee` was threaded through both (that
     dual-path miss was a real bug last PR — do not repeat it).
6. **`invoices/[id]/page.tsx`**: payment-history rows with `method === "CREDIT_NOTE"` show a
   secondary line: the credit's reason (from `payment.creditNote.reason`) + a link to
   `/credit-notes/{payment.creditNote.id}` + an operator-only "Remove credit" button that
   confirms then calls `useUnapplyCreditNote` with `{invoiceId}`. Keep the existing
   exclusion of CREDIT_NOTE rows from the generic void/edit controls.
7. **`credit-notes/[id]/page.tsx`**: inline reason edit (pencil → input → save via
   `useUpdateCreditNote`; optimistic or invalidate — match page conventions). If the page
   shows `appliedToInvoiceId`, also list order links when present in the payload (skip if
   the API detail doesn't return them — do not add API surface here).

### WP5 — Mobile UI (operator only)

- **files:** `apps/mobile/lib/api/credit-notes.ts`, `apps/mobile/lib/api/orders.ts`,
  `apps/mobile/components/NewOrderScreen.tsx`,
  `apps/mobile/app/(operator)/(tabs)/orders/[id].tsx`,
  `apps/mobile/app/(operator)/(tabs)/invoices/[id].tsx`
- **effort:** low
- **brief:** Mirror web minimally:

1. `lib/api/credit-notes.ts`: `customerId` in list params; `useUnapplyCreditNote`;
   `CreditNote` type gains `amountUsed?`/`expiresAt?` if missing.
2. `lib/api/orders.ts`: `appliedCreditNotes?` on create/update payload types;
   `orderCreditNotes?` on the Order type (additive, same shape as web).
3. `NewOrderScreen.tsx`: an "Apply credit" section in the cart/summary area once a customer
   is selected — list open credits (reason + remaining) with check toggles (NO amount input
   on mobile v1 — null amount = up to remaining); include
   `...(selected.length ? { appliedCreditNotes: selected.map(id => ({ creditNoteId: id })) } : {})`
   in the submit payload. Reuse the screen's existing section/checkbox styling.
4. Operator order detail `orders/[id].tsx`: "Applied credits" rows (CN-#, reason, applied $
   from the invoices' CREDIT_NOTE payments when present in payload).
5. Operator invoice detail `invoices/[id].tsx`: CREDIT_NOTE payment rows show the reason
   line (data arrives via the shared `GET /invoices/:id`).
   Mobile EDIT-screen picker is deliberately DEFERRED (server preserves intents on edits —
   `undefined` = untouched), so `edit-items.tsx` is untouched.

## Acceptance criteria

1. `POST /orders` / `/orders/sell` / `PATCH /orders/:id/items` accept optional
   `appliedCreditNotes[{creditNoteId, amount?}]` (max 50, amount ≥ 0.01); invalid/cross-
   customer/VOID/expired selections are rejected before any mutation; fully-consumed
   re-submissions are accepted.
2. Money moves ONLY via `applyCreditInTx`/`restoreCreditFromPaymentInTx`; order and invoice
   totals are never changed by credit application; `amountUsed` and payment rows always
   agree (Σ non-VOID CREDIT_NOTE payments for a credit == its amountUsed).
3. A credit selected at order create is applied automatically when the order's invoice(s)
   materialize (sale mirror, delivery reconcile, manual generate) and shows immediately on a
   deliver-later DRAFT mirror.
4. Editing a delivered order: newly selected credits apply to the existing SENT/PARTIAL
   invoices; deselected credits un-apply and restore the wallet; an edit that shrinks the
   total below what credits covered gives the excess back (cash untouched); the
   partial-billing resync-skip path still settles credits.
5. `POST /credit-notes/:id/unapply {invoiceId}` restores the pair's dollars, reverts credit
   status, recomputes invoice status, and reduces/removes the order intent.
   `deletePayment`/`voidPayment` refuse CREDIT_NOTE payments.
6. `send`/`sendEmail`: a fully-pre-credited draft lands PAID (not stuck SENT); the
   oldest-first sweep skips explicit-amount selections; re-send applies nothing twice.
7. `CreditNote.reason` renders via relation on: web order detail, web invoice detail
   payment rows, invoice PDF payment history, mobile order + invoice detail — and a
   `PATCH /credit-notes/:id` reason edit is reflected on the next read of each without any
   copy/sync job.
8. Web create + edit flows expose the picker (customer-scoped, auto-populated); edit sends
   the full desired set only when touched, through BOTH save paths on the order page.
9. `npm run verify` green; no new deps; prisma mock extended once (WP1).

## Verification commands

- `npm run verify`

## Risks & rollback

- Serializable settle txs are short and run AFTER the main edit tx — contention surfaces as
  a retryable 500, never a half-applied credit (all-or-nothing per tx). changeStatus settle
  failure degrades to warn + send-time catch-up.
- The shrink pass touches only CREDIT_NOTE payments; cash/check are never auto-adjusted.
- `restoreCreditFromPaymentInTx` hard-deletes the payment row (house style — `deletePayment`
  does the same); the credit note itself remains the audit trail.
- Rollback: revert the app commit; the OrderCreditNote table is additive and inert unread.
