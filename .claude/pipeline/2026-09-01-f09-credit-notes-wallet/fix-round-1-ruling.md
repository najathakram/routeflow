# F09 · Light-loop ruling 1 (Fable, 2026-09-06) — T6/T7 oracles, P3, B13 disposition

Inputs: `RESUME.md`, `build-plan.md` §4, `bug-test-plan.md`, `reader-state-2026-09-06.md` (the current tree:
15 tests, 12 green, T9/T10/T11 red on "0 calls"; T6/T7 already green because P2 shipped the `create()` guard).

## 1. T6/T7 — one distinguishing oracle each (gate file, lines ~315–355)

Problem: both tests capture the exception in a `try/catch` and assert `caught` first. Under the revert probe
(`credit-notes.service.ts` at `d12203a3`) both fail on the SAME absence (`received: undefined`) — no
per-test wrong value, so the red bar is not behavioral. Ruling — rewrite each body so the outcome is ONE value
whose red payload is specific to that test:

```ts
const outcome = await service
  .create({ customerId: "c1", invoiceId: "inv-void-1", amount: 30 })
  .then(
    (created: any) => ({
      threw: false,
      createdFor: created?.invoiceId, // the create mock echoes args.data → names THIS test's invoice
      createCalls: prisma.creditNote.create.mock.calls.length,
    }),
    (e: any) => ({
      threw: true,
      type: e?.constructor?.name,
      message: String(e?.message),
      createCalls: prisma.creditNote.create.mock.calls.length,
    }),
  );
expect(outcome).toEqual({
  threw: true,
  type: "BadRequestException",
  message: expect.stringMatching(/VOID/), // T7: /WRITTEN_OFF/
  createCalls: 0,
});
```

T7 is identical with `invoiceId: "inv-written-off-1"` and `/WRITTEN_OFF/`. Keep the `BadRequestException` import
only if still used elsewhere in the file. Under the revert, T6 must receive `{ threw: false, createdFor:
"inv-void-1", createCalls: 1 }` and T7 `{ …createdFor: "inv-written-off-1"… }` — two different wrong values.

## 2. Discriminating mutations (run AFTER P3 is green; each = edit → gate (+ pins where noted) → restore)

| #   | Mutation (one line)                                                            | Must go RED             | Must stay GREEN           |
| --- | ------------------------------------------------------------------------------ | ----------------------- | ------------------------- |
| M1  | `CREDIT_SOURCE_EXCLUDED = [VOID]` (drop WRITTEN_OFF)                           | T7                      | T6, T7b                   |
| M2  | `CREDIT_SOURCE_EXCLUDED = [WRITTEN_OFF]` (drop VOID)                           | T6                      | T7, T7b                   |
| M3  | keep the guard, message → `"Cannot issue a credit note against this invoice."` | T6, T7 (message)        | T7b                       |
| M4  | `CREDIT_SOURCE_EXCLUDED = [VOID, WRITTEN_OFF, DRAFT]`                          | T7b (pins)              | T6, T7                    |
| RP1 | revert `credit-notes.service.ts` to `d12203a3` (RESUME step d)                 | T1, T2, T5, T6, T7, T12 | pins T3, T3b, T4, T7b, T8 |
| RP2 | revert `invoices.service.ts` to `d12203a3`                                     | T9, T10, T11            | everything else           |

If a whole-file revert fails to COMPILE instead of failing on assertions, fall back to deleting only the guard /
include / capping lines by hand and say so in the probe report — a compile crash is not a behavioral red.
Restore after every step with `git checkout HEAD -- <file>` and prove restoration with `git status --porcelain`
(must be empty for that file) before the next step.

## 3. P3 — void-side capping (`invoices.service.ts` `voidInvoiceInTx`, between the `claimed.count` check and the

final `tx.invoice.findUnique`; build-plan §4 is the source, with two adjustments)

```ts
// F09/B66: a credit note's headroom dies with the invoice that justified it. Only the UNUSED
// portion goes — spent credit paid real invoices and clawing it back would corrupt them (R6).
const sourced = await tx.creditNote.findMany({
  where: { invoiceId: id, status: { not: CreditNoteStatus.VOID } },
  select: { id: true, amount: true, amountUsed: true },
});
for (const cn of sourced) {
  const used = Number(cn.amountUsed ?? 0);
  await tx.creditNote.update({
    where: { id: cn.id },
    data: used <= 0.001 ? { status: CreditNoteStatus.VOID } : { amount: roundMoney(used) },
  });
}
```

Adjustments: (a) use the `CreditNoteStatus` enum from `@prisma/client` (add it to the existing import beside
`InvoiceStatus`), never the string literal — the sibling sweep's `status: { not: "VOID" }` pattern must not
match the fix itself; (b) the loop must run AFTER `adjustInvoicedQtyForInvoice` / `reverseInvoiceEntries` /
`syncInvoiceCommissionSafe` and immediately BEFORE the final `findUnique` (T9's call-order oracle). Read
`applyCreditInTx` in `credit-notes.service.ts`: if it flips a fully-consumed note to `APPLIED`, the capped
write becomes `{ amount: roundMoney(used), status: CreditNoteStatus.APPLIED }` (a note with zero headroom
must not read ISSUED); if the codebase never derives APPLIED that way, keep the amount-only write. Report which.
Never delete an `InvoicePayment`, never touch `amountUsed`.

## 4. B13 — no `refuted` state exists in `bugs.mjs`

The ledger has no `refuted` state or command (reader §5). Ruling: B13 stays `queued` in F09; record the S2/S3
verdict on its record with `node scripts/campaign/bugs.mjs note B13 "<text>" --section "Root cause"` (text:
refuted as a bug — no web affordance ever existed, `git log -S` shows each hook added once and never called;
R11 is a feature deferred to dev-pipeline; the owner decides whether to file it). B13 is an OWNER item at
close-out; it is not proven and not discharged by this PR.

## 5. Order of work

A. (Sonnet, high) §1 + §3, then gate + pins green (15/15), `cd apps/api && npx tsc -p tsconfig.build.json
   --noEmit`, prettier on the changed files. Commit nothing.
B. (Sonnet, medium, alone) §2 ladder → `probes-2026-09-06.md`; tree restored and clean afterwards.
C. Fable commits; Opus review lenses + sibling sweep over `git diff d12203a3...HEAD`; fix round; P8.
