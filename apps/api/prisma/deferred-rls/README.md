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

## Triage of the NULL rows — 2026-09-01 (read-only, against production)

Counts re-run and each class characterised. **The counts above have drifted** (they
grow with normal use): VendorBillItem is now **2038**, RefreshToken **1729**. Still 15
tables. `local-assets/rls-null-triage.mjs` (gitignored) re-runs this characterisation.

| Class                                     | Tables                                                                           | Rows | Disposition                                                                                                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A — mechanical backfill from parent**   | VendorBillItem 2038, StockLot 4, PurchaseOrderItem 3, RouteRun 2, RouteRunStop 5 | 2052 | Parent verified to HOLD a tenantId, so `UPDATE … FROM parent` is deterministic. The known nested-create defect (a child written through its parent never gets the column set). |
| **B — parent is ALSO null**               | ReturnItem 1, RecurringInvoiceItem 1                                             | 2    | Must resolve their headers (class C) first, then backfill from them.                                                                                                           |
| **C — singleton orphans, need eyes**      | CreditNote, Return, Expense, RecurringInvoice, PaymentCounter                    | 5    | One row each. Individually inspect and assign, or delete if they are dev residue. Too few to justify a rule.                                                                   |
| **D — DESIGN DECISION, not backfillable** | User 6, RefreshToken 1729, ExpenseCategory 60                                    | 1795 | See below.                                                                                                                                                                     |

### ⚠️ Class D would take production down if armed as written

- **`User` (6)** — the breakdown is **3 SUPER_ADMIN + 3 TENANT_ADMIN**. The super-admins
  are NULL _by design_: a platform admin belongs to no tenant. Arming FORCE RLS on this
  table makes those three rows invisible to the app's own connection, which kills
  platform-admin login outright. The **3 TENANT_ADMIN rows are a separate finding** — a
  tenant admin with no tenant is a data defect, not a design choice, and wants
  investigating on its own merits.
- **`RefreshToken` (1729)** — ⚠️ **this README previously assumed these were super-admin
  tokens. They are not.** The breakdown is OPERATOR 1104, SUPER_ADMIN 249, CUSTOMER 228,
  TENANT_ADMIN 129, DRIVER 19 — every role, roughly in proportion to use. The column has
  simply never been populated on this table. Backfilling from `User.tenantId` cannot work
  either, because the super-admin owners are themselves NULL. Arming here logs **everyone**
  out and then prevents the app writing a replacement token for any super-admin.
- **`ExpenseCategory` (60)** — 20 IRS Schedule C names × 3 copies. The seeded default list.
  Deciding between "global, exclude from the policy" and "per-tenant, so dedup and assign"
  needs a product answer, not a backfill.

**Recommendation:** remove `User`, `RefreshToken` and `ExpenseCategory` from this file's
policy list (they are user- or platform-scoped, not tenant-scoped), backfill classes A→B,
resolve C by hand, and treat the 3 tenant-admins-without-a-tenant as its own bug. Arming is
blocked on the owner's answer to the class-D question, per rule D3.

## To arm (the runbook)

1. Resolve the NULL rows per the triage table above: classes A and B backfill from their
   parents; class C is resolved by hand; class D is a **policy-design decision** (remove
   those tables from this file's policy list), never a backfill.
2. Re-run `railway run --service postgres node scripts/rls-preflight.mjs` → must
   report zero blockers.
3. Fresh backup (house in-container method).
4. `git mv` this folder back under `prisma/migrations/` in a PR, merge, then
   `railway run --service postgres node apps/api/scripts/prod-migrate.mjs`.
5. The migration's own trailing DO block RAISES unless every policied table reports
   `relrowsecurity` — trust that assertion, not the exit code.

CI note: the migration-replay job no longer exercises this file while parked; it was
green on #551's replay (fresh DB, zero rows) before parking.
