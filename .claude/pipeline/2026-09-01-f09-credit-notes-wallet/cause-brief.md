# F09 · Cause brief (S1, read-only evidence) — credit notes and wallet integrity

Base: `origin/master` (HEAD at gather time `d12203a3`, "fix(e2e): scope the recurring/standing
toast locators; discharge B59/B91 (#625)"). Sep-1 planning docs (`discovery.md`/`spec.md`/
`test-plan.md`/`build-plan.md`) and the two red-gate specs are read from `HEAD` of this
worktree's branch per the task brief; all other code/log/blame reads are `origin/master`.
No judgment or fix proposals below — evidence only, per instructions.

---

## B13 — No way to apply a customer advance on web

**(1) Registry symptom.** `useApplyAdvanceToInvoice` (claimed at `invoices.ts:482-499`, card
notes "NOT customers.ts") has zero component callers anywhere in `apps/web`; web's
`useApplyAdvancePayment` (`customers.ts:288`) is likewise uncalled. Mobile has a working
`ApplyAdvanceSheet` wired to its own `useApplyAdvancePayment`. Wrong value/behaviour: the web
"Apply advance" capability simply does not exist — no UI renders it.

**(2) Suspected cause (claim, from card/discovery).** Dead code / missing UI wiring only — no
data corruption. Discovery.md CONFIRMED verdict: "Neither has any caller under `apps/web/app`.
Both POST the _identical_ endpoint `/customers/:id/advance-payments/:advanceId/apply` with
identical params — genuine duplication."

**(3) Last change / blame.**

- `apps/web/lib/api/invoices.ts` — hook now at line 465 (drifted from card's 482-499; file
  last touched by `60d10e66` 2026-09-05 "wave E — shared enums/DTOs" and `d7dcf393` 2026-09-05
  F13). Full file log (8): `60d10e66`(2026-09-05), `d7dcf393`(2026-09-05 F13 #612),
  `227c1267`(2026-08-28 deps bump), `4df96132`(2026-08-27 deposit-at-order), `53bda4b4`
  (2026-08-26), `2469840d`(2026-08-26), `ada152ea`(2026-08-25), `9269f60e`(2026-08-23).
- `apps/web/lib/api/customers.ts` — hook now at line 282 (drifted from card's 288). Log (5):
  `60d10e66`, `f950543e`(2026-08-31 F02b tenant scoping), `ada152ea`, `9269f60e`, `7e49b993`.
- Verified directly: `git grep useApplyAdvanceToInvoice\|useApplyAdvancePayment` over
  `origin/master:apps/web` returns ONLY the two definition lines — no JSX/component caller
  anywhere. Confirms the card/discovery claim independently.

**(4) Failing path (excerpts, origin/master).**
`apps/web/lib/api/invoices.ts:465-481` — `useApplyAdvanceToInvoice`, POSTs
`/customers/${customerId}/advance-payments/${advancePaymentId}/apply`.
`apps/web/lib/api/customers.ts:282-297` — `useApplyAdvancePayment`, POSTs the identical route
with identical `{customerId, advancePaymentId, invoiceId, amount}` shape; only the
`onSuccess` invalidation keys differ (statement key added, no `invoices/updated.id` key).

**(5) Existing tests.** None found scoped to either hook or an "Apply advance" web UI — this
is a web-component-level gap, not a service-level one; no `*.test.tsx` under
`apps/web/app/(dashboard)/invoices` was inspected for an apply-advance affordance (out of the
git-log/blame scope given for this bug in the task).

**(6) F03 overlap.** None — F03 (#564) touched only `apps/api/src/invoices/{invoices.service.ts,
invoices.service.spec.ts,payment-predicates.ts}`; no web files.

---

## B18 — Credit-note Issue flow can never trigger

**(1) Registry symptom.** `CreditNoteStatus` enum has no `DRAFT` value; `create()` (and
`Return.processRefund` via the same `create()`) always writes `ISSUED`; `issue()` is a no-op
that just re-fetches. `status === "DRAFT"` can never be true, so the Draft badge, Issue
button, and confirm modal can never render/execute.

**(2) Suspected cause (claim).** Card: enum/status mismatch leaves dead UI on web AND mobile.
Discovery.md widened scope: "CONFIRMED, scope wider than 'web'" — dead affordances exist on
BOTH web (`[id]/page.tsx`) and mobile (`[id].tsx`, `index.tsx` Draft filter chip, `new.tsx`
DRAFT case).

**(3) Last change / blame.**

- `apps/api/prisma/schema/finance.prisma` (schema.prisma was SPLIT by `60d10e66` 2026-09-05
  "wave E — schema folder split (10a)" — the enum now lives at `finance.prisma:56-60`, not
  `schema.prisma:243-247` as the card cites). `CreditNoteStatus { ISSUED APPLIED VOID }` — no
  DRAFT, confirmed on current tree.
- `apps/api/src/credit-notes/credit-notes.service.ts` — `create()` writes `status: "ISSUED"`
  (verified inline in the create() transaction body, ~L239 region); `issue()` is
  `return this.findOne(id)` at **L358-360** (verified verbatim). File log unchanged from B66's
  (below) — last touch `22372911` (2026-09-04, wave B′ pricing-package refactor).
- `apps/web/app/(dashboard)/credit-notes/[id]/page.tsx` — `IssueConfirmModal` defined L34;
  `useIssueCreditNote` imported L23, invoked L243; `status === "DRAFT"` branches at **L410**
  and **L653**; "Issue Credit Note" button/handler at L415-418, L653-663; modal wired L704-709.
  All verified present verbatim on current tree. File log (8): `22372911`(2026-09-04),
  `7e13fbf3`(2026-08-23), `c16c3f60`(2026-08-23 style), `1fd21f12`(2026-08-20 deep-dive B4-B14),
  `1acd3fd6`(2026-08-17), `7be202c5`(2026-08-15), `df529bea`(2026-08-12), `5be1dfac`(2026-08-11).

**(4) Failing path.** `credit-notes.service.ts:358-360`:

```ts
async issue(id: string) {
  return this.findOne(id);
}
```

No status mutation at all. Web page's Draft/Issue branches are consequently unreachable code
paths (never dead-code-eliminated, just never true at runtime).

**(5) Existing tests.** `credit-notes.service.spec.ts` (1349 lines, ~55 `it()`s) has NO
`describe`/`it` mentioning `issue()`, `DRAFT`, or the Issue flow — confirmed by full title
listing (grepped every `describe(`/`it(` in the file); the closest neighbors are `voidCreditNote`
tests (un-reversing ledger for unused/APPLIED credits) which are unrelated.

**(6) F03 overlap.** None — F03 never touched `credit-notes.service.ts` (absent from that
file's 8-commit log) or the schema files.

---

## B19 — Credit notes display raw IDs instead of invoice numbers

**(1) Registry symptom.** List page renders raw `cn.invoiceId` UUID (`findAll` never joins
invoice); detail page also renders `cn.invoiceId` as link text even though its `findOne` call
DOES join `invoice.invoiceNumber`.

**(2) Suspected cause (claim).** Card/discovery: `findAll`'s Prisma query has no `invoice`
include at all, unlike `findOne`'s existing `invoice: { select: { id, invoiceNumber } }`; web
render sites ignore the number data even where available (detail page).

**(3) Last change / blame — verified directly on current tree.**

- `credit-notes.service.ts` `findAll()` (**L269-303**): `include: { customer: { select: { id,
businessName } } }` only — **no `invoice` key** in the include object. Confirmed verbatim.
- `credit-notes.service.ts` `findOne()` (**L331-338**): `include: { customer: {...}, invoice:
{ select: { id: true, invoiceNumber: true } } }` — the contrast the card cites, confirmed
  verbatim.
- `apps/web/app/(dashboard)/credit-notes/page.tsx` **L855-856**: `{cn.invoiceId ? <span
className="font-mono...">{cn.invoiceId}</span> ...}` — raw UUID rendered, confirmed verbatim.
- `apps/web/app/(dashboard)/credit-notes/[id]/page.tsx` **L508-516** and **L638-646**: both
  render `{cn.invoiceId}` as the link text for `href={/invoices/${cn.invoiceId}}` — confirmed
  verbatim (two near-identical blocks, presumably a desktop/mobile-width pair on the same
  page).
- File logs: identical commit sets to B18/B66 above (`credit-notes.service.ts` →
  `22372911`…`59ab9d8c`; `[id]/page.tsx`/`page.tsx` → `22372911`…`5be1dfac`).

**(4) Failing path.** `findAll`'s Prisma `include` object (L297 exact line: `include: {
customer: { select: { id: true, businessName: true } } },`) has no sibling `invoice:` key,
so `cn.invoice` is `undefined` on every row `findAll` returns; the list page has no number to
render even if it wanted to. Detail page HAS the number (`findOne` includes it) but the JSX
at both render sites accesses `cn.invoiceId` instead of `cn.invoice?.invoiceNumber`.

**(5) Existing tests.** No test in `credit-notes.service.spec.ts` asserts on `findAll`'s
`include` shape (no `describe("findAll"` block exists in the file at all — confirmed absent
from the full describe/it listing).

**(6) F03 overlap.** None — same file, no F03 touch.

---

## B66 — Credit notes outlive their source invoice's void / can be issued against VOID/DRAFT

**(1) Registry symptom.** `create()` selects the invoice with no `status` field and no status
check, capping only against `invoice.total` (which void never changes). `voidInvoiceInTx`/
`voidInvoice`/`deleteInvoice` never touch `CreditNote` rows pointing at the invoice.
`autoApplyOldestCreditsInTx` selects candidates by customer/status/expiry with no
source-invoice reference. Wrong behaviour: a voided invoice's credit notes stay ISSUED and
fully spendable elsewhere; fresh credit notes can still be minted against a VOID/DRAFT
invoice's frozen total.

**(2) Suspected cause (claim).** Card/discovery: `create()`'s `tx.invoice.findFirst` selects
only `{ total, customerId, items }` — no `status` — so there is nothing to gate on; void-side,
nothing in `voidInvoiceInTx` ever queries `CreditNote`.

**(3) Last change / blame — verified directly.**

- `credit-notes.service.ts` `create()`'s invoice `findFirst` (**L107-121**): `select: { total,
customerId, items: {...} }` — confirmed no `status` field. Blame: the `select` block itself
  is original to `17c066b2` (2026-07-10); the surrounding `findFirst` call was last touched by
  `ea8a7479` (2026-08-25, "tenant-scope findUnique sweep — cross-tenant read isolation #446"),
  which changed `findUnique`→`findFirst` (tenant-scoping fix) but did NOT add a status field
  or check. Full file log (8): `22372911`(2026-09-04 wave B′ pricing refactor — latest touch),
  `ea8a7479`(2026-08-25), `e460b3f8`(2026-08-23 sales-agents), `23ba11c0`(2026-08-14 "cancelling
  an order gives credit back" #341), `54aee59d`(2026-07-18 "apply customer credit notes to
  orders" #296 — this is where `settleOrderCreditsInTx` was born, see below),
  `ef21ef04`(2026-07-17 SEC-1), `712d4cfe`(2026-07-17), `59ab9d8c`(2026-07-14 "credits wallet +
  auto-apply oldest-first P5-13" #256 — original wallet primitive).
- `invoices.service.ts` `voidInvoiceInTx` (**L3836-3851**): confirmed verbatim — only calls
  `adjustInvoicedQtyForInvoice`, `ledger.reverseInvoiceEntries`,
  `commissionEngine.syncInvoiceCommissionSafe`; **zero** `tx.creditNote.*` calls anywhere in the
  function body. **git blame is mixed and important**: the function skeleton is `23ba11c0`
  (2026-08-14), but lines 3837-3838 and 3841-3843 and 3849-3850 (the atomic
  `updateMany`-as-claim guard + `ConflictException("Invoice was already voided.")`) were
  authored by **`f1599490` — F03, 2026-08-31, PR #564** under its own `F03/R6/T-B84` label
  (concurrent-void-race fix, REG-B84 — an unrelated bug from a different batch). Confirmed by
  reading the F03 diff directly: it adds the comment `F03/R6/T-B84: the flip is an ATOMIC
CLAIM — updateMany on a status guard` and the `ConflictException` lines verbatim. **So F03
  DID modify `voidInvoiceInTx` itself** (see item 6).
- `invoices.service.ts` `deleteInvoice`'s `tx.creditNote.updateMany({ where: { invoiceId: id },
data: { invoiceId: null } })` is at **L4952-4956** (card's citation `:4779-4783` already
  carried a self-noted re-anchor to "~L4755 on master@6c8f1401"; it has since moved further to
  ~L4953 after wave E's schema split + F13 + the 2b cron work touched the file — three commits
  land after `6c8f1401` in this file's history: `1f6483ec`(2026-09-05 F25 calendar),
  `22372911`(2026-09-04 wave B′), landing on top of `7dcf390c`(2026-09-01 F07 #588)). Blame:
  this exact nulling logic is original to `d7f71c66` (2026-03-31) — pre-dates the campaign
  entirely; only nulls `invoiceId`, never touches `amount`/`amountUsed`/`status`.
  `autoApplyOldestCreditsInTx`'s candidate query (**L487-494** in `credit-notes.service.ts`,
  confirmed): `where: { customerId, status: { not: "VOID" }, OR: [{expiresAt:null},
{expiresAt:{gt:now}}], ... }` — no `invoiceId` filter of any kind, confirming no
  source-invoice linkage exists in that selection either.

**(4) Failing path (excerpts).**

```ts
// credit-notes.service.ts create(), L108-121 — no status field, no status gate:
const invoice = await tx.invoice.findFirst({
  where: { id: dto.invoiceId },
  select: { total: true, customerId: true, items: { select: {...} } },
});
```

```ts
// invoices.service.ts voidInvoiceInTx, L3836-3851 — no CreditNote touch:
async voidInvoiceInTx(tx: any, id: string, orderId: string | null) {
  const claimed = await tx.invoice.updateMany({
    where: { id, status: { not: InvoiceStatus.VOID } },
    data: { status: InvoiceStatus.VOID },
  });
  if (claimed.count === 0) throw new ConflictException("Invoice was already voided.");
  await this.adjustInvoicedQtyForInvoice(tx, id, orderId, -1);
  await this.ledger.reverseInvoiceEntries({ invoiceId: id, db: tx });
  await this.commissionEngine.syncInvoiceCommissionSafe(id, tx);
  return tx.invoice.findUnique({ where: { id } });
}
```

Contrast (the manual path that already gates, per the card): `applyToInvoice` **L537-546**
builds `notApplicableStatuses: [PAID, VOID, WRITTEN_OFF]` and throws if `inv.status` is in it
— confirmed verbatim, the exact contrast cited.

**(5) Existing tests.** `invoices.service.spec.ts` has a describe block
`"voidInvoiceInTx — atomic claim under concurrent void (T-B84 / R6 / REG-B84)"` (**L2798**)
whose only `it()` (**L2799**) is "two concurrent voidInvoice calls on one SENT invoice: exactly
one succeeds, invoicedQty releases exactly once" — this is F03's own REG-B84 concurrency test;
it asserts nothing about CreditNote rows. No test anywhere in `invoices.service.spec.ts` or
`credit-notes.service.spec.ts` asserts that voiding an invoice touches/caps a sourced credit
note, and `credit-notes.service.spec.ts` has no `describe("create"` block that checks
`invoice.status` at all (only line-item/regulated-ledger-linkage tests reference `create()`
indirectly).

**(6) F03 overlap — confirmed, non-trivial.** F03 (`f1599490`, #564) rewrote `voidInvoiceInTx`'s
opening lines from a plain `tx.invoice.update` into the atomic
`updateMany`-where-status-guard + `ConflictException` pattern shown above, under its own
`F03/R6/T-B84` label (a concurrent-double-void race, unrelated to B66's credit-note concern).
F03 added **zero** CreditNote handling to the function. Net effect for B66: the function's
control flow that any credit-note-capping fix must extend is F03's shape (guard on
`claimed.count`, not the pre-F03 unconditional update) — the pre-F03 version of this function
no longer exists on master.

---

## B67 — Order-edit settle applies wallet credit to WRITTEN_OFF invoices

**(1) Registry symptom.** `settleOrderCreditsInTx` — called unconditionally inside every
`updateOrderItems` edit (per card/discovery; also inside `send()`/`sendEmail()`, see below) —
filters invoices only by `status != VOID`, so WRITTEN_OFF passes. `applyCreditInTx` has no
status gate and creates a `CREDIT_NOTE` `InvoicePayment` + increments `amountUsed`, while
`recomputeStatus` preserves WRITTEN_OFF so the invoice's visible status never moves (silent
consumption).

**(2) Suspected cause (claim).** Card: hand-rolled `status: { not: 'VOID' }` filter at
`settleOrderCreditsInTx`'s invoice query, contrasted with `applyToInvoice`'s explicit
`notApplicableStatuses` (which DOES include WRITTEN_OFF) and
`recordDeliveryPaymentInTx`'s `PAYABLE` allow-list (which also excludes WRITTEN_OFF).
Discovery.md's cross-batch finding: F07 (#588) **widened** the blast radius by adding two new
`settleOrderCreditsInTx` call sites (`send()`, `sendEmail()`) that only refuse `VOID`, not
WRITTEN_OFF, on the invoice being sent.

**(3) Last change / blame — verified directly.**

- `credit-notes.service.ts` `settleOrderCreditsInTx`'s invoice query
  `where: { orderId, status: { not: "VOID" } }` is at **L930** exactly (card cited :929-933,
  confirmed still in range). **Blame: this exact filter line has been UNTOUCHED since
  `54aee59d` (2026-07-18, "apply customer credit notes to orders (create + any-stage edit)
  #296")** — i.e., since the function was created; no subsequent commit (including F03, F07,
  or wave B′) has ever edited this line. It is the original, never-revised filter.
- `applyCreditInTx` (**L369-445**): confirmed no status gate anywhere in the function body —
  it computes `alreadyPaid` from `inv.payments` filtered only by `p.status !== "VOID"` (own
  local filter, NOT F03's `sumConfirmed`/`CONFIRMED_PAYMENT` — see item 6) and unconditionally
  writes the `InvoicePayment` + `creditNote.update`.
- `recomputeStatus` (**L40-58** in `credit-notes.service.ts`, a private duplicate of
  `invoices.service.ts`'s own `recomputeStatus` at L217): "DRAFT, VOID, and WRITTEN_OFF are
  terminal/deliberate states — never auto-override" — returns `currentStatus` unchanged for
  WRITTEN_OFF, confirming the "silent" half of the claim (status can't move even though money
  moved).
- `applyToInvoice`'s contrast (**L537-546**, confirmed verbatim): `notApplicableStatuses =
[PAID, VOID, WRITTEN_OFF]`.
- `invoices.service.ts` `recordDeliveryPaymentInTx`'s `PAYABLE` list (**L4513-4516**,
  confirmed verbatim): `const PAYABLE = [DRAFT, SENT, PARTIAL, OVERDUE]` (an allow-list that
  also excludes WRITTEN_OFF by omission), used at `where: { orderId, status: { in: PAYABLE } }`
  (L4537) — with an adjacent comment (L4510-4512, confirmed): "Payable statuses — exclude
  terminal VOID/WRITTEN_OFF: a written-off bad debt must not swallow the cash."
- **F07 call-site widening — verified directly, not just cited.** `invoices.service.ts`
  `send()` (function starts ~L3356): checks only `if (inv.status === InvoiceStatus.VOID) throw
new BadRequestException("Cannot send a voided invoice")` — no WRITTEN_OFF check — then, inside
  its transaction, calls `this.creditNotes.settleOrderCreditsInTx(tx, updated.orderId)` at
  **L3382**, with a comment crediting "B108: make the 'send() catches up' comment above
  actually true." A parallel block exists for `sendEmail()` around L3588 (same pattern, same
  comment lineage, per grep of `settleOrderCreditsInTx` call sites). Both call sites were added
  by **`7dcf390c`, F07, #588, 2026-09-01** — confirmed present in `invoices.service.ts`'s file
  log as the most recent commit before wave B′ that could plausibly add call sites, and by the
  presence of the dedicated spec file below.
- `settleOrderCreditsInTx` full call-site count on current tree: `invoices.service.ts` L1227,
  L2699, L3382 (`send()`), L3588-ish (`sendEmail()`); `orders.service.ts` L2380, L2706, L4298 —
  7 sites total across the two files (discovery.md's count of "six" is close but not exact
  against the current tree; not reconciled further here per no-judgment scope).
- `orders.service.ts` file log (8, for context): `1ebd4f54`(2026-09-05 leader-elected crons),
  `d7dcf393`(2026-09-05 F13), `22372911`(2026-09-04 wave B′), `f60bd27c`(2026-09-04 imp-02
  advisory lock), `d0769701`(2026-09-02 F11), `7dcf390c`(2026-09-01 F07 #588),
  `e6d1ab34`(2026-09-01 F06 #573), `5219e620`(2026-08-31 F30).

**(4) Failing path (excerpt, confirmed verbatim).**

```ts
// credit-notes.service.ts settleOrderCreditsInTx, L929-933:
const invoices = await tx.invoice.findMany({
  where: { orderId, status: { not: "VOID" } }, // WRITTEN_OFF passes through
  include: { payments: true },
  orderBy: { invoiceNumber: "asc" },
});
```

```ts
// invoices.service.ts send(), ~L3356-3382:
async send(id: string, opts?: { allowPreDelivery?: boolean }) {
  const inv = await this.findOneOrThrow(id);
  if (inv.status === InvoiceStatus.VOID)
    throw new BadRequestException("Cannot send a voided invoice");   // WRITTEN_OFF not checked
  ...
  if (updated.orderId) {
    await this.creditNotes.settleOrderCreditsInTx(tx, updated.orderId);
  }
```

**(5) Existing tests.** `credit-notes.service.spec.ts` `describe("settleOrderCreditsInTx"`
(**L956-1174**) has 4 `it()`s: "applies a stored (null-amount) intent... idempotent" (L957),
"shrink pass: invoice total dropped below Σ payments..." (L1040), "explicit-amount intent
applies exactly min(...)" (L1102), "is a no-op when the order has no non-VOID invoices yet"
(L1156) — none constructs a WRITTEN_OFF invoice fixture; the L1156 test's title itself encodes
only the VOID exclusion as the tested boundary. `invoices.send-settle.spec.ts` (212 lines,
F07-authored) has exactly 2 tests: "REG-B108 (T17): send() settles order credits before the
oldest-first sweep..." (L167) and "REG-B108 (T18): sendEmail() settles..." (L193) — both prove
the settle call HAPPENS at the right point, neither constructs a WRITTEN_OFF invoice or asserts
an exclusion.

**(6) F03 overlap — confirmed, narrow and load-bearing.** F03 (#564) introduced
`payment-predicates.ts` (`CONFIRMED_PAYMENT` + `sumConfirmed`) and routed ~20 call sites across
`invoices.service.ts` through it (verified: 20 occurrences of `sumConfirmed`/`CONFIRMED_PAYMENT`
in the current file, spanning `send()`, `writeOff`, `deleteInvoice`, `recordPayment`, etc.).
**F03 did NOT touch `credit-notes.service.ts` at all** (absent from its 8-commit file log) —
`applyCreditInTx`'s own `alreadyPaid` computation still uses the pre-F03 local filter
(`(inv.payments ?? []).filter((p) => p.status !== "VOID")`, **L392-395**) rather than F03's
`CONFIRMED_PAYMENT`/`sumConfirmed`. This is a fact about drift between the two services, stated
without a fix recommendation per scope.

---

## Red-gate specs on the branch (HEAD) — titles and oracles

**`apps/api/src/credit-notes/credit-notes.wallet-integrity.spec.ts`** (must report "0 passed"
today — RED BY DESIGN):

- **T1** (`REG-B67`) — WRITTEN_OFF invoice, unmet credit intent → oracle:
  `prisma.invoicePayment.create` NOT called; `result.applied === 0`.
- **T2** (`REG-B67`) — same but VOID invoice (pins existing exclusion) → same oracle.
- **T5** (`REG-B67`) — same WRITTEN_OFF case called with an explicit `tenantId` param (the
  `send()`/`sendEmail()` calling shape) → same oracle; proves the fix covers F07's call sites
  via the primitive.
- **T6** (`REG-B66`) — `create({invoiceId})` against a VOID invoice → oracle: caught error
  `instanceof BadRequestException`, message matches `/VOID/`, `prisma.creditNote.create` NOT
  called.
- **T7** (`REG-B66`) — same for DRAFT invoice → oracle: message matches `/DRAFT/`, no create.
- **T9** (`REG-B66`) — `voidInvoiceInTx` on an invoice with a fully-unused sourced credit note
  (`amountUsed=0`) → oracle: `creditNote.update` called with `{status:"VOID"}` for that note
  id, AND a call-order oracle (the update must precede the final `invoice.findUnique` read).
- **T10** (`REG-B66`) — partly-used sourced note (`amount:100, amountUsed:40`) →
  oracle: `creditNote.update` called with `{amount:40}`; NOT called with `{status:"VOID"}`;
  `invoicePayment.delete` never called; no `amountUsed` field ever written.

**`apps/api/src/credit-notes/credit-notes.wallet-integrity.pins.spec.ts`** (green-pre-fix
guards, run by the ordinary suite, excluded from the red-gate command):

- **T3** (`REG-B67`) — PAID invoice whose total shrank below payments → oracle:
  `result.unapplied === 40`; `invoicePayment.update` called restoring `pay-credit-p` to
  `{amount:20}`; `invoicePayment.delete` NOT called; `creditNote.update`'s first call has
  `data.amountUsed === 20`. Anti-regression for "PAID must stay IN the settle set."
- **T4** (`REG-B67`) — SENT invoice with balance → oracle: `result.applied === 40`;
  `invoicePayment.create` called with `{invoiceId, amount:40, creditNoteId}`. Positive control
  against over-exclusion.
- **T8** (`REG-B66`, two `it()`s) — live SENT invoice → oracle (a): `creditNote.create` called
  with the expected data, `status:"ISSUED"`; oracle (b): existing over-credit cap still
  `rejects.toThrow(/exceed invoice total/)`, no create call.
- **T11** (`REG-B66`) — credit note sourced from a DIFFERENT invoice, present in the fetched
  set anyway → oracle: `creditNote.update` NEVER called with `{where:{id:"cn-other-inv"}}`.
  Negative/defense-in-depth control.
- **T12** (no REG token, R9/B19) — oracle: `prisma.creditNote.findMany` called with
  `include` containing `invoice: {select:{id:true, invoiceNumber:true}}`. Deliberately
  red today (findAll has no such include) but excluded from the gate file by the
  test-plan's token-discipline rule (a REG-B19 jest token would let campaign-check discharge
  a Playwright-only T2 row without spec 28 ever running).

Both files share the harness: real `CreditNotesService`/`InvoicesService` over
`createMockPrisma()`, `InvoicePdfService` module-mocked to dodge the `@react-pdf/renderer`
ESM-import problem, every other collaborator a `useValue` stub.
