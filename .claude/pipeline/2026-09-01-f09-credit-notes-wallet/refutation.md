# F09 · S2 Cause REFUTATION — credit notes and wallet integrity (B13, B18, B19, B66, B67)

Method: every suspected cause was assumed WRONG and re-derived from repro input to wrong output on
`origin/master` (`d12203a3`). Code read only via `git show origin/master:<path>`; no npm/jest, no git
writes. Sep-1 `spec.md` / `test-plan.md` / `build-plan.md` treated as CLAIMS. Line numbers are
`origin/master` unless stated.

---

## B67 — order-edit settle applies wallet credit to WRITTEN_OFF debt

**Verdict: CONFIRMED — but the named line is only half the path, and the planned fix does not close it.**

**Diverging lines (two, not one):**

1. `apps/api/src/credit-notes/credit-notes.service.ts:930` —
   `where: { orderId, status: { not: "VOID" } }` lets WRITTEN_OFF into the fetched set.
2. `apps/api/src/credit-notes/credit-notes.service.ts:413-422` — `applyCreditInTx`'s
   `tx.invoicePayment.create({ method: CREDIT_NOTE, ... })` fires with **no status gate at all**, and the
   settle apply loop (`:983-999`) never re-checks `freshInv.status` either. The money write is here; the
   `where` is only the first of two doors, and it is the door the tests do not use (see O1).

**Repro survives the obvious refutation.** `writeOff()` (`invoices.service.ts:4892-4923`) writes **no**
payment row — only `status/writeOffReason/writtenOffAt` — so a WRITTEN_OFF invoice keeps a positive
balance, `applyCreditInTx` computes `invoiceBalance = total - alreadyPaid > 0`, applies, and
`recomputeStatus` (`credit-notes.service.ts:40-58`) returns WRITTEN_OFF unchanged. Silent consumption
confirmed. Nothing refutes it.

**The manual path that refuses WRITTEN_OFF** — `applyToInvoice`, `credit-notes.service.ts:537-546`:

```ts
const notApplicableStatuses: InvoiceStatus[] = [
  InvoiceStatus.PAID,
  InvoiceStatus.VOID,
  InvoiceStatus.WRITTEN_OFF,
];
if (notApplicableStatuses.includes(inv.status)) {
  throw new BadRequestException(`Cannot apply credit note to invoice with status ${inv.status}`);
}
```

Second precedent, an ALLOW-list: `invoices.service.ts:4513-4516`
`const PAYABLE = [DRAFT, SENT, PARTIAL, OVERDUE]`, with the comment at `:4510-4512` — "a written-off bad
debt must not swallow the cash".

**Is WRITTEN_OFF the only status to exclude?** `InvoiceStatus`
(`apps/api/prisma/schema/finance.prisma:37-46`) = `DRAFT SENT VIEWED PARTIAL PAID OVERDUE VOID
WRITTEN_OFF`. **There is no CANCELLED.**

- **PAID — R3 HOLDS, keep it in.** Traced `applyCreditInTx`: `applyAmount = min(remaining,
invoiceBalance, requested)` and `if (!(applyAmount > 0.001)) return { applied: 0 }` (`:398-402`). For a
  PAID invoice `alreadyPaid >= total`, so `invoiceBalance ~ 0` — no payment row, no over-credit, no
  refund. Verified that no path writes `status: PAID` other than through `recomputeStatus` (the only
  literal `"PAID"` writes in `invoices.service.ts` are a summary filter `:4253` and an _InvoicePayment_
  status `:4617`), so "PAID with a positive balance" is not reachable. R3's stronger half also holds:
  settle's SHRINK pass (`:935-967`) needs PAID in the set.
- **DRAFT — must stay in.** An order's pending-mirror invoice lives DRAFT by design
  (`findOpenOrderDraft`, `invoices.service.ts:1243-1249`) and `PAYABLE` includes DRAFT.
- So `{VOID, WRITTEN_OFF}` is the correct exclusion pair. VIEWED/PARTIAL/OVERDUE are live.

