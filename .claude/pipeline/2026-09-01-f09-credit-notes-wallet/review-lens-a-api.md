# F09 · Review lens A — api money correctness (Opus, 2026-09-06)

Branch `fix/F09-credit-notes-wallet` @ `5c0dc464`, base `d12203a3`. READ-ONLY, committed content only
(`git show HEAD:` / `git grep HEAD`); no working-tree file under `apps/` was read; no jest, no build.

## VERDICT: **FIX-THEN-SHIP**

The four in-scope primitives are correct and spec-compliant: the `applyCreditInTx` guard closes both
apply doors with one line (R1/R2/R3 preserved, PAID deliberately still in the settle set), `create()`
refuses VOID/WRITTEN_OFF and keeps DRAFT, the void cap never deletes an `InvoicePayment` and never
writes `amountUsed` (R6), tenancy is intact on every new query, and the shared status module is a real
consolidation. What blocks a clean ship is **fallout the diff did not follow through**: two API QA
harnesses still call the deleted `/issue` route, and `returns.processRefund` can now throw _after_ it
has already claimed the return REFUNDED — losing a customer refund with no recovery path.

Counts: **1 blocker · 3 major · 5 minor · 2 nit**.

---

## Findings

### A1 — blocker — two API QA harnesses still POST the deleted `/credit-notes/:id/issue`

- **file:line** — `apps/api/scripts/e2e-verify.ts:1286-1302`; `apps/api/scripts/qa-run.js:1295-1303`
- **claim** — `credit-notes.controller.ts` lost `@Post(":id/issue")` (diff) and the service lost
  `issue()`. Both harnesses still call the route over raw HTTP. `qa-run.js:1302` asserts
  `r.status === "ISSUED"` and will hard-fail on a 404 body; `e2e-verify.ts:1298-1301` accepts only
  `[200,201,400]`, so a 404 fails that check too.
- **refutation attempt** — (a) _maybe nothing references them_: `git grep -rn "e2e-verify" HEAD -- .`
  returns only the file itself; `qa-run` is referenced only by `apps/api/scripts/qa-ui-checklist.md:4`
  ("Complement to: `qa-run.js` (175 API-level tests)") — so they are **manual** harnesses, not CI-gated
  (no hit in `package.json`, `apps/api/package.json`, `.github`). That lowers the blast radius but does
  not refute the breakage. (b) _maybe a symbol grep would have caught it_: no —
  `git grep -n "\.issue(\|useIssueCreditNote\|issueCreditNote" HEAD -- apps packages` returns **nothing**
  (exit 1), which is exactly why these two string-literal URL callers were missed. Survives.
- **failure scenario** — the owner runs the shipped API QA harness after deploy; test 53 fails with
  `status=undefined` / a 404, and the operator cannot tell a real regression from this dead check.
- **proposed fix** — delete the `POST /credit-notes/:id/issue` check from both files, in this PR — R7
  says "every Issue affordance is removed".

### A2 — major — `processRefund` now throws _after_ claiming the return REFUNDED: a refund is lost

- **file:line** — `apps/api/src/returns/returns.service.ts:311-323` (invoice select), `:347-358`
  (the atomic RECEIVED→REFUNDED claim), `:369-375` (the `creditNotes.create` call) vs the new guard at
  `apps/api/src/credit-notes/credit-notes.service.ts:135-139`
- **claim** — the order's invoices are selected with **no status filter**
  (`:318 invoices: { select: { id: true } }`), and `:372` passes
  `invoiceId: invoices.length === 1 ? invoices[0].id : undefined`. If that single invoice is VOID or
  WRITTEN_OFF, `create()` now throws `BadRequestException`. The claim at `:347` is a **separate**
  `forTenant().return.updateMany` and `create()` opens its **own** Serializable tx (comment `:366`
  "Sequential, NOT nested"), so the REFUNDED / refundMethod / refundAmount / refundedAt write is already
  committed when the throw happens.
- **refutation attempt** — (a) _maybe a return can't exist against a dead invoice_: nothing in
  `returns.service.ts` filters on invoice status at create/receive; voiding an invoice
  (`invoices.service.ts:3885`) and writing one off do not touch `Return` rows. (b) _maybe the caller
  retries_: `:356` refuses — `"Only RECEIVED returns can be refunded"` — the return is now terminally
  REFUNDED with `creditNoteId` null. (c) _maybe T7b covers it_: T7b pins only the **DRAFT** source; no
  test exercises `processRefund` at all. Survives.
