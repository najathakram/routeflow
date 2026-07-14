## Status

PLANNED — 2026-07-13

## Context

**P5-13 "Credits wallet + auto-apply oldest-first" [money-critical] — api + web** (mobile deferred to the P10 wave). Facts re-verified against source at HEAD `0e4024af`. Implementers: re-read the exact anchor lines before editing.

**Orchestrator validation (2026-07-13):** all money mechanics reviewed + the WP5 relation shapes verified against schema — `Return.order.lineItems`/`.invoices` are the correct relation names; `ReturnItem` has only `productId`/`qty` (no price → refund MUST derive from the order line); `OrderItem` has `qty`/`unitPrice`/`subtotal`; `Return.creditNoteId` exists (schema:2234). The `subtotal ÷ qty` refund derivation is boxed-safe. APPROVED.

**Three load-bearing findings this plan is built around:**

1. **The wallet balance DOUBLE-COUNTS today.** Both backend statement expressions — `getMyStatement` (`apps/api/src/customers/customers.service.ts:253-255`) and `getStatementForOperator` (`:621-623`, which also serves buyer `GET /buyer/statement` via `buyer.controller.ts:218-225`) — compute `availableCredit = Σ amount over status==="ISSUED"` and their selects (`:230`, `:578`) don't even fetch `amountUsed`. A partially-applied credit (status stays ISSUED until fully exhausted — `credit-notes.service.ts:374-383`) counts its FULL amount in the wallet AND already sits on the invoice as a `CREDIT_NOTE` `InvoicePayment` → the same dollars appear twice. The web Open-Credit tile (`credit-notes/page.tsx:459-460`) has the same flaw plus a phantom `DRAFT` status (API enum is `ISSUED|APPLIED|VOID`, schema:218-222). The fix everywhere is the canonical open-credit predicate: `status != VOID && (amount − amountUsed) > 0.001 && (expiresAt == null || expiresAt > now)`, balance `= Σ roundMoney(amount − amountUsed)`.
2. **There is no dispute entity.** "Approved dispute creates a credit" is NET-NEW, wired onto returns: `ReturnsService.processRefund` (`returns.service.ts:271-277`) is today just a `status → REFUNDED` flip with no money artifact. WP5 makes it create a store-credit `CreditNote` (lump-sum, NO line items — the regulated ledger was already reversed at `receive()` via `reverseReturnEntries`; a line-linked credit would double-reverse).
3. **Auto-apply is NET-NEW.** `CreditNotesService.issue()` is a no-op. "At issue" = the SENT flip, in exactly TWO places: `InvoicesService.send()` (`invoices.service.ts:1588-1605`) and `sendEmail()` (`:1608-1681`, SENT update at `:1669`) — neither transactional today. `sendReminder` (`:1684`) does NOT change status — untouched.

**Other verified facts:**

- `model CreditNote` (`schema.prisma:2038-2062`): `amount Decimal(10,2)`, `amountUsed Decimal @default(0)`, `status CreditNoteStatus @default(ISSUED)`, `invoiceId?` (SOURCE), `appliedToInvoiceId?` (set only when fully exhausted). **No `expiresAt/appliedAt/autoApplied`** — WP1 adds them. Latest migration `20260724000000_add_check_lifecycle`; ours `20260725000000_add_credit_wallet`.
- `applyToInvoice` (`credit-notes.service.ts:311-389`) is Serializable but **not roundMoney'd** (raw float min at :342) and sums ALL payments including `status=VOID` at :339 — a P5-12 bounced check (InvoicePayment.status VOID) would wrongly count as paid. WP2 fixes both.
- `CreditNotesService.recomputeStatus` at :38-56; `roundMoney` at `common/pricing.ts:28`; `tenantTransaction` auto-injects tenantId.
- `Return` has `creditNoteId String?` (schema:2234) — linkage, no schema change. `ReturnItem` = `productId` + `qty Decimal(10,3)` only. `OrderItem` = `qty`/`unitPrice`/`subtotal`. `Order` relations: `lineItems OrderItem[]` (:1185), `invoices Invoice[]` (:1188).
- **No NestJS cycle**: `CreditNotesModule` imports only Prisma/Gateways/Regulated + exports CreditNotesService; so `InvoicesModule → CreditNotesModule` (WP3) and `ReturnsModule → CreditNotesModule` (WP5) are plain imports — no forwardRef.
- **No `CreateCreditNoteDto` class** — controller takes `dto: any`. WP1 adds `expiresAt` to the service's inline dto type + validation (no new class).
- prisma-mock registers `creditNote`/`creditNoteItem`/`return`/`returnItem`/`invoicePayment` — confirm only. Specs constructing REAL services (get new provider stubs): `invoices.service.spec.ts:49-75` (only real InvoicesService), `returns-ledger.spec.ts:23-31` + `returns.security.spec.ts:108-117` (real ReturnsService), `credit-notes.service.spec.ts`, `customers.service.spec.ts`.
- Existing `send()` specs (`invoices.service.spec.ts:508-556`) mock `invoice.findUnique` without `total`/`payments` — auto-apply is written so `Number(undefined)=NaN → early return`, keeping them green with only a provider stub.

