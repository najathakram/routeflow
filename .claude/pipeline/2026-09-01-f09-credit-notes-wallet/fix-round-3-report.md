# F09 · Fix-round 3 report (Sonnet, 2026-09-06) — api money findings

Worktree `C:/ClaudeCode/routeflow/.claude/worktrees/rf-F09`, branch `fix/F09-credit-notes-wallet`,
base HEAD `5c0dc464`. Implemented A2, A5, A6, A7, A9, A11 per `fix-round-3-ruling.md`. Did **not**
touch A1/A3/A4/A10/C4/C5 (out of scope for this round) or any `apps/web/**` /
`apps/api/scripts/**` path (owned by the parallel lens-B fixer). No commit made.

## A2 — `processRefund` no longer throws after the REFUNDED claim commits

**File:** `apps/api/src/returns/returns.service.ts` — scoped the order's invoice select to live
sources (`CREDIT_SOURCE_EXCLUDED`, imported from `../invoices/invoice-status-sets`) so a
VOID/WRITTEN_OFF sole invoice now yields zero live invoices, which falls into the existing
"2+ invoices" ternary branch (`invoiceId: undefined`) instead of reaching `create()`'s guard
_after_ the atomic RECEIVED→REFUNDED claim has already committed.

```diff
diff --git a/apps/api/src/returns/returns.service.ts b/apps/api/src/returns/returns.service.ts
index d3a53136..e19cf02a 100644
--- a/apps/api/src/returns/returns.service.ts
+++ b/apps/api/src/returns/returns.service.ts
@@ -20,6 +20,7 @@ import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
 import { CreditNotesService } from "../credit-notes/credit-notes.service";
 import { roundMoney } from "@routeflow/pricing";
 import type { ProcessRefundDto } from "./dto/process-refund.dto";
+import { CREDIT_SOURCE_EXCLUDED } from "../invoices/invoice-status-sets";

 @Injectable()
 export class ReturnsService {
@@ -315,7 +316,15 @@ export class ReturnsService {
         order: {
           select: {
             orderNumber: true,
-            invoices: { select: { id: true } },
+            // Live sources only (F09 A2): an unfiltered select let a VOID/WRITTEN_OFF
+            // sole invoice reach create()'s CREDIT_SOURCE_EXCLUDED guard, which threw
+            // AFTER the RECEIVED->REFUNDED claim below had already committed — losing
+            // the refund with no recovery path. Zero live invoices now falls into the
+            // same "2+ invoices" ternary branch below and mints the credit UNSOURCED.
+            invoices: {
+              where: { status: { notIn: CREDIT_SOURCE_EXCLUDED } },
+              select: { id: true },
+            },
             lineItems: { select: { productId: true, qty: true, unitPrice: true, subtotal: true } },
           },
         },
```

**Test added** (`apps/api/src/returns/returns-refund.spec.ts`, mirrors the existing harness's
`createMockPrisma()` + module setup): title
`"F09 A2: refund against a voided source mints an unsourced credit note"`. Simulates the
live-source filter by returning `order.invoices: []` (as the DB would after excluding the sole
VOID invoice); asserts `creditNotesCreate` is called once with `dto.invoiceId === undefined`,
`processRefund` resolves without throwing, `return.update` is called with `creditNoteId: "cn-12"`,
and `result.creditNoteId === "cn-12"`.

