# Rollback runbook — `20260706120000_regulated_items_foundation`

This migration is **fully additive and reversible**. Prisma has no auto-down, so a
rollback is a hand-run reverse script. **A rollback is non-breaking for the live
app**: W1 changes no read paths, and `Product.isTobacco` is retained as the
authoritative shadow column, so the tobacco/products/analytics features keep
working off `isTobacco` whether or not the new columns exist.

> Only roll back if a later problem is traced to this migration. Prefer rolling
> _forward_ with a corrective additive migration. Never run this on prod without
> the same approval + safety process as applying a migration.

## What a rollback discards

- All `TrackedCategory` rows (incl. the backfilled Tobacco seed) and every
  `Product.trackedCategoryId` link. Re-applying the migration safely re-runs the
  idempotent backfill and recreates them.
- Any `CustomerAuthorization` / `AuthorizationOverride` / `RegulatedSalesLedger`
  rows written after apply (none exist until W5/W6 wire writers).

## Reverse SQL (drop in dependency order: FKs → tables → columns → enums)

```sql
BEGIN;

-- 1) Drop the 4 new tables (drops their FKs + indexes with them).
DROP TABLE IF EXISTS "RegulatedSalesLedger";
DROP TABLE IF EXISTS "AuthorizationOverride";
DROP TABLE IF EXISTS "CustomerAuthorization";
DROP TABLE IF EXISTS "TrackedCategory";

-- 2) Drop the added columns (FKs on Product/OrderItem/InvoiceItem drop with them).
ALTER TABLE "Product"       DROP COLUMN IF EXISTS "trackedCategoryId";
ALTER TABLE "OrderItem"     DROP COLUMN IF EXISTS "trackedCategoryId", DROP COLUMN IF EXISTS "categoryTaxAmount";
ALTER TABLE "InvoiceItem"   DROP COLUMN IF EXISTS "trackedCategoryId", DROP COLUMN IF EXISTS "categoryTaxAmount";
ALTER TABLE "Invoice"       DROP COLUMN IF EXISTS "invoiceGroupId";
ALTER TABLE "Order"         DROP COLUMN IF EXISTS "hasRegulated";
ALTER TABLE "RouteRunStop"  DROP COLUMN IF EXISTS "ageCheckRequired", DROP COLUMN IF EXISTS "identityCheckRequired";

-- 3) Drop the 6 enums (only after every column/table using them is gone).
DROP TYPE IF EXISTS "LedgerEntryType";
DROP TYPE IF EXISTS "AuthorizationSource";
DROP TYPE IF EXISTS "AuthorizationStatus";
DROP TYPE IF EXISTS "ReportCadence";
DROP TYPE IF EXISTS "InvoiceTreatment";
DROP TYPE IF EXISTS "TrackedCategoryTaxType";

COMMIT;
```

After running, delete this migration's row from `_prisma_migrations` (or use
`prisma migrate resolve --rolled-back 20260706120000_regulated_items_foundation`)
and revert the schema.prisma changes so the schema and DB agree.