- **failure scenario** — order has one invoice; operator writes the invoice off as bad debt (or voids it
  to re-split); the customer then returns goods; operator receives the return and clicks Refund →
  HTTP 400. The return shows REFUNDED with `refundAmount` set, **no credit note exists**, and the flow
  cannot be re-run. The customer's returned goods are unpaid-for.
- **proposed fix** — scope the select to a live source, e.g.
  `invoices: { where: { status: { notIn: [VOID, WRITTEN_OFF] } }, select: { id: true } }`, so the credit
  is minted **unsourced** rather than refused (a lump-sum credit with no `invoiceId` is already the
  multi-invoice path at `:372`).

### A3 — major — the void cap silently destroys return-backed credit, with no warning and no recovery

- **file:line** — `apps/api/src/invoices/invoices.service.ts:3860-3880` (the cap) ·
  `apps/api/src/returns/returns.service.ts:370-378` (`Return.creditNoteId` is written and never cleared)
- **claim** — `processRefund` mints the return's store credit **against the order's single invoice**, so
  that note has `invoiceId = A`. Voiding invoice A now VOIDs the note outright when it is unspent
  (`used <= 0.001`). R5's rationale ("a credit note's headroom dies with the invoice that justified it")
  does not hold for this note: its justification is the _returned goods_, not the invoice.
- **refutation attempt** — (a) _maybe the release step already returned the money_: no — `voidInvoice`
  runs `releaseWalletPaymentsInTx` first (`:3906`), which restores credit **spent on** invoice A; a
  return-backed note that was never spent has `amountUsed = 0` both before and after, so it lands
  squarely in the VOID branch. (b) _maybe the return can be re-refunded_: no — `returns.service.ts:325`
  and `:356` both require `RECEIVED`; the row is REFUNDED. (c) _maybe the operator is warned_: no —
  `previewOrderCreditRelease` (`credit-notes.service.ts:838`) previews _applied_ credit only; nothing
  previews the notes a void is about to kill. (d) _maybe it is recoverable_: only by manually minting a
  new note — which the same new guard blocks while the invoice is VOID. Survives.
- **failure scenario** — customer returns $30 of goods against invoice A ($100); credit CN-0007 issued
  and not yet spent. Operator voids A to re-issue a corrected invoice. CN-0007 → VOID. The corrected
  invoice bills the full amount; the customer is out $30 and there is no artifact showing why.
- **proposed fix** — owner decision. Minimum: skip notes referenced by a `Return` (a
  `tx.return.findMany({ where: { creditNoteId: { in: ids } } })` skip-list before the loop), and/or add a
  preview so `voidInvoice` reports which notes it will void, mirroring `previewOrderCreditRelease`.

### A4 — major (sibling, out of the literal spec) — invoice **deletion** leaves sourced credit fully spendable

- **file:line** — `apps/api/src/invoices/invoices.service.ts:4979-4983` (`deleteInvoice` explicitly does
  `creditNote.updateMany({ where: { invoiceId: id }, data: { invoiceId: null } })`) ·
  `apps/api/src/orders/orders.service.ts:5531-5552` (order delete hard-deletes invoices without going
  through `deleteInvoice`; `CreditNote.invoice` is `Invoice?` with the default optional-relation
  `SetNull`, `apps/api/prisma/schema/finance.prisma:474,494`)
- **claim** — B66's symptom is "a credit note outlives its source invoice's death". P3 closes the _void_
  door. The _delete_ door is wide open and is the more destructive one: the note keeps its **full**
  `amount` and loses its provenance entirely (`invoiceId: null`), so no later report can even find it.
- **refutation attempt** — (a) _maybe delete is blocked when credit exists_: `deleteInvoice:4963` blocks
  only on `inv.payments.length > 0`; a note sourced from the invoice implies no payment on it, so the
  guard does not fire. (b) _maybe the spec deliberately scoped this out_: `cause-ruling.md` §2 names only
  `create()` + `voidInvoiceInTx`, so it is out of the **letter** of this PR — but `orders.service.ts` and
  `invoices.service.ts` are both in `radiusFiles` §4, and shipping the void half alone makes the
  inconsistency worse (void kills the credit, delete gifts it). Survives; scope is the owner's call.
- **failure scenario** — invoice A ($100, SENT, unpaid), CN-0009 ($100) issued against it, invoice A
  deleted. CN-0009 survives with $100 spendable and `invoiceId = null`; the customer applies it to a
  real invoice. Free money, untraceable.
- **proposed fix** — file as a follow-up (recommended) or, if bundled, run the same cap loop in
  `deleteInvoice` before the unlink at `:4980` and in the order-delete loop at `orders.service.ts:5537`.

### A5 — minor — the cap runs at the default isolation level; a concurrent apply can leave `amount < amountUsed`