```diff
diff --git a/apps/api/src/returns/returns-refund.spec.ts b/apps/api/src/returns/returns-refund.spec.ts
index c9de5e1d..9d317257 100644
--- a/apps/api/src/returns/returns-refund.spec.ts
+++ b/apps/api/src/returns/returns-refund.spec.ts
@@ -120,6 +120,45 @@ describe("ReturnsService.processRefund → dispute creates a store credit (P5-13
     expect(dto.invoiceId).toBeUndefined();
   });

+  it("F09 A2: refund against a voided source mints an unsourced credit note", async () => {
+    // The order's only invoice was VOID. The live-source select (CREDIT_SOURCE_EXCLUDED)
+    // filters it out at the DB, so `order.invoices` comes back empty here — exactly like
+    // the pre-fix code otherwise reaching create()'s guard AFTER the RECEIVED->REFUNDED
+    // claim already committed, which threw and lost the refund with no recovery path.
+    // With the fix, zero live invoices takes the same branch as 2+ invoices: undefined
+    // invoiceId, credit minted unsourced, and processRefund resolves normally.
+    prisma.return.findUnique.mockResolvedValue({
+      id: "ret-12",
+      returnNumber: "RET-2026-012",
+      status: "RECEIVED",
+      customerId: "cust-1",
+      items: [{ productId: "p1", qty: 2 }],
+      order: {
+        orderNumber: "ORD-012",
+        invoices: [], // the sole invoice was VOID and excluded by the live-source filter
+        lineItems: [{ productId: "p1", qty: 10, unitPrice: 15, subtotal: 100 }],
+      },
+    });
+    prisma.return.updateMany.mockResolvedValue({ count: 1 });
+    prisma.return.update.mockResolvedValue({
+      id: "ret-12",
+      status: "REFUNDED",
+      creditNoteId: "cn-12",
+    });
+    creditNotesCreate.mockResolvedValue({ id: "cn-12", creditNoteNumber: "CN-2026-0012" });
+
+    const result = await service.processRefund("ret-12");
+
+    expect(creditNotesCreate).toHaveBeenCalledTimes(1);
+    const dto = creditNotesCreate.mock.calls[0][0];
+    expect(dto.invoiceId).toBeUndefined();
+    expect(prisma.return.update).toHaveBeenCalledWith({
+      where: { id: "ret-12" },
+      data: { creditNoteId: "cn-12" },
+    });
+    expect(result.creditNoteId).toBe("cn-12");
+  });
+
   it("skips credit creation for a $0 refund (no matching items) but still flips REFUNDED", async () => {
```

## A5 — `voidInvoice`'s transaction now runs Serializable, matching the orders-side caller