**Design decision (deviation flag):** `autoApplyOldestCreditsInTx` must be callable from InvoicesService → it is **public** on CreditNotesService (the low-level `applyCreditInTx` stays private). Money guards: every write via `roundMoney`; expiry is a computed filter (never a status flip, never claws back an InvoicePayment); auto-apply carries a running-balance clamp so it can NEVER over-apply even on a stale re-read; `AdvancePayment` stays separate; `CreditNoteItem`/regulated-ledger untouched.

**WP order:** WP1 → WP2 → WP3 → WP5; WP4 parallel after WP1; WP6 parallel after WP2; WP7 last. After WP1: `npx prisma generate` from `apps/api`, `git add -f` the migration.

## Acceptance

1. Migration `20260725000000_add_credit_wallet` applies (3 additive columns); generate + typecheck pass.
2. Sending an invoice auto-applies the customer's open non-expired credits OLDEST `createdAt` first, in ONE tx with the SENT flip; each creates a CREDIT_NOTE InvoicePayment, increments amountUsed, stamps appliedAt/autoApplied, flips to APPLIED only when exhausted, recomputes invoice status/paidAt. Re-send applies nothing.
3. An expired credit never auto-applies, is rejected by manual apply, excluded from every wallet — history + already-applied money untouched.
4. Wallet balance everywhere = `Σ roundMoney(amount − amountUsed)` over open non-expired notes — no partial credit counted twice.
5. `POST /returns/:id/refund` on a RECEIVED return flips REFUNDED AND creates an ISSUED store-credit for the return value (skip $0), linked via `Return.creditNoteId`; it then auto-applies at the next send.
6. Optional `expiresAt` on create (API + web); operator detail shows remaining/expiry/auto-applied; buyer finances shows a wallet tile + active credits.
7. Jest: new specs pass; credit-notes/invoices/customers/returns specs still compile + pass. Regulated reversal + AdvancePayment untouched.

## Work Packages

### WP1 — Schema: wallet fields + migration + service `expiresAt` intake

files:

- `apps/api/prisma/schema.prisma` (edit)
- `apps/api/prisma/migrations/20260725000000_add_credit_wallet/migration.sql` (new)
- `apps/api/src/credit-notes/credit-notes.service.ts` (edit — create() dto + persist)

brief: Three additive columns; migration sorts after `20260724000000_add_check_lifecycle`; accept+validate an optional `expiresAt` ISO in `create()`. prisma-mock confirm-only. `npx prisma generate` from apps/api; `git add -f` the migration.

**1. schema.prisma — inside `model CreditNote`, after `appliedToInvoiceId String?`:**

```prisma
  // P5-13 credits wallet: optional expiry, first-application stamp, and whether any
  // application was automatic. "Expired" is a COMPUTED FILTER in code (excluded from
  // the wallet, never auto-applies) — NEVER a status flip; an expired note keeps its
  // amountUsed / already-issued InvoicePayments untouched.
  expiresAt          DateTime?
  appliedAt          DateTime?
  autoApplied        Boolean          @default(false)
```

