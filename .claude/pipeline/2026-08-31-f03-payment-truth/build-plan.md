# F03 — build plan

**Status: APPROVED for execution** · worktree `.claude/worktrees/rf-F03`, branch
`fix/F03-payment-truth` off `master e7eb1627` · dev-pipeline Workflow, scale **major** · money
batch ⇒ Fable adversarial pass at close-out. **Lane fence: this batch OWNS invoices.service.ts;
it must NOT touch orders.service.ts (F06/F07) or credit-notes.service.ts (F09).**

## P1 — the predicate + invoices.service call sites

- **satisfies:** R1 R4 R5 R6 R7 · **provenBy:** T-B11s T-B74 T-B81 T-B84 T-B85 T-B50s
- **Files (owns exclusively):** `apps/api/src/invoices/invoices.service.ts`,
  `apps/api/src/invoices/payment-predicates.ts` (NEW: exports `CONFIRMED_PAYMENT` + a
  `sumConfirmed(payments)` helper), spec file additions.
- Tricky parts pinned: B84's claim = the returns.service :244-250 shape verbatim; B85 wraps
  createPartialFromOrder in `tenantTransaction` mirroring createSplitInvoices's `runCreation(tx)`;
  B74's overpayment routing copies whichever convention the ~15 sibling recompute sites use
  (read three of them first; do not invent).
