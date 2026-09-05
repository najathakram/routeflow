# F09 · Discovery — credit notes and wallet integrity

**Status: IN PROGRESS** · Campaign batch F09, one PR. Bugs: B13, B18, B19 (T2), B66, B67 (T1).
Card: `.claude/pipeline/fix-cards/F09-credit-notes-wallet-integrity.md`. Base: master@3d1d8ea9.

## The problem

Credit notes are wallet money. Three defects let that money detach from the receivable it
belongs to, and two more leave the operator unable to read or act on it.

- **B66 (money):** a credit note's validity is tied to its source invoice, but nothing enforces
  that. `create()` never reads the invoice's status, so a credit can be minted against an
  already-VOID invoice's frozen total; and voiding an invoice never touches credits sourced
  from it, so they stay ISSUED and fully spendable elsewhere. The tenant reverses the sale and
  the customer keeps the money.
- **B67 (money):** `settleOrderCreditsInTx` applies wallet credit to WRITTEN_OFF invoices —
  terminal forgiven debt that the manual path refuses outright. `recomputeStatus` preserves
  WRITTEN_OFF, so the invoice's visible status never moves and the consumption is silent.
- **B18:** a DRAFT/Issue flow that can never run, on web AND mobile.
- **B19:** raw UUIDs where invoice numbers belong.
- **B13:** web cannot apply a customer advance at all; mobile can.

**Whose problem:** operators and the tenant's books. B66/B67 are silent money loss; B13 is a
capability web simply lacks; B18/B19 are daily friction and a promise the UI cannot keep.

**If we ship nothing:** credit keeps surviving its own invoice's void, keeps being consumed
against forgiven debt, and F08 (Wave A's last two Criticals) stays blocked — F09 is its
positional predecessor in the `credit-notes.service.ts` lane.

## Discovery verdict — all five CONFIRMED on master@3d1d8ea9

| ID | Verdict | Re-verified evidence |
| --- | --- | --- |
| B66 | CONFIRMED | `credit-notes.service.ts` `create()` — the `tx.invoice.findFirst` selects `total`, `customerId`, `items` only: **no `status` field, no status check**; caps against `invoice.total`, which void never changes. Contrast at `applyToInvoice` :537-546, which blocks PAID/VOID/WRITTEN_OFF explicitly. `voidInvoiceInTx` still never touches `CreditNote` rows pointing at the invoice. |
| B67 | CONFIRMED | `settleOrderCreditsInTx` (:914+) filters invoices `status: { not: "VOID" }` only (~:930) — WRITTEN_OFF passes into the apply loop. `applyCreditInTx` has no status gate. |
| B18 | CONFIRMED, **scope wider than "web"** | `schema.prisma:243-247` — `CreditNoteStatus = ISSUED \| APPLIED \| VOID`, no DRAFT. `create()` writes `"ISSUED"` (:239). `issue()` is literally `return this.findOne(id)`. Dead UI on BOTH surfaces: web `[id]/page.tsx` (`status === "DRAFT"` at ~:410 and ~:653, `IssueConfirmModal`, `useIssueCreditNote` at :243) and mobile (`[id].tsx:47` wired hook, `index.tsx:22` "Draft" filter chip, `new.tsx:30` DRAFT case). |
| B19 | CONFIRMED | `findAll` has **no invoice include at all**; `findOne` has `invoice: { select: { id, invoiceNumber } }`. Web renders the raw UUID in three places: list `page.tsx:855-856`, detail `[id]/page.tsx` ~:508-516 and ~:638-646 — the detail page ignoring data it already holds. |
| B13 | CONFIRMED (card's own correction holds) | `useApplyAdvanceToInvoice` at `apps/web/lib/api/invoices.ts:475` (not customers.ts, as the card notes) and `useApplyAdvancePayment` at `apps/web/lib/api/customers.ts:288`. **Neither has any caller under `apps/web/app`.** Both POST the *identical* endpoint `/customers/:id/advance-payments/:advanceId/apply` with identical params — genuine duplication. Mobile's `ApplyAdvanceSheet` is live at `(operator)/(tabs)/invoices/[id].tsx:1068`. |

None already-fixed; no register flips at discovery.

## ⚠️ Cross-batch finding: F07 (#588, mine) WIDENED B67

`settleOrderCreditsInTx` now has **six** call sites. Two are new in F07: `send()` (:3413) and
`sendEmail()` (:3619), added to make B108's documented catch-up real. `send()` refuses only VOID
(`if (inv.status === VOID) throw`), so a **WRITTEN_OFF invoice can be sent**, and that new line
then applies wallet credit to forgiven debt.

The B108 fix was correct for its own bug and stays. But it opened two new routes into a defect
that was sitting queued in this batch, which has two consequences:

1. **B67's blast radius is larger than the card assumed** — and the damage window is not
   uniform in time (see the D4 note below).
2. **It settles the design question the card only asserted.** A per-call-site status guard would
   already need six patches and would silently miss the seventh. Fixing the primitive is the
   only shape that holds. Three independently-drifting status filters is *how B67 exists*, so
   the fix reuses an existing list rather than hand-rolling a fourth.

## D4 note — the control must be per-window, not per-predicate

B67's damage surface changed when #588 shipped:

- **Pre-#588:** order-edit / order-create / delivery settles.
- **Post-#588:** additionally every `send`/`sendEmail` on an order-linked WRITTEN_OFF invoice.

So the positive control must prove the damage predicate can return non-zero **in each window
separately**. A zero from the wider window says nothing about the narrower one, and a control
that only demonstrates "the query runs" would let a genuine zero in one window mask an untested
other.

## Decisions taken (both were "or" in the card)

- **B18 → DELETE the dead flow, do not build it.** A real draft workflow needs an enum
  migration, a status machine, and changes to `returns.processRefund` — a genuine feature,
  deferred per **D5**. Deleting a confirmation step that can never run is the small,
  flow-completing fix. Safe to remove the endpoint too: `status` can never be DRAFT, so the
  Issue button cannot render on **any** client and no shipped build can reach the route.
- **B13 → BUILD the web action, delete the duplicate hook.** Web is the golden reference and
  mobile mirrors it; having this only on mobile is backwards. The hook already exists and is
  typed; this wires UI to it. The `customers.ts` twin hits the same endpoint with weaker cache
  invalidation and no callers — it goes.

## Non-goals

A real DRAFT lifecycle (deferred, D5) · retro-voiding credits already sourced from
already-voided invoices (that is D4 repair, not code) · any change to `applyToInvoice`'s
existing manual-path guards · F08's territory in the same file.