**2. `migrations/20260725000000_add_credit_wallet/migration.sql`:**

```sql
-- P5-13: credits wallet — expiry + application audit on CreditNote. Additive only:
-- three nullable/defaulted columns, no data rewrite. "Expired" is a computed filter
-- in application code (never a status flip), so no backfill is needed.
ALTER TABLE "CreditNote" ADD COLUMN "expiresAt" TIMESTAMP(3);
ALTER TABLE "CreditNote" ADD COLUMN "appliedAt" TIMESTAMP(3);
ALTER TABLE "CreditNote" ADD COLUMN "autoApplied" BOOLEAN NOT NULL DEFAULT false;
```

**3. `credit-notes.service.ts` — `create()`** (no DTO class; controller passes `dto: any`):
3a. Extend the inline dto type — add after `reason?: string;`:

```ts
    /** P5-13: optional ISO date after which this credit is excluded from the wallet and can never apply. */
    expiresAt?: string;
```

3b. After the amount guard (`if (!dto.amount || dto.amount <= 0) …`), insert:

```ts
// P5-13: optional expiry. Reject garbage and already-past dates at intake.
let expiresAt: Date | null = null;
if (dto.expiresAt != null && dto.expiresAt !== "") {
  expiresAt = new Date(dto.expiresAt);
  if (isNaN(expiresAt.getTime()))
    throw new BadRequestException("expiresAt must be a valid ISO date");
  if (expiresAt.getTime() <= Date.now())
    throw new BadRequestException("expiresAt must be in the future");
}
```

3c. In the `tx.creditNote.create` data block, after `status: "ISSUED",` add `expiresAt,`.

### WP2 — API: tx-safe `applyCreditInTx` helper + `applyToInvoice` delegates (roundMoney everywhere)

files:

- `apps/api/src/credit-notes/credit-notes.service.ts` (edit)
- `apps/api/src/credit-notes/credit-notes.service.spec.ts` (edit — new describe appended)

brief: Extract the money core of `applyToInvoice` into a private in-tx helper that roundMoney's every figure, EXCLUDES VOID payments (P5-12 bounced checks) from the paid-sum, stamps appliedAt/autoApplied, returns `{applied, invoiceStatus}` (auto skips on 0; manual throws). Manual `applyToInvoice` keeps its own Serializable tx, all guards, throw-on-zero, and its include shape.

**1. Insert the helper between `issue()` and `applyToInvoice`:**

