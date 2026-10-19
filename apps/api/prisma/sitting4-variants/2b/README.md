# Sitting 4, folder 2b (B296 widen, expand / contract)

Not a migration. This folder sits outside `migrations.path` (`prisma/migrations`), so Prisma, the
drift gate and `npm run lint:migrations` (which diffs only `apps/api/prisma/migrations`) never read it.

Use it only if `report-sitting4-sizing.mjs` reports 500 000 rows or more (SA-772 §2, SA-814 §3):

1. Replace `prisma/migrations/20261020090200_invoice_tax_rate_widen/` with
   `20261020090200_invoice_line_tax_rate_expand/` from here.
2. Apply `finance-prisma-2b.patch` to `prisma/schema/finance.prisma` (`git apply`).
3. Fill the measured row count into the `-- reason:` lines, then re-run `npm run lint:migrations`
   and the drift replay before the sitting.
4. Re-run the folder-6 generator so the not-NaN checks cover the two new `lineTaxRate` columns:
   `node apps/api/scripts/generate-not-nan-checks.mjs > apps/api/prisma/migrations/20261020090400_numeric_not_nan_checks/migration.sql`
   (`numeric-not-nan-check.spec.ts` stays red until it is). Ordering holds: the 2b folder is
   `20261020090200_…`, so it sorts before folder 6 (`20261020090400_…`), which adds their CHECKs.
5. Delete this folder in the same commit.
