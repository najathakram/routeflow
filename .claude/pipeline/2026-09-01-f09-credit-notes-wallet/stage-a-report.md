# F09 · Stage A report (Sonnet, 2026-09-06) — §1 + §3 of `fix-round-1-ruling.md`

Scope: worktree `rf-F09`, branch `fix/F09-credit-notes-wallet`. No commits made. Only the two
in-scope files were modified.

## 1. Diff — `apps/api/src/credit-notes/credit-notes.wallet-integrity.spec.ts`

```diff
diff --git a/apps/api/src/credit-notes/credit-notes.wallet-integrity.spec.ts b/apps/api/src/credit-notes/credit-notes.wallet-integrity.spec.ts
index 61e7924b..8e7a763f 100644
--- a/apps/api/src/credit-notes/credit-notes.wallet-integrity.spec.ts
+++ b/apps/api/src/credit-notes/credit-notes.wallet-integrity.spec.ts
@@ -75,7 +75,6 @@ jest.mock("../invoices/invoice-pdf.service", () => ({
 }));

 import { Test, TestingModule } from "@nestjs/testing";
-import { BadRequestException } from "@nestjs/common";

 import { CreditNotesService } from "./credit-notes.service";
 import { InvoicesService } from "../invoices/invoices.service";
@@ -321,16 +320,28 @@ describe("CreditNotesService — create() refuses VOID/WRITTEN_OFF source invoic
     });
     prisma.creditNote.aggregate.mockResolvedValueOnce({ _sum: { amount: 0 } });

-    let caught: any;
-    try {
-      await service.create({ customerId: "c1", invoiceId: "inv-void-1", amount: 30 });
-    } catch (e) {
-      caught = e;
-    }
+    const outcome = await service
+      .create({ customerId: "c1", invoiceId: "inv-void-1", amount: 30 })
+      .then(
+        (created: any) => ({
+          threw: false,
+          createdFor: created?.invoiceId, // the create mock echoes args.data → names THIS test's invoice
+          createCalls: prisma.creditNote.create.mock.calls.length,
+        }),
+        (e: any) => ({
+          threw: true,
+          type: e?.constructor?.name,
+          message: String(e?.message),
+          createCalls: prisma.creditNote.create.mock.calls.length,
+        }),
+      );

-    expect(caught).toBeInstanceOf(BadRequestException);
-    expect(caught?.message).toMatch(/VOID/);
-    expect(prisma.creditNote.create).not.toHaveBeenCalled();
+    expect(outcome).toEqual({
+      threw: true,
+      type: "BadRequestException",
+      message: expect.stringMatching(/VOID/),
+      createCalls: 0,
+    });
   });

   it("T7 (R4, REG-B66): create({ invoiceId }) against a WRITTEN_OFF invoice rejects, naming the status, with no creditNote.create call", async () => {
@@ -342,16 +353,28 @@ describe("CreditNotesService — create() refuses VOID/WRITTEN_OFF source invoic
     });
     prisma.creditNote.aggregate.mockResolvedValueOnce({ _sum: { amount: 0 } });

-    let caught: any;
-    try {
-      await service.create({ customerId: "c1", invoiceId: "inv-written-off-1", amount: 30 });
-    } catch (e) {
-      caught = e;
-    }
+    const outcome = await service
+      .create({ customerId: "c1", invoiceId: "inv-written-off-1", amount: 30 })
+      .then(
+        (created: any) => ({
+          threw: false,
+          createdFor: created?.invoiceId, // the create mock echoes args.data → names THIS test's invoice
+          createCalls: prisma.creditNote.create.mock.calls.length,
+        }),
+        (e: any) => ({
+          threw: true,
+          type: e?.constructor?.name,
+          message: String(e?.message),
+          createCalls: prisma.creditNote.create.mock.calls.length,
+        }),
+      );

-    expect(caught).toBeInstanceOf(BadRequestException);
-    expect(caught?.message).toMatch(/WRITTEN_OFF/);
-    expect(prisma.creditNote.create).not.toHaveBeenCalled();
+    expect(outcome).toEqual({
+      threw: true,
+      type: "BadRequestException",
+      message: expect.stringMatching(/WRITTEN_OFF/),
+      createCalls: 0,
+    });
   });
 });
```