```ts
  /**
   * P5-13: the single tx-safe primitive that applies (part of) a credit note to an
   * invoice. Runs INSIDE an already-open tenant transaction `tx` — never opens its
   * own. Every monetary figure via roundMoney. Returns {applied:0} instead of
   * throwing so the auto-apply loop can skip; the manual path throws on 0 itself.
   * Callers pre-filter VOID + expired credits (expiry is a computed filter).
   */
  private async applyCreditInTx(
    tx: any,
    cn: {
      id: string;
      creditNoteNumber: string;
      amount: unknown;
      amountUsed: unknown;
      appliedToInvoiceId: string | null;
      appliedAt?: Date | null;
      autoApplied?: boolean;
    },
    inv: {
      id: string;
      total: unknown;
      dueDate: Date | null;
      status: InvoiceStatus;
      payments?: Array<{ amount: unknown; status?: string }>;
    },
    requestedAmount?: number,
    opts?: { autoApplied?: boolean },
  ): Promise<{ applied: number; invoiceStatus: InvoiceStatus | null }> {
    const remaining = roundMoney(Number(cn.amount) - Number(cn.amountUsed));
    // P5-12: a bounced check flips its InvoicePayment to VOID — must NOT count as
    // paid, so the credit can correctly cover the re-opened balance.
    const alreadyPaid = roundMoney(
      (inv.payments ?? [])
        .filter((p) => p.status !== "VOID")
        .reduce((s, p) => s + Number(p.amount), 0),
    );
    const invoiceBalance = roundMoney(Number(inv.total) - alreadyPaid);
    const applyAmount = roundMoney(
      Math.min(remaining, invoiceBalance, requestedAmount ?? Infinity),
    );
    // `!(x > 0.001)` (not `x <= 0.001`) so NaN from malformed data also bails out.
    if (!(applyAmount > 0.001)) return { applied: 0, invoiceStatus: null };

    // The credit consumes invoice balance as a payment — the ONLY place a credit
    // reduces an invoice, and amountUsed below removes the same dollars from the
    // wallet (Σ amount − amountUsed). One or the other, never both.
    await tx.invoicePayment.create({
      data: {
        invoiceId: inv.id,
        amount: applyAmount,
        method: PaymentMethod.CREDIT_NOTE,
        creditNoteId: cn.id,
        reference: cn.creditNoteNumber,
      },
    });

    const newPaid = roundMoney(alreadyPaid + applyAmount);
    const newStatus = this.recomputeStatus(newPaid, Number(inv.total), inv.dueDate, inv.status);
    await tx.invoice.update({
      where: { id: inv.id },
      data: { status: newStatus, paidAt: newStatus === InvoiceStatus.PAID ? new Date() : null },
    });

    const newAmountUsed = roundMoney(Number(cn.amountUsed) + applyAmount);
    const fullyApplied = newAmountUsed >= Number(cn.amount) - 0.001;
    await tx.creditNote.update({
      where: { id: cn.id },
      data: {
        amountUsed: newAmountUsed,
        status: fullyApplied ? "APPLIED" : "ISSUED",
        appliedToInvoiceId: fullyApplied ? inv.id : cn.appliedToInvoiceId,
        appliedAt: cn.appliedAt ?? new Date(),
        autoApplied: opts?.autoApplied ? true : (cn.autoApplied ?? false),
      },
    });

    return { applied: applyAmount, invoiceStatus: newStatus };
  }
```

**2. Replace the body of `applyToInvoice` with:**

```ts
  async applyToInvoice(creditNoteId: string, invoiceId: string, amount?: number) {
    return this.prisma.tenantTransaction(
      async (tx) => {
        const cn = await tx.creditNote.findUnique({ where: { id: creditNoteId } });
        if (!cn || cn.status === "APPLIED" || cn.status === "VOID")
          throw new BadRequestException("Credit note is not available for application");
        if (cn.expiresAt && new Date(cn.expiresAt) <= new Date())
          throw new BadRequestException("Credit note has expired");

        const inv = await tx.invoice.findUnique({
          where: { id: invoiceId },
          include: { payments: true },
        });
        if (!inv) throw new NotFoundException("Invoice not found");

        const notApplicableStatuses: InvoiceStatus[] = [
          InvoiceStatus.PAID,
          InvoiceStatus.VOID,
          InvoiceStatus.WRITTEN_OFF,
        ];
        if (notApplicableStatuses.includes(inv.status)) {
          throw new BadRequestException(
            `Cannot apply credit note to invoice with status ${inv.status}`,
          );
        }
        if (cn.customerId !== inv.customerId) {
          throw new BadRequestException("Credit note and invoice belong to different customers");
        }

        const { applied } = await this.applyCreditInTx(tx, cn, inv, amount);
        if (applied <= 0)
          throw new BadRequestException(
            "Credit note has no remaining balance or invoice is fully paid",
          );

        return tx.invoice.findUnique({
          where: { id: invoiceId },
          include: {
            customer: { select: { id: true, businessName: true } },
            items: true,
            payments: { orderBy: { createdAt: "desc" } },
          },
        });
      },
      { isolationLevel: "Serializable" },
    );
  }
```