- **file:line** — `apps/api/src/invoices/invoices.service.ts:3903`
  (`this.prisma.tenantTransaction(async (tx) => {` — **no** `isolationLevel`) vs the sibling caller
  `apps/api/src/orders/orders.service.ts:2735,2770` (`{ isolationLevel: "Serializable", timeout: 15_000 }`),
  and the cap read/write pair at `:3860` / `:3870`
- **claim** — the atomic claim at `:3844` locks the **invoice** row only. Between `tx.creditNote.findMany`
  (`:3860`) and `tx.creditNote.update` (`:3870`), a concurrent `applyToInvoice` /
  `settleOrderCreditsInTx` (both Serializable, both targeting a _different_ invoice) can raise the note's
  `amountUsed`. The update writes `amount: roundMoney(stale used)` as a blind full-column write, so the
  row can end at `amount = 40, amountUsed = 60`.
- **refutation attempt** — (a) _maybe Serializable on the other side protects it_: no — Postgres SSI
  aborts only conflicting **serializable** pairs; the READ COMMITTED voider is not a participant, so
  nothing aborts. (b) _maybe an advisory lock covers it_: `apps/api/src/common/db-locks.ts` is
  customer-keyed for order merges only, and `voidInvoice` takes none. (c) _is the damage real?_ Wallet
  readers floor at zero (`customers.service.ts:331,350`; `buyer/statement.service.ts:140`), so no negative
  balance is shown — but `bookkeeping.service.ts:2152` reports `balance: amount − amountUsed` = **−20**,
  and the invariant `amount ≥ amountUsed` that every other writer maintains is broken. Survives; narrow
  window.
- **failure scenario** — operator A voids invoice X while operator B applies the same note to invoice Y.
  Receivable Summary shows a negative credit-note balance; `roundMoney(amount − amountUsed) > 0.001` is
  permanently false, so the note can never be spent or restored to sanity.
- **proposed fix** — one argument:
  `this.prisma.tenantTransaction(async (tx) => {…}, { isolationLevel: "Serializable" })` at
  `invoices.service.ts:3903`, matching the orders-side caller. (Alternative: make the cap a guarded
  `updateMany({ where: { id: cn.id, amountUsed: cn.amountUsed }, … })`.)

### A6 — minor — a **fifth** hand-rolled status filter on a wallet-money write was not re-pointed

- **file:line** — `apps/api/src/customers/customers.service.ts:1177`
  `if (["PAID", "VOID", "WRITTEN_OFF"].includes(inv.status)) {` guarding
  `tx.invoicePayment.create({ … method: "ADVANCE" … })` at `:1193`
- **claim** — this is `CREDIT_NOT_APPLICABLE` written as string literals, on the _advance_ wallet's apply
  path — the exact twin of the `applyToInvoice` literal the diff correctly replaced
  (`credit-notes.service.ts:555`). Spec R3a's premise is "four independently hand-rolled status filters is
  how B67 exists"; this is the fifth, and it is the one on the other wallet.
- **refutation attempt** — (a) _maybe it is a different set_: it is byte-identical to
  `CREDIT_NOT_APPLICABLE` (`invoice-status-sets.ts:2-6`). (b) _maybe it is out of scope_:
  `cause-ruling.md` §2 names only two literals to re-point, so it is out of the letter — but it is a
  zero-risk, behaviour-neutral edit that removes the exact drift vector the shared module exists to kill.
  Survives as cheap follow-through.
- **failure scenario** — the next status added to the terminal set is added to the shared module and to
  `applyToInvoice`, and advances silently keep flowing into it.
- **proposed fix** — `if (CREDIT_NOT_APPLICABLE.includes(inv.status)) {` + the import; behaviour-neutral.

### A7 — minor — the `status: APPLIED` decision on a partial cap has **no oracle**

- **file:line** — `apps/api/src/invoices/invoices.service.ts:3878` vs
  `apps/api/src/credit-notes/credit-notes.wallet-integrity.spec.ts:479-497` (T10)
- **claim** — T10 asserts `data` **contains** `amount: 40`, asserts the update was **never** called with
  `status: "VOID"`, and asserts no `amountUsed` write — but makes **no** claim about `status: "APPLIED"`.
  The mutation "delete `status: CreditNoteStatus.APPLIED` from the capped branch" leaves 15/15 green, even
  though it changes what `bookkeeping.getRefundHistory` (`:2028`, filters `status: APPLIED`) reports.
- **refutation attempt** — (a) _maybe another test covers it_: no other test in either file touches the
  partial-cap branch. (b) _maybe it does not matter_: it does — an ISSUED note with zero headroom is
  exactly the "stale ISSUED" state the code comment at `:3875-3877` says must not exist, and it changes a
  money report's membership. Survives.