**File:** `apps/api/src/invoices/invoices.service.ts` — added
`{ isolationLevel: "Serializable", timeout: 15_000 }` as the second argument to
`this.prisma.tenantTransaction(...)` in `voidInvoice`, exactly mirroring the options object read
from `orders.service.ts:2770` (`orders.service.ts`'s per-invoice void loop). Closes the window
between the cap's `findMany`/`update` pair where a concurrent `applyToInvoice` /
`settleOrderCreditsInTx` on a different invoice (default READ COMMITTED, no row lock on
`CreditNote`) could raise a note's `amountUsed`, letting the blind full-column cap write land at
`amount < amountUsed`.

Confirmed the test mock tolerates the extra argument before making the change:
`apps/api/src/testing/prisma-mock.ts`'s `tenantTransaction: jest.fn((fn: any) => fn({...}))`
ignores every argument after `fn`, so no mock update was needed. Also grepped
`invoices.service.spec.ts` for `tenantTransaction.*toHaveBeenCalledWith` — no hits, so no test
asserts on the transaction's call args either.

```diff
diff --git a/apps/api/src/invoices/invoices.service.ts b/apps/api/src/invoices/invoices.service.ts
index d6cccdcc..cb2fe542 100644
--- a/apps/api/src/invoices/invoices.service.ts
+++ b/apps/api/src/invoices/invoices.service.ts
@@ -3900,12 +3900,20 @@ export class InvoicesService {
     // an order, it should be possible to split it into multiple invoices"
     // scenario. The auto-create-on-DELIVERED captured all remaining qty; voiding
     // releases it so a fresh split can run.
-    return this.prisma.tenantTransaction(async (tx) => {
-      // Wallet money first: a credit applied to this invoice goes back to its note
-      // (spendable again) instead of being stranded on a dead invoice.
-      await this.releaseWalletPaymentsInTx(tx, id);
-      return this.voidInvoiceInTx(tx, id, inv.orderId);
-    });
+    return this.prisma.tenantTransaction(
+      async (tx) => {
+        // Wallet money first: a credit applied to this invoice goes back to its note
+        // (spendable again) instead of being stranded on a dead invoice.
+        await this.releaseWalletPaymentsInTx(tx, id);
+        return this.voidInvoiceInTx(tx, id, inv.orderId);
+      },
+      // Serializable, matching the orders-side void caller (orders.service.ts ~:2770):
+      // the default READ COMMITTED left a window between the cap's findMany/update pair
+      // (below, in voidInvoiceInTx) where a concurrent applyToInvoice/settleOrderCreditsInTx
+      // on a different invoice could raise a note's amountUsed, so the blind full-column
+      // cap write could land at amount < amountUsed (F09 A5).
+      { isolationLevel: "Serializable", timeout: 15_000 },
+    );
   }
```

No test change was needed or made for A5 (the ruling only asked to verify `voidInvoice` cases
still pass — they do, see gate results below).

## A6 — the fifth hand-rolled status filter re-pointed at `CREDIT_NOT_APPLICABLE`

**File:** `apps/api/src/customers/customers.service.ts` — confirmed the literal
`["PAID", "VOID", "WRITTEN_OFF"]` at line 1177 is byte-identical (same three values, same order)
to `CREDIT_NOT_APPLICABLE` in `apps/api/src/invoices/invoice-status-sets.ts`, then re-pointed it.
Behaviour-neutral.

```diff
diff --git a/apps/api/src/customers/customers.service.ts b/apps/api/src/customers/customers.service.ts
index 3b3210c1..01215542 100644
--- a/apps/api/src/customers/customers.service.ts
+++ b/apps/api/src/customers/customers.service.ts
@@ -16,6 +16,7 @@ import { CommissionEngineService } from "../sales-agents/commission-engine.servi
 import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
 import { roundMoney } from "@routeflow/pricing";
 import { CONFIRMED_PAYMENT } from "../invoices/payment-predicates";
+import { CREDIT_NOT_APPLICABLE } from "../invoices/invoice-status-sets";
 import { geocodeAddress, GeocodableAddress, GeocodeCoords } from "../common/geocode.util";
 import { StorageService } from "../storage/storage.service";
 import { compressDocument } from "../storage/compress.util";
@@ -1174,7 +1175,7 @@ export class CustomersService {
         include: { payments: true },
       });
       if (!inv) throw new NotFoundException("Invoice not found");
-      if (["PAID", "VOID", "WRITTEN_OFF"].includes(inv.status)) {
+      if (CREDIT_NOT_APPLICABLE.includes(inv.status)) {
         throw new BadRequestException(
           `Cannot apply advance payment to invoice with status ${inv.status}`,
         );
```

No cast was needed (`inv.status` from `tx.invoice.findUnique` is already typed `InvoiceStatus`,
matching `CREDIT_NOT_APPLICABLE: InvoiceStatus[]`) — `tsc` confirms this (exit 0, see below).

## A7 — T10 now asserts `status: "APPLIED"` on the partial-cap write

**File:** `apps/api/src/credit-notes/credit-notes.wallet-integrity.spec.ts` — extended T10's
positive assertion so a mutation that drops the `status: CreditNoteStatus.APPLIED` write from the
capped branch (which the review found would leave 15/15 green) now fails red.

```diff
@@ -479,7 +480,7 @@ describe("InvoicesService — voidInvoiceInTx caps/voids credit notes it sourced
     expect(prisma.creditNote.update).toHaveBeenCalledWith(
       expect.objectContaining({
         where: { id: "cn-src-partial" },
-        data: expect.objectContaining({ amount: 40 }),
+        data: expect.objectContaining({ amount: 40, status: "APPLIED" }),
       }),
     );
     expect(prisma.creditNote.update).not.toHaveBeenCalledWith(
```

## A9 — Non-goals documented (no code change; see A8 note below)

**File:** `.claude/pipeline/2026-09-01-f09-credit-notes-wallet/spec.md` — added the
restore-can-resurrect-headroom sentence to Non-goals, so the D4 data-repair report does not
misclassify these rows as corruption. A8 (deploy-day delta) was also added per the ruling row,
since both A8 and A9 are `spec.md` edits to the same two lists (see A8/A9 combined diff below).

## A11 — T2 now asserts the cap does not blind-rewrite an already-consumed note

**File:** `apps/api/src/credit-notes/credit-notes.wallet-integrity.spec.ts` — added
`expect(prisma.creditNote.update).not.toHaveBeenCalled();` to T2.

```diff
@@ -225,6 +225,7 @@ describe("CreditNotesService — wallet-exclusion on the credit apply paths (F09
     const result = await service.settleOrderCreditsInTx(prisma as any, "order-void");

     expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
+    expect(prisma.creditNote.update).not.toHaveBeenCalled();
     expect(result.applied).toBe(0);
   });
```

## A8 / A9 — `spec.md` deploy-day deltas + Non-goals

Added item (6) to the "Deploy-day / entitlement answers" behaviour-delta list (A8: unvoid does not
resurrect capped/voided notes) and one sentence to "Non-goals" (A9: a later restore may return
spent credit to a note whose source was voided — not corruption).

```diff
diff --git a/.claude/pipeline/2026-09-01-f09-credit-notes-wallet/spec.md b/.claude/pipeline/2026-09-01-f09-credit-notes-wallet/spec.md
index a0c797e3..73959915 100644
--- a/.claude/pipeline/2026-09-01-f09-credit-notes-wallet/spec.md
+++ b/.claude/pipeline/2026-09-01-f09-credit-notes-wallet/spec.md
@@ -16,8 +16,8 @@ migration.** Conventions: NestJS `Test.createTestingModule`, module-boundary moc
 - **R3 (P0, jest):** **PAID stays IN the settle set — and this is the requirement most likely
   to be "simplified" into a bug.** Reading the code changed this design: the two obvious
   candidates for reuse, `applyToInvoice`'s `notApplicableStatuses` (`[PAID, VOID,
-  WRITTEN_OFF]`) and `recordDeliveryPaymentInTx`'s `PAYABLE` (`[DRAFT, SENT, PARTIAL,
-  OVERDUE]`), **both exclude PAID** — and `settleOrderCreditsInTx` runs a **shrink** pass over
+WRITTEN_OFF]`) and `recordDeliveryPaymentInTx`'s `PAYABLE` (`[DRAFT, SENT, PARTIAL,
+OVERDUE]`), **both exclude PAID** — and `settleOrderCreditsInTx` runs a **shrink** pass over
   the very same invoice list before its apply pass. Excluding PAID would stop an order edit
   from un-applying now-excess credit on a PAID invoice, stranding customer money. Including
   PAID in the apply pass is harmless: `applyCreditInTx` clamps to the remaining balance, which
@@ -42,7 +42,7 @@ migration.** Conventions: NestJS `Test.createTestingModule`, module-boundary moc
   note is capped to `amountUsed` (already-spent money is not clawed back; that would corrupt
   invoices the credit already paid). Runs **inside** the existing void transaction.
 - **R6 (P1, jest):** already-applied credit is untouched by R5 — no `InvoicePayment` is deleted
-  and no `amountUsed` decremented. R5 removes only *spendable* headroom.
+  and no `amountUsed` decremented. R5 removes only _spendable_ headroom.

 ### B18 — delete the flow that can never run (web + mobile + API)

@@ -57,7 +57,7 @@ migration.** Conventions: NestJS `Test.createTestingModule`, module-boundary moc
 ### B19 — invoice numbers, not UUIDs

 - **R9 (P0, jest + e2e T2):** `findAll` includes `invoice: { select: { id: true,
-  invoiceNumber: true } }`, matching `findOne`'s existing shape.
+invoiceNumber: true } }`, matching `findOne`'s existing shape.
 - **R10 (P0, e2e T2):** all three web render sites show `invoice?.invoiceNumber ?? invoiceId`:
   list `page.tsx` ~:855, detail ~:508-516 and ~:638-646. The `href` keeps using the id.