- **F04 oracle-cap check (MANDATORY in this package):** F04's Fable final pass found the ported
  mirror telescope could bill a PARTIAL delivery above the agreed line subtotal in the
  freeUnitSize>1 region — fixed in the mirrors with a `basisQty` cap
  (`Math.min(billedThrough(delivered), basisQty)`). The REFERENCE ORACLE, `buildInvoiceItemData`
  (invoices.service.ts:827-897, THIS lane), may share the hole. Check billedThrough-vs-basis
  capping there; if the server can over-bill mixed BOGO partials, fix it HERE with a
  REG-B50s-tokened spec case (`REG-B50s`, not the bare `REG-B50` — that token belongs to F04's
  shipped pricing-parity tests; the mirrors now cap, so an uncapped server over-invoices what the
  driver correctly under-collects). If it already caps, add the pinning assert anyway and note it. **The proving test is T-B50s** — added to the test plan 2026-08-31 on resume, after review found the cap had been IMPLEMENTED with no regression behind it (a planning gap: the check was briefed into P1 without a matching T# for the author phase to work from).
- **Scanner block deletion (with the fix, same package):** delete the `draft-payment-not-void`
  block from `.claude/skills/bug-hunt/scan-known-bugs.json` — its 10 acknowledged sites are
  exactly what this package fixes; the scanner must go back to treating that signature as a
  fresh hit.

## P2 — bookkeeping dashboards

- **satisfies:** R1 · **provenBy:** T-B11s · **dependsOn:** P1 (imports the predicate)
- **Files (owns exclusively):** `apps/api/src/bookkeeping/bookkeeping.service.ts` (+ its spec)
- getMobileDashboard / getFinanceDashboard / getDashboard only. getCashFlow /
  getPaymentsReceivedReport byte-untouched (assert via git diff in review).
- **Boundary WIDENED at review (2026-08-31).** The three-function fence left `getSummary`
  (GET /bookkeeping/summary), `getArAgingInvoices` and the sibling balance reports
  (`getCustomerBalanceSummary`, `getInvoiceDetailsReport`, `getBadDebtsReport`,
  `getArAgingDetails`, `getReceivableSummary`) plus `recordPayment`'s state-advancing sum and
  the `findAll`/`findOne`/`recordPayment` ledger `totalPaid` on `not: VOID` — so the SAME tenant
  read $200 outstanding on /bookkeeping/summary and $500 on /bookkeeping/dashboard. The fence was
  the defect, not the design: the reports lane's own reference reads (`getCashFlow`,
  `getPaymentsReceivedReport`) already filter `status: PAID`. Resolution per R1 ("every
  payment-SUMMING read uses it"): **every payment SUM in bookkeeping.service.ts is CONFIRMED;
  every payment LISTING keeps all rows and carries `status` through to the renderer** (the
  `getReceivableSummary` payment-row query is such a listing and stays unfiltered). The two
  reference functions remain byte-untouched. Covered by the added T-B11s cases for getSummary /
  getArAgingInvoices / recordPayment in `bookkeeping.service.spec.ts`.

## P3 — documents: PDF + email

- **satisfies:** R1 R8 R9 · **provenBy:** T-B97 T-B102 T-B103 · **dependsOn:** P1
- **Files (owns exclusively):** `apps/api/src/invoices/invoice-pdf.service.ts`,
  `apps/api/src/invoices/invoice-pdf-template.tsx`, `apps/api/src/email/email.service.ts`
  (+ their specs)
- PDF query → CONFIRMED; template totalPaid from confirmed rows, DRAFT rows listed with a
  "Pending confirmation" label (keep-visible option per the register's B97 fix note); email
  gains totalPaid/balanceDue params + the two footer lines; both item payloads gain
  originalPrice/priceType/promoFreeUnits with the web detail renderer as the visual reference.

## P4 — web badge + count (T2 surface)

- **satisfies:** R2 · **provenBy:** REG-B11 (e2e authored here, proven post-deploy)
- **Files (owns exclusively):** `apps/web/app/(dashboard)/invoices/[id]/page.tsx` (payment-row
  badge), the dashboard tile component the count lands on (locate via code map; smallest
  sensible surface), `apps/web/e2e/22-payment-truth.spec.ts` (NEW).

## P5 — the repair script

- **satisfies:** R10 · **provenBy:** T-R10 · **dependsOn:** P1 (reuses the predicate + status
  recompute for its proposals)
- **Files (owns exclusively):** `scripts/repair-f03.mjs`, `scripts/repair-f03.spec-driver.mjs`
  (if the child-process test pattern needs it), spec in apps/api.
- Safety shape from `scripts/repair-integrity.mjs` verbatim: dry-run default; `--execute` +
  `--i-have-a-fresh-backup`; per-row tx with in-tx re-read compare; JSONL log to
  `local-assets/`; `--force-nonprod` guard; `assertTestTenant` NOT applicable (it repairs live
  rows by design, per the owner's repair-as-we-go decision — the script says so in its header
  and cites the decision).

## Pipeline args

scale major · workdir rf-F03 · TPs mirror the test-plan rows (TP1 invoices, TP2 bookkeeping,
TP3 documents, TP4 repair script; e2e spec authored in P4 not red-gated) · redGate
`-t "REG-B(11|57|74|81|84|85|102|103)|REG-B50s"` apps/api, expect fail (`REG-B50s` = T-B50s, the
server oracle cap — the bare `REG-B50` alternative is NOT usable: it also selects three shipped
F04 tests in `apps/api/src/common/pricing-parity.spec.ts`, which made the gate structurally
incapable of reporting 0 passed; see test-plan.md) · verify perRound api tsc; final:
api jest JSON artifact, web tsc, scanner, campaign-check --batch F03 --pipeline-dir <this>.
Mutation targets: the predicate (revert one site to not-VOID), B84's claim (updateMany→update),
B81's guard (stored→dto), repair dry-run (make it write). No uiVerify (badge is T2-post-deploy).

## Close-out checklist

1. Fable adversarial pass over the money diff.
2. Ledger F03.jsonl → proven / proven-pending-deploy (B11); buildPlan fields set.
3. campaign-check --batch F03 green · code map + CHANGELOG + _meta + HANDOFF (`W3 …`).
4. Register chips ×9 + republish `310ae33a…`; guide: invoice/PDF/email articles change
   user-visibly → flag to owner at wave end.
5. Merge when ready (owner: any hour). Post-deploy: post-deploy-check + feature-smoke; then the
   REPAIR FLIGHT: fresh backup → `railway run … repair-f03.mjs` dry-run → apply →
   `data-integrity-report` re-check; file the repair log path on board #516.