**3. Append a new top-level describe to `credit-notes.service.spec.ts`** covering: partial apply roundMoney'd + VOID excluded + stays ISSUED + appliedAt stamped; full exhaustion → APPLIED + appliedToInvoiceId + invoice PAID; reject EXPIRED; auto-apply oldest-first with 2nd credit clamped to remaining + autoApplied stamped + `orderBy createdAt asc` asserted; auto-apply skips exhausted + the `where.OR` expiry predicate asserted; idempotent re-send (PAID invoice → credits not fetched). (Full spec bodies as authored — implement at the mock boundary.)

### WP3 — API: `autoApplyOldestCreditsInTx` + hook `send()`/`sendEmail()`

files:

- `apps/api/src/credit-notes/credit-notes.service.ts` (edit — new PUBLIC method)
- `apps/api/src/invoices/invoices.service.ts` (edit — imports, constructor, send, sendEmail)
- `apps/api/src/invoices/invoices.module.ts` (edit — import CreditNotesModule)
- `apps/api/src/invoices/invoices.service.spec.ts` (edit — provider stub)

**1. `credit-notes.service.ts` — insert AFTER `applyCreditInTx` (before `applyToInvoice`):**

```ts
  /**
   * P5-13: auto-apply the customer's OPEN, non-expired credits — OLDEST createdAt
   * first — to one invoice, inside the caller's transaction (InvoicesService wraps
   * this with its SENT flip). Idempotent: a re-send finds the balance covered or
   * credits exhausted and applies nothing.
   * Canonical open predicate: status != VOID && (amount − amountUsed) > 0.001 &&
   * (expiresAt == null || expiresAt > now). Prisma can't compare two columns, so
   * the remaining>0 half is evaluated in JS; status/expiry go into the query.
   */
  async autoApplyOldestCreditsInTx(
    tx: any,
    invoiceId: string,
    customerId: string,
  ): Promise<{ applied: number; invoiceStatus: InvoiceStatus | null }> {
    const nothing: { applied: number; invoiceStatus: InvoiceStatus | null } = {
      applied: 0,
      invoiceStatus: null,
    };
    if (!invoiceId || !customerId) return nothing;

    const first = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: { payments: true },
    });
    if (!first) return nothing;
    const paid = roundMoney(
      (first.payments ?? [])
        .filter((p: any) => p.status !== "VOID")
        .reduce((s: number, p: any) => s + Number(p.amount), 0),
    );
    let running = roundMoney(Number(first.total) - paid);
    if (!(running > 0.001)) return nothing;

    const now = new Date();
    const candidates = await tx.creditNote.findMany({
      where: {
        customerId,
        status: { not: "VOID" },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: { createdAt: "asc" },
    });
    const open = (candidates ?? []).filter(
      (c: any) => roundMoney(Number(c.amount) - Number(c.amountUsed)) > 0.001,
    );
    if (open.length === 0) return nothing;

    let totalApplied = 0;
    let invoiceStatus: InvoiceStatus | null = null;
    let inv = first;
    for (const cn of open) {
      if (!(running > 0.001)) break;
      // `running` as the requested amount = a hard clamp; over-applying is
      // impossible even if the invoice re-read were stale.
      const res = await this.applyCreditInTx(tx, cn, inv, running, { autoApplied: true });
      if (res.applied <= 0) break;
      running = roundMoney(running - res.applied);
      totalApplied = roundMoney(totalApplied + res.applied);
      invoiceStatus = res.invoiceStatus;
      const next = await tx.invoice.findUnique({
        where: { id: invoiceId },
        include: { payments: true },
      });
      if (next) inv = next;
    }
    return { applied: totalApplied, invoiceStatus };
  }
```

**2. `invoices.service.ts`:**
2a. Import after the `AuthorizationGuardService` import: `import { CreditNotesService } from "../credit-notes/credit-notes.service";`
2b. Constructor — add last param: `private readonly creditNotes: CreditNotesService,`
2c. Replace `send()`:

```ts
  async send(id: string) {
    const inv = await this.findOneOrThrow(id);
    if (inv.status === InvoiceStatus.VOID)
      throw new BadRequestException("Cannot send a voided invoice");
    await this.assertOrderInvoiceUnlocked(inv);
    // P5-13: SENT flip + oldest-first credit auto-apply are ONE atomic operation.
    // Idempotent on re-send. If the tx throws, the send fails — money first.
    const { updated, auto } = await this.prisma.tenantTransaction(
      async (tx) => {
        const updated = await tx.invoice.update({
          where: { id },
          data: { status: InvoiceStatus.SENT, sentAt: new Date() },
        });
        const auto = await this.creditNotes.autoApplyOldestCreditsInTx(tx, id, updated.customerId);
        return { updated, auto };
      },
      { isolationLevel: "Serializable" },
    );
    this.gateway.emitInvoiceUpdated(this.prisma.getTenantId(), {
      invoiceId: updated.id,
      invoiceNumber: updated.invoiceNumber,
      customerId: updated.customerId,
      status: auto.invoiceStatus ?? InvoiceStatus.SENT,
      total: Number(updated.total),
    });
    if (auto.applied > 0) {
      const final = await this.prisma.forTenant().invoice.findUnique({ where: { id } });
      if (final) return final;
    }
    return updated;
  }
```

2d. In `sendEmail()`, replace ONLY the "Mark as SENT" block (the `invoice.update` + `emitInvoiceUpdated`; the `return { success … }` stays) with the same tx wrapper as 2c (updated + auto, emit with `auto.invoiceStatus ?? SENT`). Keep the PDF/email I/O ABOVE, outside the tx.

**3. `invoices.module.ts` — import `CreditNotesModule` and append to `imports`.** (Acyclic — verified.)

**4. `invoices.service.spec.ts` — add the import + provider stub:**

```ts
        {
          provide: CreditNotesService,
          useValue: {
            autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, invoiceStatus: null }),
          },
        },
```

### WP4 — API: wallet-balance double-count fix (customers.service ×4 sites)

files:

- `apps/api/src/customers/customers.service.ts` (edit)
- `apps/api/src/customers/customers.service.spec.ts` (edit — new describe)

brief: Both statements fetch `amountUsed`+`expiresAt`, compute `availableCredit = Σ roundMoney(amount − amountUsed)` over the canonical open predicate, and report remaining (not face) per credit transaction — also exposing `expiresAt` on CREDIT_NOTE transactions for the buyer wallet list. `advanceBalance` stays SEPARATE.

**1. Import after PrismaService import:** `import { roundMoney } from "../common/pricing";`
**2. `getMyStatement` — creditNote select** → add `amountUsed: true, expiresAt: true` (keep id/creditNoteNumber/amount/status/createdAt).
**3. `getMyStatement` — availableCredit:**

```ts
// P5-13: wallet = Σ remaining over OPEN, non-expired credits. amount − amountUsed
// (not face amount) prevents the double-count — a partial credit already sits on
// the invoice as a CREDIT_NOTE payment, so only its unused remainder appears here.
const now = new Date();
const availableCredit = roundMoney(
  creditNotes
    .filter(
      (c) =>
        c.status !== "VOID" &&
        Number(c.amount) - Number(c.amountUsed) > 0.001 &&
        (!c.expiresAt || new Date(c.expiresAt) > now),
    )
    .reduce((sum, c) => sum + roundMoney(Number(c.amount) - Number(c.amountUsed)), 0),
);
```

**4. `getMyStatement` — credit-note transactions map:**

```ts
      ...creditNotes.map((c) => {
        const expired = !!c.expiresAt && new Date(c.expiresAt) <= now;
        const remaining =
          c.status === "VOID" || expired ? 0 : roundMoney(Number(c.amount) - Number(c.amountUsed));
        return {
          type: "CREDIT_NOTE" as const,
          id: c.id,
          description: `Credit Note #${c.creditNoteNumber}`,
          date: c.createdAt.toISOString(),
          amount: -Number(c.amount),
          runningBalance: remaining > 0.001 ? remaining : 0,
          status: c.status,
          expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
        };
      }),