@@ -78,9 +78,14 @@ consumed against WRITTEN_OFF debt. Rollback = revert the single PR; no persisted
 Behaviour deltas an operator sees on deploy day: (1) creating a credit note against a voided
 invoice is refused with a reason; (2) voiding an invoice now also removes the unused headroom of
 credits it sourced; (3) the never-working Issue button disappears; (4) invoice numbers replace
-UUIDs; (5) a new Apply-advance action appears on web.
+UUIDs; (5) a new Apply-advance action appears on web; (6) unvoiding an invoice does not resurrect
+the credit notes the void capped or voided; the freed headroom lets the operator mint a
+replacement note.

 ## Non-goals

 A real DRAFT lifecycle (D5-deferred) · clawing back already-spent credit · touching
-`applyToInvoice`'s manual guards · F08's scope in the same file · retro-repair in code.
+`applyToInvoice`'s manual guards · F08's scope in the same file · retro-repair in code · a later
+restore (order-edit shrink, un-apply) may return spent credit to a note whose source was voided —
+that credit was really spent and is not corruption; the D4 repair report must not classify these
+rows as such.
```

**Deviation:** `prettier --write` on `spec.md` reflowed three pre-existing lines it was not asked
to touch (the R3/R6/R9 bullet continuation-line wrapping, and `*spendable*` → `_spendable_`
emphasis-marker normalization) as a side effect of formatting the whole file rather than just my
inserted hunks. These are Prettier's own markdown-prose-wrap/emphasis rules, purely cosmetic, no
content change — called out here per instructions rather than silently left in.

---

## Gate — jest (from `apps/api`)

```
npx jest src/credit-notes/credit-notes.wallet-integrity.spec.ts src/credit-notes/credit-notes.wallet-integrity.pins.spec.ts src/returns src/customers/customers.service.spec.ts src/invoices/invoices.service.spec.ts --runInBand
```

```
PASS src/customers/customers.service.spec.ts (125.055 s)
PASS src/returns/returns-refund.spec.ts (19.095 s)
PASS src/returns/returns-overreturn.spec.ts
PASS src/returns/returns.security.spec.ts (5.038 s)
PASS src/returns/returns-ledger.spec.ts
PASS src/invoices/invoices.service.spec.ts (32.589 s)
PASS src/credit-notes/credit-notes.wallet-integrity.spec.ts
PASS src/credit-notes/credit-notes.wallet-integrity.pins.spec.ts

