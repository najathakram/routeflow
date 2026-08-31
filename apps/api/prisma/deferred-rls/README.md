# Deferred: the RLS arming migration

`20260909000000_rls/` was BUILT by campaign batch F02b (#551) but is deliberately
parked OUTSIDE `prisma/migrations/` because the 2026-08-31 production pre-flight
(`scripts/rls-preflight.mjs`) found **15 tables with NULL-"tenantId" rows**
(VendorBillItem 2035, RefreshToken 1605, ExpenseCategory 60, User 6, RouteRunStop 5,
StockLot 4, PurchaseOrderItem 3, RouteRun 2, and 1 each on PaymentCounter/CreditNote/
RecurringInvoice/RecurringInvoiceItem/Return/ReturnItem/Expense). Arming FORCE ROW
LEVEL SECURITY makes such rows invisible and unwritable to every role — including the
app's own connection — so `prisma migrate deploy` MUST NOT pick this up as a side
effect of some later batch's migration flight. Owner rule D3
(`.claude/campaign/DECISIONS.md`): pre-flight-gated arming only.

## To arm (the runbook)

1. Resolve the NULL rows: backfillable classes derive tenantId via their parent
   (VendorBillItem←VendorBill, RouteRunStop←RouteRun, StockLot←Product, item rows ←
   their headers — the known nested-created-children class); genuinely-global rows
   (super-admin User/RefreshToken, default ExpenseCategory) instead get their tables
   REMOVED from this file's policy list — that is a policy-design decision, not a
   backfill.
2. Re-run `railway run --service postgres node scripts/rls-preflight.mjs` → must
   report zero blockers.
3. Fresh backup (house in-container method).
4. `git mv` this folder back under `prisma/migrations/` in a PR, merge, then
   `railway run --service postgres node apps/api/scripts/prod-migrate.mjs`.
5. The migration's own trailing DO block RAISES unless every policied table reports
   `relrowsecurity` — trust that assertion, not the exit code.

CI note: the migration-replay job no longer exercises this file while parked; it was
green on #551's replay (fresh DB, zero rows) before parking.