```

**5-7. `getStatementForOperator` — the IDENTICAL three edits** (select, availableCredit, transactions map). This method has NO `const now` — declare `const now = new Date();` once before the availableCredit block. Do NOT touch `advanceBalance`/`pendingOrdersAmount`.
**8. Append a `describe("P5-13 — statement wallet balance (no double-count)")` to `customers.service.spec.ts`** asserting availableCredit=70 for the mixed set (60 open + exhausted + expired + void + 10 open) and expired shows runningBalance 0.

### WP5 — API: dispute→credit (`returns.processRefund` creates a store credit)

files:

- `apps/api/src/returns/returns.service.ts` (edit)
- `apps/api/src/returns/returns.module.ts` (edit)
- `apps/api/src/returns/returns-ledger.spec.ts` (edit — provider stub)
- `apps/api/src/returns/returns.security.spec.ts` (edit — provider stub)
- `apps/api/src/returns/returns-refund.spec.ts` (new)

brief: After the REFUNDED flip, create a lump-sum ISSUED CreditNote via `CreditNotesService.create` (own Serializable tx — call SEQUENTIALLY, not nested) linked via `Return.creditNoteId`. NO line items (ledger already reversed at receive). $0 skips. Refund value = `Σ item.qty × (orderLine.subtotal ÷ orderLine.qty)` (boxed-safe; fallback unitPrice when qty 0). Single source invoice → pass as `invoiceId` (engages the cumulative over-credit cap); 0 or 2+ → standalone.

**1. Imports + constructor:** `import { CreditNotesService } from "../credit-notes/credit-notes.service";` + `import { roundMoney } from "../common/pricing";` + constructor `private readonly creditNotes: CreditNotesService,`.
**2. Replace `processRefund`:**

```ts
  async processRefund(id: string) {
    const ret = await this.prisma.forTenant().return.findUnique({
      where: { id },
      include: {
        items: true,
        order: {
          select: {
            orderNumber: true,
            invoices: { select: { id: true } },
            lineItems: { select: { productId: true, qty: true, unitPrice: true, subtotal: true } },
          },
        },
      },
    });
    if (!ret) throw new NotFoundException("Return not found");
    if (ret.status !== "RECEIVED")
      throw new BadRequestException("Only RECEIVED returns can be refunded");

    // Refund value = Σ returned qty × the order line's EFFECTIVE per-unit price
    // (subtotal ÷ qty — robust to box-priced lines where unitPrice is per box while
    // qty is pieces). Items not on the order contribute 0.
    let refundAmount = 0;
    for (const item of ret.items ?? []) {
      const line = ret.order?.lineItems?.find((li) => li.productId === item.productId);
      if (!line) continue;
      const lineQty = Number(line.qty);
      const perUnit = lineQty > 0 ? Number(line.subtotal) / lineQty : Number(line.unitPrice);
      refundAmount += Number(item.qty) * perUnit;
    }
    refundAmount = roundMoney(refundAmount);

    const updated = await this.prisma
      .forTenant()
      .return.update({ where: { id }, data: { status: "REFUNDED" } });

    if (refundAmount <= 0.001) return updated;

    // Sequential, NOT nested: create() opens its own Serializable tx and books NO
    // regulated reversal for a lump-sum credit (no items) — the returned regulated
    // goods were already reversed at receive(). Single source invoice engages the cap.
    const invoices = ret.order?.invoices ?? [];
    const cn = await this.creditNotes.create({
      customerId: ret.customerId,
      invoiceId: invoices.length === 1 ? invoices[0].id : undefined,
      amount: refundAmount,
      reason: `Refund for return ${ret.returnNumber ?? ret.id.slice(0, 8)}`,
    });
    await this.prisma.forTenant().return.update({ where: { id }, data: { creditNoteId: cn.id } });

    return { ...updated, creditNoteId: cn.id };
  }