**F07's `send()` / `sendEmail()` — the claim is half right and the brief's shape claim is wrong.**
`invoices.service.ts:3382` and `:3588` call `settleOrderCreditsInTx(tx, updated.orderId)` — the **2-arg
default**, NOT an explicit `tenantId` (the explicit shape is `:1227` / `:2699`, the fire-and-forget
creation paths). 7 call sites total, not six.

**More important: those two functions reach a SECOND unguarded primitive the plan never touches.**
`send()` refuses only VOID (`:3358`) and `assertOrderInvoiceUnlocked` (`:3335-3353`) returns immediately
for any non-DRAFT status — so a WRITTEN_OFF invoice **can be sent**, and two lines after the settle call
`autoApplyOldestCreditsInTx` runs (`:3394`, `:3600`). That primitive reads its target with
`tx.invoice.findUnique({ where: { id: invoiceId } })` (`credit-notes.service.ts:473-476`) and **no status
filter whatsoever**, then applies whenever `total - paid > 0.001`. R1/R2 as written leave this path wide
open: after the fix ships, sending a written-off invoice still eats wallet credit.

**Consequence for the fix location:** the only place that closes both primitives with one change — and the
only place that satisfies the red-gate oracles as written (O1) — is **`applyCreditInTx` itself**
(exclude-list check on `inv.status`, returning `{ applied: 0 }`), optionally _plus_ the `where` narrowing
as defence in depth. `applyToInvoice` already refuses these statuses upstream, so no legitimate caller
regresses.

---

## B66 — a credit note outlives its voided invoice / can be minted against VOID (and DRAFT)

**Verdict: CONFIRMED on both branches. R5/R6 are sound. R4's status set is REFUTED — it is inverted.**

**Branch 1 — `create()` never reads status.** `credit-notes.service.ts:107-121`:

```ts
const invoice = await tx.invoice.findFirst({
  where: { id: dto.invoiceId },
  select: { total: true, customerId: true, items: { select: {/* ... */} } }, // no `status`
});
if (!invoice) throw new BadRequestException("Invoice not found");
if (invoice.customerId !== dto.customerId) throw new BadRequestException(/* ... */);
```

Diverging line = **:110** (the `select`), the only cap being `totalExisting + dto.amount > invoiceTotal`
at `:134-139`, and `total` is never changed by a void. Confirmed.