Titles, `it()` REG tokens and the `beforeEach` fixture are unchanged. `BadRequestException` was
imported only for these two tests (confirmed via grep before editing — the only two matches were
inside T6/T7's own bodies), so the import is removed per the ruling's instruction ("Keep the
`BadRequestException` import only if still used elsewhere in the file"). The two remaining hits
on `"BadRequestException"` after the edit are string literals inside `toEqual({ type:
"BadRequestException", ... })`, not the imported symbol.

## 2. Diff — `apps/api/src/invoices/invoices.service.ts`

```diff
diff --git a/apps/api/src/invoices/invoices.service.ts b/apps/api/src/invoices/invoices.service.ts
index 2ba45445..d6cccdcc 100644
--- a/apps/api/src/invoices/invoices.service.ts
+++ b/apps/api/src/invoices/invoices.service.ts
@@ -24,7 +24,13 @@ import { clampLimit } from "../common/pagination";
 import { isInternalEmail } from "../common/internal-email";
 import { loadMsrpMap } from "../common/msrp";
 import { EntitlementsService } from "../billing/entitlements.service";
-import { CheckStatus, InvoiceStatus, NotificationEvent, UserRole } from "@prisma/client";
+import {
+  CheckStatus,
+  CreditNoteStatus,
+  InvoiceStatus,
+  NotificationEvent,
+  UserRole,
+} from "@prisma/client";
 import {
   CreateInvoiceDto,
   RecordInvoicePaymentDto,
@@ -3847,6 +3853,31 @@ export class InvoicesService {
     // Sales agents & commissions: a voided invoice targets zero — this
     // emits the compensating CLAWBACK adjustment when commission was claimed.
     await this.commissionEngine.syncInvoiceCommissionSafe(id, tx);
+    // F09/B66: a credit note's headroom dies with the invoice that justified it. Only the
+    // UNUSED portion goes — spent credit paid real invoices and clawing it back would
+    // corrupt them (R6). CreditNoteStatus enum, never the string literal, so the sibling
+    // sweep's single-status `status: { not: "VOID" }` pattern doesn't match this fix.
+    const sourced = await tx.creditNote.findMany({
+      where: { invoiceId: id, status: { not: CreditNoteStatus.VOID } },
+      select: { id: true, amount: true, amountUsed: true, invoiceId: true },
+    });
+    for (const cn of sourced) {
+      // Defense-in-depth scoping: the query above already restricts to this invoice,
+      // but the service itself — not only the query — must not touch a note it did
+      // not source (T11).
+      if (cn.invoiceId !== id) continue;
+      const used = Number(cn.amountUsed ?? 0);
+      await tx.creditNote.update({
+        where: { id: cn.id },
+        data:
+          used <= 0.001
+            ? { status: CreditNoteStatus.VOID }
+            : // Capping amount to the used portion leaves zero headroom (amount - amountUsed
+              // === 0) — the same "fully consumed" condition applyCreditInTx (:450-461) flips
+              // to APPLIED, so a capped note must read APPLIED too, never a stale ISSUED.
+              { amount: roundMoney(used), status: CreditNoteStatus.APPLIED },
+      });
+    }
     // Status already flipped to VOID by the claim above; return the fresh record.
     return tx.invoice.findUnique({ where: { id } });
   }
```

`CreditNoteStatus` confirmed present in `node_modules/.prisma/client/index.d.ts` (line 1003:
`export const CreditNoteStatus: { ISSUED: 'ISSUED', APPLIED: 'APPLIED', VOID: 'VOID' };`). Placed
in the existing `@prisma/client` import beside `InvoiceStatus`. `roundMoney` already imported at
line 13-19 (`@routeflow/pricing`), reused as-is. The loop runs after
`syncInvoiceCommissionSafe` and before the final `tx.invoice.findUnique`, matching build-plan §4's
placement and T9's call-order oracle. No `InvoicePayment` deleted; `amountUsed` never written.

## 3. Deviation from the literal ruling snippet — required to pass T11

The ruling's §3 snippet (and build-plan §4) specify `select: { id: true, amount: true, amountUsed:
true }` with no per-item scoping check in the loop body. Implementing it exactly as written failed
T11:

```
● InvoicesService — voidInvoiceInTx caps/voids credit notes it sourced (F09 gate) › T11 ...
  expect(jest.fn()).not.toHaveBeenCalledWith(...expected)
  Expected: not ObjectContaining {"where": {"id": "cn-other-inv"}}
  Received
         2:     {"data": {"status": "VOID"}, "where": {"id": "cn-other-inv"}}
```

Root cause: `createMockPrisma`'s `findMany` mock (per `prisma-mock.ts`, confirmed in
`reader-state-2026-09-06.md` §2) ignores the `where` argument entirely and just returns whatever
`mockResolvedValueOnce` was given — T11's fixture deliberately returns two notes, one for
`invoiceId: "inv-void-src-4"` (this invoice) and one for `invoiceId: "inv-completely-different"`.
The test's own comment (`reader-state` §2, T11 lines 296-300) states this is deliberate: "The
service itself, not just the query, must cap the first and leave the second alone" — a scoping
oracle, per `bug-test-plan.md` T11's row text ("scoping oracle"). A naive loop over every row
`findMany` returns (trusting the DB `where` to have filtered) updates both notes and fails T11.

Fix: added `invoiceId: true` to the `select` (so the row carries the field to check) and one
guard line, `if (cn.invoiceId !== id) continue;`, before the update. This is additive — it
doesn't change the `where` clause used for either `findMany` or `creditNote.update` (both stay
exactly as the ruling specified, `where: { id: cn.id }` on the update, matching T9/T10's exact-
shape `where` assertions), so it doesn't disturb any other oracle. Reported here per the task's
"a gap in the plan is a finding to report, not something to guess" instruction — this is a real
gap between the ruling's exact code sample and the gate test's scoping oracle, not a guess.

## 4. APPLIED-status decision (§3's open question) — evidence

Read `applyCreditInTx` in `apps/api/src/credit-notes/credit-notes.service.ts` (lines 381-468).
The relevant lines (450-461):

```ts
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
```

`applyCreditInTx` DOES flip a fully-consumed note (`amount - amountUsed <= 0.001`) to
`status: "APPLIED"`. Per the ruling's rule ("if it flips a fully-consumed note to APPLIED, the
capped write becomes `{ amount: roundMoney(used), status: CreditNoteStatus.APPLIED }`"), the
partial-cap branch in `voidInvoiceInTx` was implemented as `{ amount: roundMoney(used), status:
CreditNoteStatus.APPLIED }` — capping `amount` to `used` makes the note's own headroom
(`amount - amountUsed`) zero, the same "fully consumed" condition `applyCreditInTx` uses, so it
must not be left reading a stale `ISSUED`.

This does not conflict with T10's assertions (`bug-test-plan.md` T10, reader-state §2 lines
443-474): T10 asserts `data` **contains** `amount: 40` via `expect.objectContaining`, and
separately asserts `update` was **never** called with `data` containing `status: "VOID"` — it
makes no claim about the absence of any other `status` value, so `status: "APPLIED"` alongside
`amount: 40` satisfies both.

## 5. Jest — gate + pins (task 3)

```
PASS src/credit-notes/credit-notes.wallet-integrity.spec.ts (11.594 s)
PASS src/credit-notes/credit-notes.wallet-integrity.pins.spec.ts

Test Suites: 2 passed, 2 total
Tests:       15 passed, 15 total
Snapshots:   0 total
Time:        16.082 s
```

15/15 green, as expected (first run without the T11 scoping guard was 14/15, with T11 red on the
`toHaveBeenCalledWith`/`not.toHaveBeenCalledWith` pair above — see §3).

## 6. Jest — `invoices.service.spec.ts` (task 4)

```
Test Suites: 1 passed, 1 total
Tests:       266 passed, 266 total
Snapshots:   0 total
Time:        46.41 s
```

266/266 green. Confirms the existing `voidInvoiceInTx` real-call specs in this file are unaffected
— they now also execute `tx.creditNote.findMany`, and `createMockPrisma`'s default
`modelProxy()` resolves `findMany` to `[]` when no test-local mock overrides it (per
`reader-state-2026-09-06.md` §2's description of `prisma-mock.ts`), so the new loop is a no-op
for every pre-existing spec in this file.

## 7. `tsc -p tsconfig.build.json --noEmit` (task 5)

Exit code 0, no diagnostics printed (ran from `apps/api`).

## 8. Prettier (task 6)

```
apps/api/src/invoices/invoices.service.ts 9885ms (unchanged)
apps/api/src/credit-notes/credit-notes.wallet-integrity.spec.ts 337ms (unchanged)
```

`npx prettier --write` reported both files unchanged (my edits were already Prettier-clean);
`npx prettier --check` on the same two files: "All matched files use Prettier code style!"

## 9. Git scope (task 7)

```
$ git status --porcelain
 M apps/api/src/credit-notes/credit-notes.wallet-integrity.spec.ts
 M apps/api/src/invoices/invoices.service.ts
?? .claude/pipeline/2026-09-01-f09-credit-notes-wallet/fix-round-1-ruling.md
?? .claude/pipeline/2026-09-01-f09-credit-notes-wallet/reader-state-2026-09-06.md

$ git diff --stat
 .../credit-notes.wallet-integrity.spec.ts          | 61 +++++++++++++++-------
 apps/api/src/invoices/invoices.service.ts          | 33 +++++++++++-
 2 files changed, 74 insertions(+), 20 deletions(-)
```

Only the two in-scope files are modified (`M`). The two untracked (`??`) pipeline docs
(`fix-round-1-ruling.md`, `reader-state-2026-09-06.md`) were already present, untracked, in the
worktree before this session started (confirmed by `ls` at the start of this task, before any
edit was made) — they are pre-existing artifacts from an earlier stage of this pipeline run, not
something this stage wrote. Nothing was committed, stashed, or checked out; no other worktree was
touched.

## 10. Deviations summary

One deviation from the literal ruling text, documented in §3: `select` gained `invoiceId: true`
(ruling said `{ id, amount, amountUsed }` only) and the loop gained a one-line scoping guard,
both required to make T11's scoping oracle pass under the mock's actual behavior. No other
deviation. §2 (mutation probes) and §4 (B13 disposition) were explicitly out of scope for this
stage and were not touched.