- **failure scenario** — a later refactor drops the status write; the note reads ISSUED with zero headroom
  forever, invisible to the refund-history report, and no test notices.
- **proposed fix** — extend T10's positive assertion to
  `data: expect.objectContaining({ amount: 40, status: "APPLIED" })`.

### A8 — minor — `unvoidInvoice` does not restore capped/voided notes (asymmetry)

- **file:line** — `apps/api/src/invoices/invoices.service.ts:4078-4097` (unvoid re-claims `invoicedQty`
  only), reachable from `apps/api/src/invoices/invoices.controller.ts:206-209`
- **claim** — void → cap/VOID the sourced notes; unvoid → invoice back to DRAFT, notes stay dead. The
  credit note number the customer was told about no longer exists.
- **refutation attempt** — partially successful: `create()`'s over-credit cap aggregates only
  `status: { not: "VOID" }` notes (`credit-notes.service.ts:142`) and sums the (now-reduced) `amount`, so
  after an unvoid the invoice's credit headroom is correctly free again and the operator **can** mint a
  replacement note. There is also documented precedent for unvoid asymmetry (`:4087-4088` — the regulated
  ledger is not un-reversed either). That downgrades this from money loss to paperwork. Survives at minor.
- **failure scenario** — operator voids by mistake, unvoids, and CN-0007 is gone; a new number must be
  issued and explained to the customer.
- **proposed fix** — no code change required; call it out in the close-out / deploy-day notes (the spec's
  operator-visible delta list already carries item (2) and should carry this).

### A9 — minor — the shrink/restore path can resurrect headroom on a capped note

- **file:line** — `apps/api/src/credit-notes/credit-notes.service.ts:646-667`
  (`restoreCreditFromPaymentInTx`) reached from the settle SHRINK pass (`:950-980`) and
  `unapplyFromInvoice` (`:1023`)
- **claim** — after P3 caps a note to `amount = amountUsed = 40 (APPLIED)`, a later restore of $15 from the
  invoice the credit was spent on sets `amountUsed = 25`, `fullyApplied` false → `status: "ISSUED"`,
  `amount` still 40 → **$15 of spendable headroom returns**, backed by a source invoice that is VOID.
  R5's "headroom dies with the invoice" is therefore not permanent.
- **refutation attempt** — largely successful on intent: the alternative (refusing the restore) destroys
  money the customer really spent, which R6 forbids in spirit; and the invariants the review brief asks
  about hold — `amountUsed` is floored at 0 (`:648 Math.max(0, …)`) and `amount` (40) ≥ `amountUsed`
  (reduced) after any restore, so nothing goes negative or inconsistent. The only path that _does_ break
  the invariant is A5's race, not this. Survives only as an undocumented limitation.
- **failure scenario** — none that corrupts data; a small amount of wallet credit outlives its source
  invoice after an order edit.
- **proposed fix** — record it under the spec's Non-goals, so the D4 data-repair report
  (`cause-ruling.md` §6) does not classify these rows as corruption.

### A10 — nit — the in-loop `invoiceId` filter is production-dead and blunts T11's scoping oracle

- **file:line** — `apps/api/src/invoices/invoices.service.ts:3865-3868`
- **claim** — the DB `where` at `:3861` already restricts to `invoiceId: id`; the loop guard can only fire
  against a mock. Worse, a _future_ broadening of the `where` would still leave T11 green (the loop would
  filter the extra rows out) — the guard partially defeats the oracle it was added for
  (`stage-a-report.md` §3).
- **refutation attempt** — successful enough to keep it: T9 (`:446-450`) independently asserts the
  `findMany` `where` contains `{ invoiceId: <id> }`, so query scoping is still pinned by a separate
  oracle, and the guard is cheap defense-in-depth against an unwrapped-tx future. Downgraded to nit.
- **proposed fix** — none required; keep the comment as is.

### A11 — nit — T2 is weaker than T1, and the cap re-writes already-consumed notes

- **file:line** — `credit-notes.wallet-integrity.spec.ts:227-228` (T2 asserts only `invoicePayment.create`
  - `result.applied`; T1 at `:173-178` additionally asserts `creditNote.update` was never called) ·
    `invoices.service.ts:3870` (a note already at `amount === amountUsed`, status APPLIED, is re-written
    with identical values)
- **claim / refutation** — T2 is still non-vacuous (red pre-fix, because the pre-fix apply loop had no
  per-invoice status check), and the redundant write is a no-op inside the same tx. Both cosmetic.