```

**3. `returns.module.ts` — import `CreditNotesModule`, add to imports.** (No cycle.)
**4. `returns-ledger.spec.ts` + `returns.security.spec.ts` — add the CreditNotesService `create` stub provider.**
**5. New `returns-refund.spec.ts`** covering: creates lump-sum credit for `Σ qty × (subtotal/qty)` (=20 for 2×(100/10), NOT 2×unitPrice) with `invoiceId:"inv-1"` + no `items`, links `creditNoteId` on the return; omits invoiceId with 2+ invoices; $0 (no items) skips create but flips REFUNDED; non-RECEIVED rejects before money math.

### WP6 — Web: credit-notes type/list/detail + buyer finances wallet tile (briefs w/ anchors)

files:

- `apps/web/lib/api/credit-notes.ts` (edit)
- `apps/web/app/(dashboard)/credit-notes/page.tsx` (edit)
- `apps/web/app/(dashboard)/credit-notes/[id]/page.tsx` (edit)
- `apps/web/lib/api/buyer.ts` (edit)
- `apps/web/app/buyer/portal/[seller]/finances/page.tsx` (edit)

brief: Carry the new fields in the web type (`amountUsed`, `expiresAt?`, `appliedAt?`, `autoApplied?`; demote `issueDate`/`notes` to optional, keep the `DRAFT` union member — minimal reconciliation, do NOT rip out branches); Open-Credit tile → expiry-aware remaining `Σ(amount − amountUsed)` over non-VOID non-expired remaining>0; create modal → optional "Expires (optional)" date input + `expiresAt` in the payload; detail page → remaining `= amount − amountUsed`, `isExpired` flag, an "Auto-applied" pill + "Expired" danger pill, an "Applied"/"Remaining"/"Expires" summary rows, and gate both Apply-to-Invoice buttons behind `!isExpired`. Buyer: add `BuyerStatement`/`BuyerStatementTransaction` types + `useBuyerStatement()` (`GET /buyer/statement`) to `buyer.ts`; on the finances page add a fifth "Store Credit" StatCard (`icon=Wallet`, `value=statement?.availableCredit`) and a lean "Active Credits" card listing `transactions.filter(type==="CREDIT_NOTE" && runningBalance>0)` with remaining + expiry (cap 6). Do NOT gate the page's load/error on the statement hook. (Full exact snippets as authored.)

### WP7 — Code-map update

files: `.claude/code-map/api.md`, `.claude/code-map/web.md`, `.claude/code-map/_meta.json`

brief: `CreditNote` new fields + canonical open-credit predicate; `applyCreditInTx` (private, tx-safe, roundMoney'd, VOID-aware) + `autoApplyOldestCreditsInTx` (public, oldest-first, running-balance clamp, idempotent); `send/sendEmail` now atomic SENT-flip + auto-apply (Serializable) + new CreditNotesService dep; `CustomersService` statements expiry/used-aware (`availableCredit = Σ remaining`) + CREDIT_NOTE tx expose `expiresAt`; `ReturnsService.processRefund` mints lump-sum store credit (subtotal÷qty, `Return.creditNoteId`, new dep); web `CreditNote` type + buyer `useBuyerStatement` + finances wallet tile; module edges `InvoicesModule/ReturnsModule → CreditNotesModule` (acyclic). Bump \_meta generatedAt + prepend a P5-13 note.

### Implementer flags (double-check before coding)

- WP5 refund derivation `subtotal ÷ qty` vs `unitPrice` — VERIFIED boxed-safe by orchestrator; still confirm OrderItem semantics.
- WP5 half-state edge: REFUNDED flip succeeds but `create()` cap-rejects → 400, no credit; deliberate (visible + manually fixable beats silent over-credit).
- WP3 deviation: `autoApplyOldestCreditsInTx` is PUBLIC (required for the cross-service call).
- No `CreateCreditNoteDto` class — `expiresAt` validated in the service.
- Only `invoices.service.spec.ts` builds the real InvoicesService; only the two returns specs build the real ReturnsService — the ONLY spec provider lists to touch.

### Critical Files

- apps/api/src/credit-notes/credit-notes.service.ts
- apps/api/src/invoices/invoices.service.ts
- apps/api/src/customers/customers.service.ts
- apps/api/src/returns/returns.service.ts
- apps/api/prisma/schema.prisma
