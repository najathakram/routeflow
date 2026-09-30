# F09 · S3 Fix ruling (Fable, 2026-09-05) — credit notes and wallet integrity

Inputs: `cause-brief.md` (S1), `refutation.md` (S2), the Sep-1 `spec.md`/`test-plan.md`/`build-plan.md` (claims). Base: master `d12203a3`, worktree `rf-F09`, branch `fix/F09-credit-notes-wallet`.

## 1. Cause verdicts (accepted from S2)

| Bug | Verdict                      | Diverging line(s) on `d12203a3`                                                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B67 | **confirmed, two doors**     | `credit-notes.service.ts:930` (`status: { not: "VOID" }` admits WRITTEN_OFF) **and** `:413-422` (`applyCreditInTx` writes the `InvoicePayment` with no status gate; the loop `:983-999` never re-checks). `autoApplyOldestCreditsInTx` (`:473-476`, reached from `send()`/`sendEmail()` `invoices.service.ts:3394/3600`) is a SECOND unguarded door. |
| B66 | **confirmed, both branches** | `create()` select `:110` never reads `status`; `voidInvoiceInTx` has no `tx.creditNote.*` between `:3846` and `:3850`.                                                                                                                                                                                                                               |
| B18 | **confirmed**                | `issue()` `:358-360` is `return this.findOne(id)`; the enum has no DRAFT (`finance.prisma:56-60`); web/mobile hand-type a phantom `"DRAFT"` (`apps/web/lib/api/credit-notes.ts:6`, `apps/mobile/lib/api/credit-notes.ts:8`) while `packages/types/api/enums.ts:60-61` already pins the 3-value union.                                                |
| B19 | **confirmed**                | `findAll` include `:295` lacks `invoice`; web `CreditNote` type has no `invoice` field.                                                                                                                                                                                                                                                              |
| B13 | **refuted as a bug**         | `git log -S` shows each hook added once and never called; the registry card is an unanalysed stub whose symptom is an absence.                                                                                                                                                                                                                       |

## 2. Fix design (minimal diff; what must NOT change)

- **B67 — guard at the money write, not the query.** In `applyCreditInTx`, after the invoice read: `if (CREDIT_SETTLE_EXCLUDED.includes(inv.status)) return { applied: 0 }` (exclude-list on `inv.status`; never an allow-list — fixtures without `status` must still apply). This closes settle AND `autoApplyOldestCreditsInTx` with one change. **Leave the `where` at `:930` unchanged** — narrowing it would drop WRITTEN_OFF from the SHRINK pass (`:935-967`) and strand excess credit already parked on a written-off invoice (S2 O3). `applyToInvoice` (`:537-546`) keeps its own upstream refusal.
- **B66 — `create()`** adds `status: true` to the select and refuses `CREDIT_SOURCE_EXCLUDED = [VOID, WRITTEN_OFF]` with `BadRequestException(\`Cannot issue a credit note against a ${status} invoice.\`)`. **DRAFT stays allowed** (pending-mirror invoices live DRAFT; `returns.processRefund` `returns.service.ts:370` would otherwise strand a refund; the UI offers DRAFT on purpose). R4 of the Sep-1 spec is amended accordingly.
- **B66 — `voidInvoiceInTx`** gains the capping loop AFTER the atomic claim (`:3846`) and BEFORE the final `findUnique` (`:3850`): notes with `invoiceId = id` and `status != VOID`; `amountUsed <= 0.001` ⇒ `status: "VOID"`; else `amount: roundMoney(amountUsed)`. Never delete an `InvoicePayment`, never decrement `amountUsed`. Both callers already run `releaseWalletPaymentsInTx` first — keep that order.
- **Shared sets** — new `apps/api/src/invoices/invoice-status-sets.ts` (export style of the sibling `payment-predicates.ts`): `CREDIT_NOT_APPLICABLE = [PAID, VOID, WRITTEN_OFF]` (manual apply), `CREDIT_SETTLE_EXCLUDED = [VOID, WRITTEN_OFF]` (automatic apply; the comment explains why PAID is NOT here — shrink), `CREDIT_SOURCE_EXCLUDED = [VOID, WRITTEN_OFF]` (minting), `PAYABLE = [DRAFT, SENT, PARTIAL, OVERDUE]` (delivery payments). Re-point the two existing literals (`applyToInvoice`, `PAYABLE` at `invoices.service.ts:4513`) — behaviour-neutral.
- **B18 — remove the dead flow via the type system:** delete `issue()` + `@Post(":id/issue")`; web and mobile import `CreditNoteStatus` from `@routeflow/types` (L-072) so every DRAFT branch becomes a compile error, then delete those branches (`[id]/page.tsx:410,653`, `IssueConfirmModal`, the hook, list chips/counts; mobile screens + `credit-notes-logic.ts` DRAFT pill / `canIssue`).
- **B19** — `findAll` include `invoice: { select: { id: true, invoiceNumber: true } }`; web `CreditNote` gains `invoice?: { id: string; invoiceNumber: string }`; three render sites show `invoice?.invoiceNumber ?? invoiceId`.
- **B13 — out of this batch.** R11 (an "Apply advance" action on the web invoice page) is a feature: no affordance ever existed. It goes to dev-pipeline as its own item. R12 (delete the zero-caller duplicate `useApplyAdvancePayment`, `customers.ts:282-297`) stays as dead-code hygiene. Ledger: B13 → `refuted` with that evidence; the owner decides whether to file the feature.
- **Invariant:** spent credit is never clawed back (R6); a PAID or DRAFT invoice's behaviour is unchanged; no call site is patched — only the primitives.