- **proposed fix** — optional: add `expect(prisma.creditNote.update).not.toHaveBeenCalled();` to T2; skip
  the update when `used > 0.001 && roundMoney(used) === Number(cn.amount)`.

---

## The 11 questions

**1. `applyCreditInTx` guard covers every money write? — CONFIRMED-COMPLETE (no issue).**
The guard is at `credit-notes.service.ts:402-407`, immediately after the parameter list and **before**
`remaining` is computed and before every write. The only `tx.invoicePayment.create` in the file is `:432`,
inside `applyCreditInTx`, downstream of the guard. `creditNote.update` sites: `:452` (applyCreditInTx —
gated), `:657` (`restoreCreditFromPaymentInTx` — a _restore_, which must NOT be gated: gating it would
break the T3/T3b shrink pins and strand money), `:1102` (`updateCreditNote` — text/expiry only), `:602`
`updateMany` (`voidCreditNote`). Both apply doors funnel through the one guard:
`autoApplyOldestCreditsInTx:526` and `settleOrderCreditsInTx:1008`; the third caller `applyToInvoice:564`
is additionally pre-gated by `CREDIT_NOT_APPLICABLE:555`. `returns.processRefund` never applies credit
(it only mints). **No second door.**

**2. Does the deliberate `status: { not: "VOID" }` at `:943` let WRITTEN_OFF receive credit via SHRINK or
restore? — REFUTED for "receive credit"; see A9 for the headroom nuance.**
Shrink (`:950-980`) only calls `restoreCreditFromPaymentInTx`, which _deletes/shrinks_ an existing payment
and _decrements_ `amountUsed` — it can never create an `InvoicePayment`. The apply pass reaches
`applyCreditInTx`, which returns `{applied:0}` for WRITTEN_OFF and the loop `continue`s (`:1009`). So
WRITTEN_OFF never receives credit. Invariants: `amountUsed` cannot go below zero (`:648 Math.max(0, …)`),
and after a restore `amount` (unchanged) ≥ `amountUsed` (reduced) — no `amount`/`amountUsed`
inconsistency arises from restore. A restore **can** re-open headroom on a capped note (A9, minor), and a
P3-VOIDed note cannot be revived through `:662` because a note with `amountUsed = 0` has no surviving
CREDIT_NOTE payment for a restore to find.

**3. P3 ordering vs `releaseWalletPaymentsInTx` — no over-cap, no under-cap; the self-application outcome
is INTENDED (R5). CONFIRMED as designed.**
Both callers release first: `invoices.service.ts:3906→3907` and `orders.service.ts:2754→2755` (there are
no other callers of `voidInvoiceInTx`). `releaseWalletPaymentsInTx:3805` → `releaseInvoiceCreditsInTx` →
`restoreCreditFromPaymentInTx`, which **decrements** `amountUsed` and restores headroom; it never
increases `amountUsed`. Therefore the cap can only read a `used` that is ≤ the pre-release value —
**under-cap is impossible**, and "over-cap" in the R6 sense (clawing back spent credit) is impossible
because the dollars it stops counting were _just handed back_ in the same transaction.
_Self-application_ (note sourced by A and applied to A — reachable, since `CREDIT_NOT_APPLICABLE` blocks
only PAID/VOID/WRITTEN_OFF, and `autoApplyOldestCreditsInTx` will do it on the next `send()`): release
zeroes `amountUsed`, then the cap VOIDs the note. **That is the intended outcome per R5** — the invoice
the credit reduced is dead, so the credit has nothing left to justify it and the customer owes nothing.
The order-cancel caller widens this (`releaseOrderCreditsInTx` for the whole order at
`orders.service.ts:2752` before the per-invoice loop), which is likewise coherent since every invoice on
that order is being voided. The case where this outcome is _wrong_ is A3 (return-backed credit).

**4. Precision of `Number(cn.amountUsed ?? 0)` / `used <= 0.001` — REFUTED.**
`CreditNote.amountUsed` is `Decimal @db.Decimal(10, 2)` (`finance.prisma:476`), so the smallest non-zero
value is 0.01 — an `amountUsed` of 0.005 cannot exist without a schema change, and `0.01 > 0.001` resolves
correctly to the cap branch. `Number(<Prisma Decimal>)` via `valueOf()` is the pattern used everywhere
else in the file — `:648`, `:515`, `:594`, `:998` all do `Number(cn.amountUsed)` — so P3 is consistent
with the rest of the codebase, and `roundMoney` on an already-2dp value is a no-op. The `?? 0` only
affects fixtures (a real row is non-null with `@default(0)`). Note the tolerance is on **usage**
(`used <= 0.001`) where the rest of the file tests **headroom** (`amount − amountUsed > 0.001`, `:515`;
`newAmountUsed >= amount − 0.001`, `:451`) — different quantities, both at cent scale, no divergence.

