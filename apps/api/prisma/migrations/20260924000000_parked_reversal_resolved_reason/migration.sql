-- SA-089a / Opus review (B660 PR B, #1324): persist the operator's own resolve-time reason on
-- the parked row itself, not only in the audit log's `operatorReason` meta field — a nullable,
-- additive column, no backfill (every existing row, and every row parked before this ships,
-- reads NULL until resolved). ADD COLUMN of a nullable column with no default is metadata-only
-- in Postgres (no table rewrite, no scan). Distinct from the pre-existing "reason" column, which
-- is the PARK reason (why the classifier couldn't book it) — this one is the operator's own text
-- at resolve time.
--
-- Rollback (instant while nullable and unindexed):
--   ALTER TABLE "RegulatedLedgerParkedReversal" DROP COLUMN "resolvedReason";

SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "RegulatedLedgerParkedReversal" ADD COLUMN "resolvedReason" TEXT;