## 3. Regression tests — see `bug-test-plan.md` (revised)

Red set (REG tokens, gate file `credit-notes.wallet-integrity.spec.ts`): T1, T2, T5 (B67 apply-side, incl. the auto-apply door), T6, T7 (B66 create: VOID, WRITTEN_OFF), T9, T10 (B66 void cap), T12 (findAll include, no token). Pins (green today, pins file): T3 (PAID shrink still runs), T3b (WRITTEN_OFF shrink still runs), T4 (SENT still receives), T7b (DRAFT source still creates), T8 (cap unchanged), T11 (other-source note untouched). T15 removed with R11. Two safekept gate tests are rewritten: T5 (was a duplicate of T1 with a false premise) and T7 (was DRAFT).

## 4. Blast radius (`radiusFiles`)

`apps/api/src/credit-notes/credit-notes.service.ts`, `apps/api/src/invoices/invoices.service.ts`, `apps/api/src/invoices/invoice-status-sets.ts`, `apps/api/src/returns/returns.service.ts` (processRefund create call), `apps/api/src/orders/orders.service.ts` (settle callers + void caller), `apps/api/src/credit-notes/credit-notes.controller.ts`, `packages/types/api/enums.ts`, `apps/web/lib/api/credit-notes.ts`, `apps/web/app/(dashboard)/credit-notes/page.tsx`, `apps/web/app/(dashboard)/credit-notes/[id]/page.tsx`, `apps/mobile/lib/api/credit-notes.ts`, `apps/mobile/lib/credit-notes-logic.ts`.

## 5. Sibling patterns

- `status: \{ not: "VOID" \}` — a single-status exclusion where the shared set belongs (WRITTEN_OFF forgotten).
- `"DRAFT" \| "ISSUED"` — a hand-typed enum union that should import from `@routeflow/types` (L-072).
- `tx\.invoicePayment\.create\(` — a money write; check each has a status gate upstream.

## 6. Data repair

Plausibly corrupted rows exist: (a) wallet credit consumed by WRITTEN_OFF invoices (B67) and (b) credit notes whose source invoice was voided after issue (B66). **Not bundled.** Owner-owed follow-up: a read-only report script (`scripts/report-f09-wallet-leaks.mjs`, prod via `railway run --service postgres`), then a decision. Recorded in the close-out.

## 7. Probe plan (`revertFix: true`)

`credit-notes.service.ts` → T1/T5 red (apply-side guard); `invoices.service.ts` → T9/T10 red (void cap). Design probe by hand at close-out: add `PAID` to `CREDIT_SETTLE_EXCLUDED` → T4 stays green but `applyToInvoice`… (no automated oracle — R3's protection is now structural: the `where` is untouched and T3/T3b pin shrink).