**5. `APPLIED` on a partial cap vs api readers — CONFIRMED consistent; the gap is the missing test (A7).**
`applyCreditInTx:450-461` derives `fullyApplied = newAmountUsed >= amount − 0.001` → `status: "APPLIED"`,
so capping `amount` to `used` puts the note in exactly that state; writing APPLIED is the consistent
choice. Api readers of `status`: `applyToInvoice:544` refuses APPLIED (correct — zero headroom);
`voidCreditNote:594,603` refuses APPLIED (correct — consumed); `autoApplyOldestCreditsInTx:508` filters
`not VOID` then requires `amount − amountUsed > 0.001` (correctly skips it); `settleOrderCreditsInTx:987`
skips only VOID and then computes `unmet = amount − amountUsed = 0` (no-op); wallet balances at
`customers.service.ts:331,350` and `:954,977` and `buyer/statement.service.ts:140,143` are all
`amount − amountUsed` with a `> 0.001` filter (correctly 0);
`bookkeeping.getReceivableSummary:2144-2153` reports every status with `balance = amount − amountUsed`
(correctly 0). The one reader whose _membership_ changes is `bookkeeping.getRefundHistory:2028`
(`where: { status: APPLIED }`) — a capped note now appears there at its capped `amount`, i.e. exactly the
dollars actually refunded; that reads as an improvement, not a regression.
**Un-applying later:** the note does **not** get stuck APPLIED — `restoreCreditFromPaymentInTx:649,662`
recomputes `fullyApplied` and writes `"ISSUED"` when headroom reappears. One cosmetic gap: the cap does
not set `appliedToInvoiceId`, so a note spread across several invoices can read APPLIED with
`appliedToInvoiceId: null` (an "applied to …" label would render empty — lens B).

**6. `create()` guard and DRAFT — CONFIRMED for the select; see A2 for the real hazard.**
Every production path reaches the guard through `tx.invoice.findFirst` with an **explicit select that now
includes `status: true`** (`credit-notes.service.ts:113-129`), so `invoice.status` is always defined in
production; the exclude-list only tolerates `undefined` for legacy jest fixtures
(`credit-notes.service.spec.ts:46,78,90,108,125,144,171,192,219` all omit `status`, and
`CREDIT_SOURCE_EXCLUDED.includes(undefined)` is `false` → they stay green). DRAFT is out of the exclude
list (`invoice-status-sets.ts:20-23`) and pinned by T7b, so `returns.processRefund` against a DRAFT
pending-mirror invoice still works. **But** `processRefund` does not filter the source invoice by status
at all, so the VOID/WRITTEN_OFF case is a live regression — A2.

**7. Tenancy — CONFIRMED SAFE (no blocker).**
`create()` runs inside `this.prisma.tenantTransaction(…, { isolationLevel: "Serializable" })`
(`credit-notes.service.ts:102,269`), so the new `status` select rides the tenant-injecting proxy.
`voidInvoiceInTx`'s `tx` comes from `this.prisma.tenantTransaction` in both callers —
`invoices.service.ts:3903` and `orders.service.ts:2735` — and `tenantTransaction`
(`prisma.service.ts:48-63`) both sets the RLS session var (`app.current_tenant_id`) **and** wraps the tx
with `_wrapTxWithTenant`, so `tx.creditNote.findMany/update` are tenant-scoped. `findAll` uses
`this.prisma.forTenant()` (`:308`). The only unscoped branch is `tenantId === null`
(`prisma.service.ts:60 return fn(rawTx)` — SUPER_ADMIN / lost AsyncLocalStorage); no caller reaches
`voidInvoiceInTx` that way today, and the `where` is keyed on a UUID `invoiceId`, so cross-tenant capture
is not reachable.

