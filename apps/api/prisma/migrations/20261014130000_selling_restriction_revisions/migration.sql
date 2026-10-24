-- Row 509 PR3 (owner Q4, SA re-rule 2026-10-14): a rule's settings (jurisdiction, states, surface, window, reason)
-- are editable IN PLACE, with an append-only history. "SellingRestriction"."revision" counts the edits (1 = as
-- created); "SellingRestrictionRevision" keeps every revision's settings and who made it. Additive: one column with
-- a constant default, one new table with its indexes and FKs, and an idempotent backfill of revision 1 for every
-- existing rule (editedAt = createdAt, editedBy = createdBy). The rule row keeps holding the CURRENT values, so the
-- engine, and a rollback of the code, read them exactly as before.
--
-- LOCK PROFILE: ADD COLUMN ... NOT NULL DEFAULT <constant> is a catalog-only change on PostgreSQL >= 11 (no table
-- rewrite); it takes ACCESS EXCLUSIVE on "SellingRestriction" for an instant. The new table's CREATE / indexes lock
-- nothing anyone waits on; its FKs take a SHARE ROW EXCLUSIVE lock on "Tenant" and "SellingRestriction" for the
-- instant of their validation (an empty table validates at once). The backfill only READS "SellingRestriction".
-- `SET LOCAL lock_timeout = '5s'` applies PER STATEMENT inside the one transaction: a statement that waits longer
-- than 5s for its lock fails and rolls the whole file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back <folder>` from apps/api, then re-run; NEVER `--applied`).
-- HARD DEPLOY ORDER (L-184): apply to prod (fresh backup, `prod-migrate.mjs`), `schema-drift.mjs` exit 0, and
-- ONLY THEN merge the code that reads "revision" / writes revisions. After that code deploys, re-run the backfill
-- INSERT below once (it is idempotent) to sweep any rule old code created in between (it would have no revision 1).
--
-- Rollback:
--   DROP TABLE "SellingRestrictionRevision";
--   ALTER TABLE "SellingRestriction" DROP COLUMN "revision";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "SellingRestriction" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "SellingRestrictionRevision" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "jurisdiction" "RestrictionJurisdiction" NOT NULL,
    "states" TEXT[],
    "surface" "RestrictionSurface" NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "editedById" TEXT,
    "editedByName" TEXT,
    "editedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "SellingRestrictionRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SellingRestrictionRevision_ruleId_revision_key" ON "SellingRestrictionRevision"("ruleId", "revision");

-- CreateIndex
CREATE INDEX "SellingRestrictionRevision_tenantId_ruleId_idx" ON "SellingRestrictionRevision"("tenantId", "ruleId");

-- AddForeignKey
ALTER TABLE "SellingRestrictionRevision" ADD CONSTRAINT "SellingRestrictionRevision_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellingRestrictionRevision" ADD CONSTRAINT "SellingRestrictionRevision_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "SellingRestriction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: revision 1 of every existing rule = its CURRENT values, attributed to its creator and dated createdAt.
-- Idempotent: a rule that already has ANY revision row is skipped, so the same statement can be re-run after the
-- code deploys. (Old rules were immutable, so "current" IS "as created".)
INSERT INTO "SellingRestrictionRevision"
  ("id", "tenantId", "ruleId", "revision", "jurisdiction", "states", "surface", "effectiveFrom", "effectiveTo",
   "reason", "editedById", "editedByName", "editedAt")
SELECT gen_random_uuid()::text, r."tenantId", r."id", 1, r."jurisdiction", r."states", r."surface", r."effectiveFrom",
       r."effectiveTo", r."reason", r."createdById", r."createdByName", r."createdAt"
FROM "SellingRestriction" r
WHERE NOT EXISTS (SELECT 1 FROM "SellingRestrictionRevision" v WHERE v."ruleId" = r."id");

COMMIT;