Test Suites: 8 passed, 8 total
Tests:       398 passed, 398 total
Snapshots:   0 total
Time:        206.197 s
```

`src/returns` expanded to 4 suites (`returns-refund.spec.ts`, `returns-overreturn.spec.ts`,
`returns.security.spec.ts`, `returns-ledger.spec.ts`) — all pre-existing, all green, none touched
except `returns-refund.spec.ts`. `src/customers/customers.service.spec.ts` exists exactly as named
(confirmed via `ls` before running) — no substitution needed. The `[Nest] ERROR ... catalog
unseeded` stack trace in the raw output is an intentional negative-path assertion inside
`customers.service.spec.ts:488` (a deliberately-logged error the test expects) — the suite still
reports PASS; not a fixer-introduced failure.

## Gate — tsc

```
npx tsc -p tsconfig.build.json --noEmit
```

Exit code 0, no output (clean).

## Prettier

```
npx prettier --write apps/api/src/returns/returns.service.ts apps/api/src/returns/returns-refund.spec.ts apps/api/src/invoices/invoices.service.ts apps/api/src/customers/customers.service.ts apps/api/src/credit-notes/credit-notes.wallet-integrity.spec.ts .claude/pipeline/2026-09-01-f09-credit-notes-wallet/spec.md
```

All five `apps/api/src/**` files reported `(unchanged)` — my edits were already Prettier-clean.
`spec.md` was reformatted (see the A8/A9 deviation note above). Follow-up
`npx prettier --check` on the same file list: `All matched files use Prettier code style!`

## Git scope

```
git status --porcelain
```

```
 M .claude/code-map/_meta.json
 M .claude/code-map/api.md
 M .claude/lessons/_meta.json
 M .claude/pipeline/2026-09-01-f09-credit-notes-wallet/fix-round-1-ruling.md
 M .claude/pipeline/2026-09-01-f09-credit-notes-wallet/spec.md                          <- this round
 M apps/api/scripts/e2e-verify.ts                                                        (other fixer)
 M apps/api/scripts/qa-run.js                                                            (other fixer)
 M apps/api/src/credit-notes/credit-notes.wallet-integrity.spec.ts                      <- this round
 M apps/api/src/customers/customers.service.ts                                          <- this round
 M apps/api/src/invoices/invoices.service.ts                                            <- this round
 M apps/api/src/returns/returns-refund.spec.ts                                          <- this round
 M apps/api/src/returns/returns.service.ts                                              <- this round
 M apps/web/app/(dashboard)/credit-notes/[id]/page.tsx                                   (other fixer)
 M apps/web/e2e/28-credit-note-wallet.spec.ts                                            (other fixer)
 M apps/web/lib/api/credit-notes.ts                                                      (other fixer)
?? .claude/pipeline/2026-09-01-f09-credit-notes-wallet/fix-round-2-report.md             (pipeline bookkeeping, not mine)
?? .claude/pipeline/2026-09-01-f09-credit-notes-wallet/fix-round-3-ruling.md             (pre-existing input, not mine)
?? .claude/pipeline/2026-09-01-f09-credit-notes-wallet/lesson-L-081.md                   (pipeline bookkeeping, not mine)
?? .claude/pipeline/2026-09-01-f09-credit-notes-wallet/p8-plan.md                        (pipeline bookkeeping, not mine)
?? .claude/pipeline/2026-09-01-f09-credit-notes-wallet/probes-2026-09-06.md              (pipeline bookkeeping, not mine)
?? .claude/pipeline/2026-09-01-f09-credit-notes-wallet/review-lens-a-api.md              (pipeline bookkeeping, not mine)
?? .claude/pipeline/2026-09-01-f09-credit-notes-wallet/review-lens-b-clients.md          (pipeline bookkeeping, not mine)
```

`.claude/code-map/*` and `.claude/lessons/_meta.json` and `fix-round-1-ruling.md` were already
dirty at session start (per the initial `git status` snapshot) — not touched by me. All `apps/web`
and `apps/api/scripts` dirt belongs to the parallel lens-B fixer, per instructions — untouched.

```
git diff --stat -- apps/api/src .claude/pipeline
```

```
 .../2026-09-01-f09-credit-notes-wallet/spec.md     | 17 ++++++----
 .../credit-notes.wallet-integrity.spec.ts          |  3 +-
 apps/api/src/customers/customers.service.ts        |  3 +-
 apps/api/src/invoices/invoices.service.ts          | 20 +++++++----
 apps/api/src/returns/returns-refund.spec.ts        | 39 ++++++++++++++++++++++
 apps/api/src/returns/returns.service.ts            | 11 +++++-
 6 files changed, 78 insertions(+), 15 deletions(-)
```

## Deviations summary

1. `spec.md`'s `prettier --write` reflowed three unrelated pre-existing lines (cosmetic markdown
   wrap/emphasis-marker normalization) as a side effect of formatting the whole file — not a
   content change, called out above and in-diff.
2. No test change was made for A5 — the ruling asked only to confirm `voidInvoice` cases in
   `invoices.service.spec.ts` still pass under the added transaction options, which they do (see
   gate results); no assertion in that file inspects `tenantTransaction`'s call arguments, and the
   prisma-mock's `tenantTransaction` mock ignores extra arguments, so nothing needed updating.
3. No cast (`as InvoiceStatus`) was needed for A6 despite the ruling's snippet showing one —
   `inv.status` from `tx.invoice.findUnique` is already typed `InvoiceStatus`, matching
   `CREDIT_NOT_APPLICABLE: InvoiceStatus[]` — confirmed by `tsc` exit 0.
4. Everything else matches the ruling's design exactly; no scope was added or dropped.