**8. Concurrency — CONFIRMED-ISSUE (minor, A5).**
The `updateMany` claim at `:3844-3850` protects only the invoice row. `voidInvoice` opens its tx with
**no** `isolationLevel` (`:3903`) — i.e. READ COMMITTED — so a concurrent `applyToInvoice` /
`settleOrderCreditsInTx` on a _different_ invoice can raise the note's `amountUsed` between the cap's
`findMany` (`:3860`) and its `update` (`:3870`). There is no row lock on `CreditNote`
(`common/db-locks.ts`'s advisory lock is customer-keyed for order merges only), and the update is a
**blind full-column write**, so READ COMMITTED's re-read at write time does not help. The failure is
`amount < amountUsed` — not a clawback of a _payment_ (no `InvoicePayment` is touched, so R6 holds
literally), but a broken invariant that shows as a negative balance in `bookkeeping.service.ts:2152` and
permanently unspendable credit. Fix is one argument: `{ isolationLevel: "Serializable" }`, matching
`orders.service.ts:2770`.

**9. Test quality — substantive, with two gaps (A7, A11).**
_Gate._ **T1** (`:130-179`) — stronger than the plan row: asserts no `invoicePayment.create`, **no**
`creditNote.update` (the wallet side), and `result.applied === 0`; red pre-fix because the pre-fix apply
loop had no per-invoice status check. **T2** (`:181-229`) — non-vacuous but weaker than T1 (no
`creditNote.update` oracle); still red pre-fix via the direct array injection. **T5** (`:231-272`) —
matches the plan; drives the real second door (`autoApplyOldestCreditsInTx`), mocks `invoice.findUnique`

- `creditNote.findMany` correctly, asserts payment + `creditNote.update` + `applied === 0`. **T6/T7**
  (`:314-378`) — the rewritten single-outcome oracle is a genuine improvement: under the revert probe each
  produces a _different_ wrong value (`createdFor: "inv-void-1"` vs `"inv-written-off-1"`), so the red bar
  is behavioral and per-test, and `toEqual` (not `objectContaining`) means an extra field would fail.
  **T9** (`:421-464`) — three real oracles: the `findMany` `where` contains `invoiceId`, the update sets
  `status: "VOID"`, and a genuine call-order check (`capIdx < finalIdx`). **T10** (`:466-497`) — asserts
  `amount: 40` present, `status: "VOID"` absent, `invoicePayment.delete` never, and — answering the question
  directly — **yes, it notices `amountUsed`**: `:494-496` asserts no `creditNote.update` call carries
  `amountUsed: expect.anything()`. Its one hole is not asserting `status: "APPLIED"` (A7); the
  `objectContaining` on `data` is otherwise adequately fenced by that negative pair. **T11** (`:499-533`) —
  the positive half makes it red pre-fix, so it is not vacuous; the negative half is somewhat blunted by A10
  but T9 pins the query independently. **T12** (`:576-586`) — exact
  `invoice: { select: { id, invoiceNumber } }` shape, red pre-fix.
  _Pins — all five substantive, not smoke._ **T3/T3b** assert `result.unapplied === 40`,
  `invoicePayment.update` called with the reduced amount, `invoicePayment.delete` never, and
  `cnUpdate.data.amountUsed === 20` — a real proof that PAID **and** WRITTEN_OFF still shrink (the exact
  regression R3 warns about). **T4** asserts `applied === 40` plus the payment create (positive control
  against over-exclusion). **T8** ×2 assert both the normal create shape and that the over-credit cap still
  throws with no `creditNote.create`. **T7b** asserts DRAFT still creates. No vacuous assertion found; no
  gate assertion passes on the pre-fix body given the direct-injection harness design (not executed here —
  see "What I could not verify").

**10. Sibling sweep — see the table below.** Headline: pattern B (`"DRAFT" | "ISSUED"`) is **fully
eliminated** (grep exits 1 across `apps` and `packages` — L-072 discharged). Pattern A has 21 hits, all
either the deliberate settle retention, unrelated models, or listing reads. Pattern C has 8 hits; only one
(`customers.service.ts:1193`) is a wallet write, and it _is_ gated — but with a hand-typed literal (A6).

**11. Controller `/issue` removal — CONFIRMED-ISSUE (A1).**
`git grep -n "\.issue(\|useIssueCreditNote\|issueCreditNote" HEAD -- apps packages` → **no hits** (the
symbol-level removal is complete across api + web + mobile). But
`git grep -rn "/issue" HEAD -- apps packages scripts` finds two surviving **HTTP** callers:
`apps/api/scripts/e2e-verify.ts:1286` and `apps/api/scripts/qa-run.js:1295`. Neither is referenced by
`package.json`, `apps/api/package.json` or `.github` (manual harnesses), so this is not a CI-red — but per
the review brief a hit is a blocker either way, and `qa-run.js:1302` hard-fails on the 404.

---

## Sibling sweep

| #   | Pattern                   | Hit (`HEAD:`)                                                                                                                                                                                                            | Same defect class?                                                                                                                  | Disposition                                                                                                                    |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A1  | `status: { not: "VOID" }` | `credit-notes.service.ts:142` (`create` over-credit aggregate)                                                                                                                                                           | No — sums prior **credit notes**; excluding VOID notes is required so a P3-VOIDed note frees headroom                               | in scope, correct as is                                                                                                        |
| A2  | "                         | `credit-notes.service.ts:196` (per-line prior-credit cap)                                                                                                                                                                | No — same CreditNote set, same reason                                                                                               | correct as is                                                                                                                  |
| A3  | "                         | `credit-notes.service.ts:508` (`autoApply` candidates)                                                                                                                                                                   | No — CreditNote status, not Invoice status; the JS headroom filter completes it                                                     | correct as is                                                                                                                  |
| A4  | "                         | `credit-notes.service.ts:748, 804, 846, 1031` (payment listings for release / preview / unapply)                                                                                                                         | No — `InvoicePayment` status; listing reads, exactly what `payment-predicates.ts:16-22` says to keep broad                          | correct as is                                                                                                                  |
| A5  | "                         | `credit-notes.service.ts:943` (**settle invoice set**)                                                                                                                                                                   | **B67's original site** — deliberately left broad so SHRINK still sees WRITTEN_OFF; the write is now gated at `applyCreditInTx:405` | in scope, intentional (T3/T3b pin it)                                                                                          |
| A6  | "                         | `orders.service.ts:433, 2749, 2872, 5288`                                                                                                                                                                                | No — invoices/payments for listing and teardown, not a credit apply                                                                 | out of scope                                                                                                                   |
| A7  | "                         | `import/duplicate-match.service.ts:194,350` · `invoice-pdf.service.ts:67` · `commission-statements.service.ts:160` · `statement-apply.service.ts:448` · `supplier-statements.service.ts:544` · `suppliers.service.ts:82` | No — supplier / commission / PDF listing reads, no wallet write                                                                     | out of scope                                                                                                                   |
| B1  | `"DRAFT" \| "ISSUED"`     | **none** (grep exit 1 over `apps` + `packages`)                                                                                                                                                                          | —                                                                                                                                   | discharged (L-072)                                                                                                             |
| C1  | `invoicePayment.create(`  | `credit-notes.service.ts:432`                                                                                                                                                                                            | **The B67 site** — now gated at `:405`                                                                                              | fixed in this PR                                                                                                               |
| C2  | "                         | `customers.service.ts:1193` (ADVANCE wallet → invoice)                                                                                                                                                                   | Gated at `:1177`, but with a hand-typed `["PAID","VOID","WRITTEN_OFF"]` literal instead of `CREDIT_NOT_APPLICABLE`                  | **A6** — re-point (cheap) or file                                                                                              |
| C3  | "                         | `invoices.service.ts:4638` (`recordDeliveryPaymentInTx`)                                                                                                                                                                 | Gated by the shared `PAYABLE` at `:4564, :4596`                                                                                     | correct as is (re-pointed by this PR)                                                                                          |
| C4  | "                         | `invoices.service.ts:4446` (`recordPayment`)                                                                                                                                                                             | Real cash; guards `remaining <= 0` only, no terminal-status gate                                                                    | not the wallet class — recording recovered cash on a WRITTEN_OFF invoice is plausibly intended; **file a question**, not a fix |
| C5  | "                         | `invoices.service.ts:5066` (`recordStandalonePayment`)                                                                                                                                                                   | Real cash; rejects VOID (`:5053`) but not WRITTEN_OFF                                                                               | same judgement as C4 — file                                                                                                    |
| C6  | "                         | `bookkeeping.service.ts:191`                                                                                                                                                                                             | Transaction-level cash payment; `CONFIRMED_PAYMENT`-scoped read + fully-paid guard                                                  | out of scope                                                                                                                   |
| C7  | "                         | `import/import.service.ts:792, 935`                                                                                                                                                                                      | Importer back-fill of historical payments, status-derived                                                                           | out of scope                                                                                                                   |
| D1  | (new) invoice-death doors | `invoices.service.ts:4980` (`deleteInvoice` unlinks notes) · `orders.service.ts:5537-5552` (order delete, FK `SetNull`)                                                                                                  | **Yes — the same B66 class the void cap closes**                                                                                    | **A4** — file (recommended) or bundle                                                                                          |

---

## What I could not verify

- I did **not** run jest, tsc, or any probe (task constraint), so every red/green claim about the pre-fix
  body rests on the plan's table, `stage-a-report.md` §5-§7, and my reading of the pre-fix code paths —
  not on an executed run.
- A5's race is reasoned from Prisma/Postgres semantics and the absence of a lock; I did not construct an
  executable interleaving to demonstrate it.
- Web / mobile status-pill readers of `APPLIED` and `appliedToInvoiceId` are lens B's; I name only the api
  readers.