**Branch 2 — `voidInvoiceInTx` never touches CreditNote.** `invoices.service.ts:3836-3851`: atomic claim
(`updateMany` + `ConflictException` on `claimed.count === 0`, F03's shape) then
`adjustInvoicedQtyForInvoice`, `ledger.reverseInvoiceEntries`, `commissionEngine.syncInvoiceCommissionSafe`,
`tx.invoice.findUnique`. Zero `tx.creditNote.*`. Diverging line = **the absence between :3846 and :3850**.
Confirmed.

**Ordering fact the plan must respect (a constraint, not a refutation).** Both real callers release the
wallet FIRST: `voidInvoice` at `:3874` and `orders.service.ts:2754` both call
`releaseWalletPaymentsInTx(tx, inv.id)` immediately before `voidInvoiceInTx`. That primitive
(`:3797-3821`) hands credit **applied TO** the invoice back to its note (via `releaseInvoiceCreditsInTx`)
and deletes ADVANCE payment rows. R5 concerns notes **SOURCED FROM** the invoice (`CreditNote.invoiceId`).
For a note that is both (issued against invoice X, then applied to X), release then cap is the only
correct order: release zeroes `amountUsed`, then the cap sees a fully-unused note and VOIDs it. Putting
the capping loop inside `voidInvoiceInTx` (as planned) preserves that order for both callers. R6 (no
`InvoicePayment` deleted, no `amountUsed` decrement) is consistent with those primitives and is the right
rule.

**Schema relations the fix must respect** (`apps/api/prisma/schema/finance.prisma`):

```prisma
model CreditNote {                                          // :470-486
  invoiceId          String?                                // :474  SOURCE invoice — nullable
  amount             Decimal          @db.Decimal(10, 2)    // :475
  amountUsed         Decimal @default(0) @db.Decimal(10, 2) // :476
  status             CreditNoteStatus @default(ISSUED)      // :478
  appliedToInvoiceId String?                                // :479
}
model InvoicePayment { /* :297-312 */ invoiceId  amount Decimal(10,2)  method PaymentMethod /* ... */ }
```

Applications are `InvoicePayment` rows keyed by `invoiceId` + `creditNoteId` — a _different_ edge from
`CreditNote.invoiceId`. Capping writes `amount` only, into a `Decimal(10,2)`, so `roundMoney` is mandatory
(the plan does this). Note also `deleteInvoice` (`invoices.service.ts:4952-4956`) nulls `invoiceId` and
leaves `amount` intact — the same headroom hole via delete instead of void; outside B66's stated scope,
but it is the sibling.

**"Cap or void" vs. the money invariant.** The proposed invariant "a credit note's remaining balance must
never exceed what was actually paid on the source" is **not** this system's invariant and should not be
adopted here: `create()` deliberately caps at the invoice **total**, not at cash received — a credit note
is forgiveness of what is _owed_, and the UI documents that (`credit-notes/page.tsx:340-342`: any
non-VOID/WRITTEN_OFF invoice, "including PAID", is selectable). Adopting the payment-based invariant would
silently break every unpaid-invoice credit. R5's rule — _the headroom dies with the justification, the
spent dollars do not_ — is the defensible one, and it is what the tests encode.

**R4 REFUTED as specified (refuses VOID+DRAFT, omits WRITTEN_OFF).** Three disproofs:

1. **It can strand a refund.** `returns.service.ts:370` calls
   `this.creditNotes.create({ invoiceId: invoices.length === 1 ? invoices[0].id : undefined, ... })`,
   where `invoices` comes from `:313` `order: { select: { invoices: { select: { id: true } } } }` — **no
   status filter** — so a DRAFT pending-mirror or an already-VOID invoice qualifies. It runs **after** the
   atomic `RECEIVED -> REFUNDED` claim at `:348-360` and outside any shared transaction ("Sequential, NOT
   nested", `:367`). A new `BadRequestException` there leaves the return marked REFUNDED with **no credit
   note minted** — money lost, introduced by the fix.
2. **DRAFT is an offered, deliberate choice today.** `apps/web/app/(dashboard)/credit-notes/page.tsx:74`
   `const HIDDEN_INVOICE_STATUSES = new Set(["VOID", "WRITTEN_OFF"])` — DRAFT is selectable on purpose —
   and the apply picker at `[id]/page.tsx:139-147` carries a comment recording that hiding DRAFT
   previously produced a dead end ("a customer whose only open invoice was a draft hit the same dead
   end"). P5 touches neither picker, so R4 would 400 a valid dropdown option.
3. **WRITTEN_OFF is the one that is actually missing.** Minting fresh spendable credit against forgiven
   debt is the same hole as B67, and the UI already hides it — server and UI would still disagree, in the
   opposite direction.

**Recommended ruling for S3:** refuse **VOID + WRITTEN_OFF**; leave DRAFT allowed. If the owner insists on
DRAFT, the same PR must (a) make `returns.processRefund` degrade to `invoiceId: undefined` when the sole
invoice is DRAFT/VOID and (b) add DRAFT to `HIDDEN_INVOICE_STATUSES` — and T7's oracle changes.

---

## B18 — dead DRAFT / Issue flow

**Verdict: CONFIRMED. "Remove, don't implement" is CORRECT — but the correct removal is both bigger and
cheaper than the plan says.**

Facts re-verified: enum `CreditNoteStatus { ISSUED APPLIED VOID }` (`finance.prisma:56-60`); `issue()` is
`return this.findOne(id)` (`credit-notes.service.ts:358-360`) — the diverging line; route
`@Post(":id/issue")` (`credit-notes.controller.ts:51-55`); `create()` hardcodes `status: "ISSUED"`
(`:232-240`); web DRAFT branches at `[id]/page.tsx:410`, `:653` (plus `IssueConfirmModal` `:34`, hook
`:243`, modal `:704-709`), list chip/count at `page.tsx:37, 563, 677, 685`.

**Refutation attempt — is any requirement, route, or screen expecting a draft credit note? No.**

- No writer anywhere sets a credit note to DRAFT (the only DRAFT literals in the service are
  _InvoiceStatus_ DRAFT at `:46-48` and a stale comment at `:586`).
- The **schema-pinned shared union already excludes it**: `packages/types/api/enums.ts:60-61`
  `CREDIT_NOTE_STATUS_VALUES = ["ISSUED", "APPLIED", "VOID"]`, pinned set-equal to `@prisma/client` by
  `apps/api/src/common/enum-parity.spec.ts:51`.
- Both apps still hand-type the phantom — `apps/web/lib/api/credit-notes.ts:6` and
  `apps/mobile/lib/api/credit-notes.ts:8` (`"DRAFT" | "ISSUED" | "APPLIED" | "VOID"`). This is textbook
  **L-072**; wave E recorded the identical case (a phantom `"EXPIRED"` on `EstimateStatus`) in
  `packages/types/api/misc.ts:37-43` and fixed it by deriving from the shared union.

So the fix is **"delete the phantom value and import `CreditNoteStatus` from `@routeflow/types`"**, after
which the dead branches stop compiling and removal is mechanical — a stronger and cheaper guard than
hand-deleting JSX (R8 becomes a type error rather than a grep).

**Surfaces the build plan's P5/P6 miss:** `apps/mobile/lib/credit-notes-logic.ts` (`creditNotePillFor`
DRAFT case `:22-23`; `creditNoteActionFlags.canIssue = status === "DRAFT"` `:52`) — which B18's own
registry card lists in `files:` — and its spec `apps/mobile/__tests__/credit-notes-helpers.test.ts`
(`:16`, `:44`, `:87`). See harness integrity below.

---

## B19 — raw UUIDs in the credit-note list

**Verdict: CONFIRMED (trivial).**

Diverging line: `credit-notes.service.ts:295` — `findAll` (`:269-303`) issues
`include: { customer: { select: { id: true, businessName: true } } }` with **no `invoice` key**, while
`findOne` (`:331-338`) has `invoice: { select: { id: true, invoiceNumber: true } }`. `cn.invoice` is
therefore `undefined` on every list row.

**Web type check (asked):** `apps/web/lib/api/credit-notes.ts` `interface CreditNote` (`:8-34`) declares
`invoiceId?: string` and **has no `invoice` field at all** — so R10 needs a type addition
(`invoice?: { id: string; invoiceNumber: string }`) in that file, not just JSX edits. P5 lists the file;
the plan's prose does not mention the type. Render sites confirmed: list `page.tsx:855-856`, detail
`[id]/page.tsx:508-516` and `:638-646` (the detail page already _receives_ the number from `findOne` —
that half is a pure render fix, no API change).

---

## B13 — orphaned apply-advance hooks / no web action

**Verdict: REFUTED as a bug. It is a feature request in disguise. Recommend DEFER R11 to dev-pipeline.**

Disproof that an affordance ever existed and broke:

- `git log --oneline -S"useApplyAdvanceToInvoice" origin/master -- apps/web` returns **exactly one
  commit** (`d689ab61`, the feature that introduced the hook). `-S"useApplyAdvancePayment"` returns
  **one** (`79e76174`). A commit that added _or removed_ a caller would change the occurrence count and
  appear in `-S`. None ever did: **no page ever called either hook.** Nothing regressed; the UI was never
  built.
- The registry card is a stub — `.claude/campaign/bugs/B13.md` has `state: queued`, `tier: T2`, and every
  analysis section reads `_Not yet analysed._`. Its only symptom is the title, "No way to apply a customer
  advance on web" — an **absence**, not a wrong value. That fails the bug-pipeline entry test (no
  observable wrong output, no repro, no revert probe possible).

Real, worth-fixing gap (for the feature ticket): web can **create** advances and shows the balance
(`apps/web/app/(dashboard)/customers/[id]/page.tsx:1949-1950`, `:2396`, `:3716-3742`, `:4013-4021`) but
offers no way to **spend** one; mobile has `ApplyAdvanceSheet`. Money goes in on web and comes out only on
mobile.

**Recommendation.** Drop **R11** from F09 and file it as a dev-pipeline feature (new UI plus a sheet plus a
Playwright row is feature scope, and T15 is the only F09 test that cannot be red-first). **Keep R12** —
deleting the zero-caller duplicate `useApplyAdvancePayment` (`apps/web/lib/api/customers.ts:282-297`,
identical endpoint and params to `invoices.ts:465-481`, weaker invalidation) is dead-code hygiene that
costs nothing and removes the fork before the feature picks a hook. If the owner wants B13 closed inside
F09 anyway, it ships as a `feat:` commit in the fix PR and must be labelled as such.

---

## Red-gate oracle review

| T#      | file | red today?            | matches the CONFIRMED cause?                                          | verdict                           |
| ------- | ---- | --------------------- | --------------------------------------------------------------------- | --------------------------------- |
| T1      | gate | yes (payment created) | oracle demands an **apply-side** guard; the plan fixes the `where`    | **BLOCKING — O1**                 |
| T2      | gate | yes                   | same                                                                  | **BLOCKING — O1**                 |
| T5      | gate | yes                   | premise factually wrong                                               | **rewrite — O4**                  |
| T6      | gate | yes                   | encodes R4-as-written                                                 | conditional on the R4 ruling — O5 |
| T7      | gate | yes                   | encodes the DRAFT half, which is refuted                              | **rewrite if R4 changes — O5**    |
| T9      | gate | yes                   | sound; survives F03's claim shape                                     | OK (add a scope oracle — O6)      |
| T10     | gate | yes                   | sound                                                                 | OK (same)                         |
| T3      | pins | green today           | traced against `restoreCreditFromPaymentInTx` — oracle exact          | OK, but its probe is dead — O2    |
| T4      | pins | green                 | positive control                                                      | OK                                |
| T8 (x2) | pins | green                 | `create()` writes `status: "ISSUED"` at `:232-240`; cap at `:134-139` | OK                                |
| T11     | pins | green (vacuous)       | scope guard                                                           | OK by design                      |
| T12     | pins | red                   | `forTenant()` returns the same mock object, so the oracle is valid    | OK                                |

**O1 (blocking) — T1/T2/T5 do not test the planned fix.** All three do
`prisma.invoice.findMany.mockResolvedValueOnce([{ ... status: "WRITTEN_OFF"/"VOID" ... }])`, so the `where`
clause is never evaluated (the gate file's header states this is deliberate). Build-plan §2's fix —
`status: { notIn: CREDIT_SETTLE_EXCLUDED }` — therefore leaves **all three still RED after the fix**. The
oracles demand a per-invoice refusal _after_ the fetch. Resolve one way, explicitly: **(a) recommended —**
put the guard in `applyCreditInTx` (or the apply loop) as an **exclude-list** on `inv.status`, which also
closes `autoApplyOldestCreditsInTx` (see B67) and makes the `where` narrowing optional defence in depth;
or **(b)** rewrite T1/T2/T5 to assert the query itself
(`expect(prisma.invoice.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { orderId, status: { notIn: [...] } } }))`),
which then proves nothing about the auto-apply hole.

**O2 (blocking) — two declared mutation probes are dead under the where-only fix.** "drop WRITTEN_OFF from
`CREDIT_SETTLE_EXCLUDED` -> T1 red" and "add PAID -> **T3 red**" both mutate the `where`, and T1-T4's mocks
bypass it. Under the apply-side guard both probes work again. As the plan stands, the design-correction
probe — the one R3 exists for — cannot fire.

**O3 — the where-only fix has an uncosted money side effect.** Excluding WRITTEN_OFF at the query also
removes it from the **shrink** pass (`:935-967`), so excess credit already parked on a written-off invoice
could never be restored to the wallet — precisely the harm R3 argues against for PAID. An apply-side guard
keeps shrink running on WRITTEN_OFF while refusing new applications. This is an argument _for_ O1(a).

**O4 — T5's rationale is false.** `send()` (`:3382`) and `sendEmail()` (`:3588`) use the **2-arg**
`settleOrderCreditsInTx(tx, updated.orderId)`; the explicit-`tenantId` shape belongs to `:1227` / `:2699`.
T5 is therefore a duplicate of T1 wearing a wrong comment. **Retarget it** at the real F07-widened
exposure: `autoApplyOldestCreditsInTx(tx, <WRITTEN_OFF invoice id>, customerId)` with an open credit,
expecting no `invoicePayment.create`. That test is red today and stays red under the plan's current fix —
which is the point.

**O5 — T6/T7 are hostage to the R4 ruling.** T7 (`/DRAFT/`) locks in the refuted half. If S3 adopts the
recommended `{VOID, WRITTEN_OFF}` set, T7 must become a WRITTEN_OFF case, and a new pin must assert that a
**DRAFT** source invoice still creates (protecting `returns.processRefund`).

**O6 — T9/T10 survive F03's shape, but under-specify scope.** The harness sets
`prisma.invoice.updateMany.mockResolvedValue({ count: 1 })`, so the atomic claim passes rather than
throwing `ConflictException`; `orderId = null` short-circuits `adjustInvoicedQtyForInvoice`; ledger and
commission are stubs; T9's call-order oracle works because the function ends on `tx.invoice.findUnique`.
Neither test pins the **query scope** (`where: { invoiceId: id, status: { not: "VOID" } }`) — T11 is the
only scope guard and is vacuous until the loop exists. Add
`expect(prisma.creditNote.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ invoiceId: "inv-void-src-1" }) }))`
to T9.

**O7 — no oracle covers R2 for the other five call sites** beyond "the primitive is fixed". Acceptable
under the primitive-not-call-sites design **only if** the guard lands in `applyCreditInTx` (O1a); with the
`where`-only fix, `autoApplyOldestCreditsInTx` remains an unfixed second primitive with no test at all.

---

## Harness integrity (mocks/specs the planned surface change will break)

1. **`apps/mobile/__tests__/credit-notes-helpers.test.ts`** — asserts DRAFT behaviour at `:16` (cases
   table), `:44` (`it.each`), `:87` (`for (const status of ["DRAFT","APPLIED","VOID"])`). Removing DRAFT
   from `CreditNoteStatus` breaks compilation/assertions; it must change in the same commit or
   `npm run test -w apps/mobile` goes red. Not in P6's file list.
2. **`apps/mobile/lib/credit-notes-logic.ts`** — `creditNotePillFor` DRAFT case and
   `creditNoteActionFlags.canIssue`. Not in P6's file list; listed on B18's registry card.
3. **`create()` fixtures** — any spec stubbing `prisma.invoice.findFirst` for `create({ invoiceId })` must
   now supply `status`. The gate/pins files do; sweep `credit-notes.service.spec.ts` (line-item and
   regulated-ledger `create()` tests) before implementing, or a status-less fixture yields
   `status === undefined` and an **allow-list** guard would reject it. Use an **exclude-list**
   (`EXCLUDED.includes(inv.status)`), never an allow-list, for exactly this reason.
4. **Existing `settleOrderCreditsInTx` specs** (`credit-notes.service.spec.ts:956-1174`, 4 tests) all set
   a `status` on their injected invoices (`SENT`, `PARTIAL`) — safe under an exclude-list guard, red under
   an allow-list.
5. **`voidInvoiceInTx` real-call specs** — `invoices.service.spec.ts:2798` (F03's REG-B84 concurrency
   test) will now execute the new `tx.creditNote.findMany`; `createMockPrisma` defaults `findMany` to
   `[]`, so it stays green. All `orders.*.spec.ts` mock `InvoicesService.voidInvoiceInTx` at the boundary
   — unaffected.
6. **`invoices.send-settle.spec.ts`** (F07, 2 tests) mocks `settleOrderCreditsInTx` at the module boundary
   — it will NOT catch the auto-apply hole and will not break.
7. **`apps/api/src/common/shared-dto-inventory.spec.ts` / `enum-parity.spec.ts`** — re-pointing the app
   `CreditNoteStatus` at `@routeflow/types` is _supported_ by these specs, not blocked; enum-shaped names
   are excluded from the DTO inventory list by design (`shared-dto-inventory.spec.ts:12-19`).

---

## Drift — build-plan "Exact code" vs. `origin/master` (plan base `3d1d8ea9`, now `d12203a3`, ~150 commits)

| symbol / claim in the plan                              | what changed on master                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api/prisma/schema.prisma` (B18 card)              | the schema is a **folder**; the enum is `apps/api/prisma/schema/finance.prisma:56-60` (wave E `60d10e66`, split 10a)                                                                                                                                                                                               |
| "Money math via `pricing.ts` helpers" (spec header)     | the `pricing.ts` mirrors are gone — `@routeflow/pricing` (`packages/pricing`), already imported by both services (`credit-notes.service.ts:11`, `invoices.service.ts:13-19`); the plan's `roundMoney(used)` snippet still works                                                                                    |
| plan §5 "`findAll` include **~:280**"                   | the `include` is at **`:295`**, inside `findAll` `:269-303`                                                                                                                                                                                                                                                        |
| plan §3 "`create()` ~:108"                              | `findFirst` is `:107-121`; the `select` line is `:110`; the insert point is after the customer check at `:124`                                                                                                                                                                                                     |
| plan §2 "settle filter ~:930"                           | still `:929-933` — unchanged since `54aee59d` (2026-07-18)                                                                                                                                                                                                                                                         |
| plan §4 "inside `voidInvoiceInTx`"                      | now F03's atomic-claim shape (`updateMany` + `ConflictException`, `:3836-3843`); insert the loop after `:3846` and **before** `:3850`'s final read (T9's oracle)                                                                                                                                                   |
| "`settleOrderCreditsInTx` ... **six callers**"          | **7** on master: `invoices.service.ts:1227, 2699, 3382, 3588`; `orders.service.ts:2380, 2706, 4298`                                                                                                                                                                                                                |
| — (absent from the plan)                                | **`autoApplyOldestCreditsInTx`** is a second, equally unguarded primitive on the same `send()`/`sendEmail()` path (`invoices.service.ts:3394, 3600`)                                                                                                                                                               |
| `apps/web/lib/api/invoices.ts` hook "482-499"           | now **`:465-481`** (`60d10e66` wave E, `d7dcf393` F13)                                                                                                                                                                                                                                                             |
| `apps/web/lib/api/customers.ts` hook ":288"             | now **`:282-297`**                                                                                                                                                                                                                                                                                                 |
| `deleteInvoice`'s creditNote nulling ":4779-4783"       | now **`:4952-4956`**                                                                                                                                                                                                                                                                                               |
| — (absent from the plan)                                | **`packages/types/api/enums.ts:60-61`** now owns the schema-pinned `CreditNoteStatus`; R7/R8 should re-point `apps/web/lib/api/credit-notes.ts:6` and `apps/mobile/lib/api/credit-notes.ts:8` at `@routeflow/types` instead of hand-editing unions (L-072; wave E precedent in `packages/types/api/misc.ts:37-43`) |
| P5/P6 file lists                                        | miss `apps/mobile/lib/credit-notes-logic.ts` and `apps/mobile/__tests__/credit-notes-helpers.test.ts`; the web credit-note **create form's** invoice picker (`credit-notes/page.tsx:74`, `:340-356`) is also untouched but is implicated by R4                                                                     |
| new file `apps/api/src/invoices/invoice-status-sets.ts` | the name is still free; the natural sibling `payment-predicates.ts` (F03) now exists in that directory — mirror its export style                                                                                                                                                                                   |
| e2e "spec 28" slot                                      | still free (`27-...` then `30-...`; `34-` exists) — but the F13/F25 pipelines are live, so re-confirm the slot at build time                                                                                                                                                                                       |
| `verifyCommands` / red-gate command paths               | unchanged and still valid                                                                                                                                                                                                                                                                                          |
