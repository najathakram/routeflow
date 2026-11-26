-- SA-1295 A2, Sitting 1, folder 1 of 3: the QuickBooks history import's stage-1 tables and the tenant guard.
--   1. Six enums and six NEW, EMPTY tables: "LegacyImportBatch", "LegacyImportFile", "LegacyImportIssue",
--      "LegacySalesDocument", "LegacySalesLine", "SourceItemAlias". "tenantId" is TEXT NOT NULL on all six.
--      "LegacyImportBatch"."jobTokenHash" holds the SHA-256 of the one-time job token (SA-1507 rule 5).
--   2. Nine foreign keys, exactly the SA-1507 Amendment 1 (A1-1) set, each ON UPDATE NO ACTION:
--        child -> parent, composite (tenantId, <parentId>) -> (tenantId, id), ON DELETE CASCADE:
--          File -> Batch, Issue -> Batch, Issue -> File, Document -> Batch, Document -> File, Line -> Document
--        "LegacySalesDocument"."customerId" -> "Customer"  ON DELETE SET NULL (the only SET NULL)
--        "LegacySalesLine"."productId" and "SourceItemAlias"."productId" -> "Product"  ON DELETE RESTRICT (A1-2)
--      The three (tenantId, id) unique keys are table constraints, because the composite FKs need them
--      while the tables are created, before any index. No FK to "Tenant" or any user table.
--   3. "legacy_import_tenant_guard"() and one BEFORE INSERT OR UPDATE OR DELETE row trigger per table
--      (SA-1507 rule 1): a write lands only in the transaction's session tenant (app.current_tenant_id), none is
--      allowed with no session tenant, and a stored Customer or Product id must belong to the row's tenant.
--      Only an RI action (pg_trigger_depth() > 1) is exempt: a DELETE, or the one UPDATE that nulls
--      "LegacySalesDocument"."customerId" and changes nothing else. The refusal is SQLSTATE 42501 and its text
--      carries the table name only, never an id or a tenant.
--   4. The indexes, including the three FK-leading ones (Amendment 2 N1) and one on "LegacySalesDocument"
--      (tenantId, fileId) for the composite File cascade.
--   5. LAST: "ImportExternalRef" gains the nullable "confirmedAt" and "confirmedById" (no default, no backfill).
--
-- LOCK PROFILE (every acquisition is bounded by lock_timeout below, which bounds the WAIT, not the hold; the locks
-- are released at COMMIT):
--   "Customer":  SHARE ROW EXCLUSIVE (the inline FK): blocks INSERT, UPDATE, DELETE on "Customer"; reads pass. DDL
--                only, no scan: the new table is empty, so the FK validates nothing.
--   "Product":   SHARE ROW EXCLUSIVE (two inline FKs): blocks writes on "Product"; reads pass.
--   "ImportExternalRef": ACCESS EXCLUSIVE (ADD COLUMN, metadata only, no rewrite), taken by the last statement and held
--                to COMMIT (milliseconds).
--   The six new tables, the function and the triggers are not visible to anything else yet.
--   The guard's own lookup takes ACCESS SHARE on "Customer" and "Product" at write time only, never in this migration.
--   Fails only on lock_timeout (a "Customer", "Product" or "ImportExternalRef" write transaction open for more than 5 s).
--
-- DEPLOY ORDER (L-184): migrate FIRST, merge SECOND. Once merged, the client selects "confirmedAt" and
-- "confirmedById" on every "ImportExternalRef" read. This reaches production only at the owner-approved Sitting 1,
-- through apps/api/scripts/prod-migrate.mjs; nothing auto-migrates.
--
-- RECOVERY: a failure rolls the whole file back and Prisma records it FAILED, which blocks every later deploy (P3009).
--   From apps/api, with the sitting's own owner yes: prisma migrate resolve --rolled-back 20261126000000_legacy_import_stage1
--   (through prod-migrate-resolve.mjs). NEVER --applied. One retry per folder, at least 15 minutes later, never at night.
--
-- ROLLBACK (only on an SA ruling): drop the six tables (this releases the three FKs to "Customer" and "Product"), the
--   function, then the six enums; drop the two "ImportExternalRef" columns.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "LegacyImportBatchStatus" AS ENUM ('UPLOADED', 'PARSING', 'STAGED', 'CONFIRMED', 'DISCARDED', 'FAILED');

-- CreateEnum
CREATE TYPE "LegacyImportFileKind" AS ENUM ('SALES_LINES', 'OPEN_ITEMS', 'PAYMENTS', 'CREDIT_MEMOS', 'CUSTOMER_LIST', 'ITEM_LIST', 'API_PULL');

-- CreateEnum
CREATE TYPE "LegacyImportIssueSeverity" AS ENUM ('ERROR', 'WARNING');

-- CreateEnum
CREATE TYPE "LegacySalesDocumentKind" AS ENUM ('INVOICE', 'CREDIT_MEMO', 'SALES_RECEIPT', 'REFUND_RECEIPT', 'NEGATIVE_UNKNOWN');

-- CreateEnum
CREATE TYPE "LegacySalesLineKind" AS ENUM ('PRODUCT', 'SHIPPING', 'DISCOUNT', 'NOTE', 'OTHER');

-- CreateEnum
CREATE TYPE "LegacyItemMatchMethod" AS ENUM ('EXACT', 'NORMALISED', 'ALIAS', 'MANUAL', 'NONE');

-- CreateTable
CREATE TABLE "LegacyImportBatch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "source" "MigrationSource" NOT NULL,
    "status" "LegacyImportBatchStatus" NOT NULL DEFAULT 'UPLOADED',
    "numberPrefix" TEXT,
    "cutoverDate" DATE,
    "rfGoLiveDate" DATE,
    "rfGoLiveConfirmedAt" TIMESTAMP(3),
    "rfGoLiveConfirmedById" TEXT,
    "controlAsOfDate" DATE,
    "receivablesFrozenAttestedAt" TIMESTAMP(3),
    "receivablesFrozenAttestedById" TEXT,
    "counts" JSONB NOT NULL DEFAULT '{}',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "jobTokenHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegacyImportBatch_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LegacyImportBatch_tenantId_id_key" UNIQUE ("tenantId", "id")
);

-- CreateTable
CREATE TABLE "LegacyImportFile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "kind" "LegacyImportFileKind" NOT NULL,
    "adapterKey" TEXT NOT NULL,
    "adapterVersion" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "fileBytes" INTEGER NOT NULL,
    "storageKey" TEXT,
    "parseStatus" "LegacyImportBatchStatus" NOT NULL DEFAULT 'UPLOADED',
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegacyImportFile_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LegacyImportFile_tenantId_id_key" UNIQUE ("tenantId", "id"),
    CONSTRAINT "LegacyImportFile_tenantId_batchId_fkey" FOREIGN KEY ("tenantId", "batchId") REFERENCES "LegacyImportBatch"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "LegacyImportIssue" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "recordNo" INTEGER,
    "physicalLine" INTEGER NOT NULL,
    "severity" "LegacyImportIssueSeverity" NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "sourceDocKey" TEXT,
    "sourceCustomerKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegacyImportIssue_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LegacyImportIssue_tenantId_batchId_fkey" FOREIGN KEY ("tenantId", "batchId") REFERENCES "LegacyImportBatch"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "LegacyImportIssue_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "LegacyImportFile"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "LegacySalesDocument" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "source" "MigrationSource" NOT NULL,
    "kind" "LegacySalesDocumentKind" NOT NULL,
    "sourceNumber" TEXT,
    "sourceTxnId" TEXT,
    "sourceTxnSpace" TEXT,
    "sourceKey" TEXT NOT NULL,
    "sourceCustomerKey" TEXT NOT NULL,
    "sourceCustomerName" TEXT,
    "customerId" TEXT,
    "docDate" DATE NOT NULL,
    "dueDate" DATE,
    "subtotal" DECIMAL(12,2),
    "taxAmount" DECIMAL(12,2),
    "shipping" DECIMAL(12,2),
    "discount" DECIMAL(12,2),
    "total" DECIMAL(12,2),
    "linesTotal" DECIMAL(12,2) NOT NULL,
    "sourceBalance" DECIMAL(12,2),
    "overlap" BOOLEAN NOT NULL DEFAULT false,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegacySalesDocument_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LegacySalesDocument_tenantId_id_key" UNIQUE ("tenantId", "id"),
    CONSTRAINT "LegacySalesDocument_tenantId_batchId_fkey" FOREIGN KEY ("tenantId", "batchId") REFERENCES "LegacyImportBatch"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "LegacySalesDocument_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "LegacyImportFile"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "LegacySalesDocument_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "LegacySalesLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "physicalLine" INTEGER NOT NULL,
    "kind" "LegacySalesLineKind" NOT NULL,
    "sourceItemText" TEXT,
    "sourceItemKey" TEXT,
    "description" TEXT,
    "qty" DECIMAL(14,3),
    "unitPrice" DECIMAL(12,4),
    "total" DECIMAL(12,2),
    "productId" TEXT,
    "matchMethod" "LegacyItemMatchMethod" NOT NULL DEFAULT 'NONE',
    "unitKnown" BOOLEAN NOT NULL DEFAULT false,
    "unitLabel" TEXT,
    "docDate" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegacySalesLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LegacySalesLine_tenantId_documentId_fkey" FOREIGN KEY ("tenantId", "documentId") REFERENCES "LegacySalesDocument"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "LegacySalesLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "SourceItemAlias" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "source" "MigrationSource" NOT NULL,
    "sourceItemKey" TEXT NOT NULL,
    "sourceItemText" TEXT NOT NULL,
    "productId" TEXT,
    "ignore" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceItemAlias_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SourceItemAlias_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

-- The tenant guard (SA-1507 rule 1; Amendment 1 A1-2 step 2). One function, six triggers. The text of a refusal names
-- the table only. The steps run in order and the first hit wins.
CREATE FUNCTION "legacy_import_tenant_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  s text;
  v text;
  moved boolean;
BEGIN
  -- Step 1: the session tenant, as text. An unset setting and '' both read as NULL.
  s := NULLIF(current_setting('app.current_tenant_id', true), '');

  -- Step 2: the RI exemption, narrowest possible (SA-1507 Amendment 2 A2-3). Only inside another trigger's action
  -- (depth > 1), and only the one UPDATE that nulls "customerId" on a document and changes nothing else. INSERT and
  -- DELETE are never exempt: a cascaded child is the session tenant's own row and passes step 4.
  IF pg_trigger_depth() > 1 THEN
    IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'LegacySalesDocument' THEN
      IF NEW."tenantId"::text = OLD."tenantId"::text
         AND OLD."customerId" IS NOT NULL
         AND NEW."customerId" IS NULL
         AND (to_jsonb(NEW) - 'customerId') = (to_jsonb(OLD) - 'customerId') THEN
        RETURN NEW;
      END IF;
    END IF;
  END IF;

  -- Step 3: no session tenant, no write.
  IF s IS NULL THEN
    RAISE EXCEPTION 'legacy_import_tenant_guard: %', TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;

  -- Step 4: the row's tenant is the session tenant, before and after.
  IF TG_OP = 'INSERT' THEN
    IF NEW."tenantId"::text <> s THEN
      RAISE EXCEPTION 'legacy_import_tenant_guard: %', TG_TABLE_NAME USING ERRCODE = '42501';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD."tenantId"::text <> s OR NEW."tenantId"::text <> OLD."tenantId"::text THEN
      RAISE EXCEPTION 'legacy_import_tenant_guard: %', TG_TABLE_NAME USING ERRCODE = '42501';
    END IF;
  ELSE
    IF OLD."tenantId"::text <> s THEN
      RAISE EXCEPTION 'legacy_import_tenant_guard: %', TG_TABLE_NAME USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Step 5: a stored Customer or Product id must belong to the row's tenant.
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v := to_jsonb(NEW) ->> 'customerId';
    moved := TRUE;
    IF TG_OP = 'UPDATE' THEN
      moved := v IS DISTINCT FROM (to_jsonb(OLD) ->> 'customerId');
    END IF;
    IF v IS NOT NULL AND moved THEN
      IF NOT EXISTS (SELECT 1 FROM "Customer" c WHERE c."id" = v AND c."tenantId" = NEW."tenantId"::text) THEN
        RAISE EXCEPTION 'legacy_import_tenant_guard: %', TG_TABLE_NAME USING ERRCODE = '42501';
      END IF;
    END IF;

    v := to_jsonb(NEW) ->> 'productId';
    moved := TRUE;
    IF TG_OP = 'UPDATE' THEN
      moved := v IS DISTINCT FROM (to_jsonb(OLD) ->> 'productId');
    END IF;
    IF v IS NOT NULL AND moved THEN
      IF NOT EXISTS (SELECT 1 FROM "Product" p WHERE p."id" = v AND p."tenantId" = NEW."tenantId"::text) THEN
        RAISE EXCEPTION 'legacy_import_tenant_guard: %', TG_TABLE_NAME USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  -- Step 6.
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "LegacyImportBatch_tenant_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LegacyImportBatch" FOR EACH ROW EXECUTE FUNCTION "legacy_import_tenant_guard"();

CREATE TRIGGER "LegacyImportFile_tenant_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LegacyImportFile" FOR EACH ROW EXECUTE FUNCTION "legacy_import_tenant_guard"();

CREATE TRIGGER "LegacyImportIssue_tenant_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LegacyImportIssue" FOR EACH ROW EXECUTE FUNCTION "legacy_import_tenant_guard"();

CREATE TRIGGER "LegacySalesDocument_tenant_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LegacySalesDocument" FOR EACH ROW EXECUTE FUNCTION "legacy_import_tenant_guard"();

CREATE TRIGGER "LegacySalesLine_tenant_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LegacySalesLine" FOR EACH ROW EXECUTE FUNCTION "legacy_import_tenant_guard"();

CREATE TRIGGER "SourceItemAlias_tenant_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SourceItemAlias" FOR EACH ROW EXECUTE FUNCTION "legacy_import_tenant_guard"();

-- CreateIndex
CREATE INDEX "LegacyImportBatch_tenantId_createdAt_idx" ON "LegacyImportBatch"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "LegacyImportBatch_tenantId_status_idx" ON "LegacyImportBatch"("tenantId", "status");

-- CreateIndex
CREATE INDEX "LegacyImportFile_tenantId_batchId_idx" ON "LegacyImportFile"("tenantId", "batchId");

-- CreateIndex
CREATE INDEX "LegacyImportFile_tenantId_fileSha256_idx" ON "LegacyImportFile"("tenantId", "fileSha256");

-- CreateIndex
CREATE INDEX "LegacyImportIssue_tenantId_batchId_severity_idx" ON "LegacyImportIssue"("tenantId", "batchId", "severity");

-- CreateIndex
CREATE INDEX "LegacyImportIssue_fileId_physicalLine_idx" ON "LegacyImportIssue"("fileId", "physicalLine");

-- CreateIndex
CREATE UNIQUE INDEX "LegacySalesDocument_tenantId_source_sourceKey_key" ON "LegacySalesDocument"("tenantId", "source", "sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "LegacySalesDocument_tenantId_source_sourceTxnSpace_sourceTx_key" ON "LegacySalesDocument"("tenantId", "source", "sourceTxnSpace", "sourceTxnId");

-- CreateIndex
CREATE INDEX "LegacySalesDocument_tenantId_customerId_docDate_idx" ON "LegacySalesDocument"("tenantId", "customerId", "docDate");

-- CreateIndex
CREATE INDEX "LegacySalesDocument_tenantId_batchId_idx" ON "LegacySalesDocument"("tenantId", "batchId");

-- CreateIndex
CREATE INDEX "LegacySalesDocument_tenantId_source_sourceCustomerKey_idx" ON "LegacySalesDocument"("tenantId", "source", "sourceCustomerKey");

-- CreateIndex
CREATE INDEX "LegacySalesDocument_tenantId_fileId_idx" ON "LegacySalesDocument"("tenantId", "fileId");

-- CreateIndex (FK-leading: the SET NULL action on a Customer delete)
CREATE INDEX "LegacySalesDocument_customerId_idx" ON "LegacySalesDocument"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "LegacySalesLine_documentId_lineNo_key" ON "LegacySalesLine"("documentId", "lineNo");

-- CreateIndex
CREATE INDEX "LegacySalesLine_tenantId_documentId_productId_idx" ON "LegacySalesLine"("tenantId", "documentId", "productId");

-- CreateIndex
CREATE INDEX "LegacySalesLine_tenantId_productId_docDate_idx" ON "LegacySalesLine"("tenantId", "productId", "docDate");

-- CreateIndex
CREATE INDEX "LegacySalesLine_tenantId_sourceItemKey_idx" ON "LegacySalesLine"("tenantId", "sourceItemKey");

-- CreateIndex (FK-leading: the RESTRICT check on a Product delete)
CREATE INDEX "LegacySalesLine_productId_idx" ON "LegacySalesLine"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "SourceItemAlias_tenantId_source_sourceItemKey_key" ON "SourceItemAlias"("tenantId", "source", "sourceItemKey");

-- CreateIndex
CREATE INDEX "SourceItemAlias_tenantId_productId_idx" ON "SourceItemAlias"("tenantId", "productId");

-- CreateIndex (FK-leading: the RESTRICT check on a Product delete)
CREATE INDEX "SourceItemAlias_productId_idx" ON "SourceItemAlias"("productId");

-- SA-816 (d)1: the not-NaN backstop on every NUMERIC column of the two new tables that have them (numeric-not-nan-check.spec.ts).
-- The tables were created above in this transaction and are empty, so the checks validate instantly.
ALTER TABLE "LegacySalesDocument"
  ADD CONSTRAINT "LegacySalesDocument_discount_not_nan" CHECK ("discount" <> 'NaN'::numeric),
  ADD CONSTRAINT "LegacySalesDocument_linesTotal_not_nan" CHECK ("linesTotal" <> 'NaN'::numeric),
  ADD CONSTRAINT "LegacySalesDocument_shipping_not_nan" CHECK ("shipping" <> 'NaN'::numeric),
  ADD CONSTRAINT "LegacySalesDocument_sourceBalance_not_nan" CHECK ("sourceBalance" <> 'NaN'::numeric),
  ADD CONSTRAINT "LegacySalesDocument_subtotal_not_nan" CHECK ("subtotal" <> 'NaN'::numeric),
  ADD CONSTRAINT "LegacySalesDocument_taxAmount_not_nan" CHECK ("taxAmount" <> 'NaN'::numeric),
  ADD CONSTRAINT "LegacySalesDocument_total_not_nan" CHECK ("total" <> 'NaN'::numeric);

ALTER TABLE "LegacySalesLine"
  ADD CONSTRAINT "LegacySalesLine_qty_not_nan" CHECK ("qty" <> 'NaN'::numeric),
  ADD CONSTRAINT "LegacySalesLine_total_not_nan" CHECK ("total" <> 'NaN'::numeric),
  ADD CONSTRAINT "LegacySalesLine_unitPrice_not_nan" CHECK ("unitPrice" <> 'NaN'::numeric);

-- AlterTable (LAST: it takes ACCESS EXCLUSIVE on "ImportExternalRef", held to COMMIT)
ALTER TABLE "ImportExternalRef" ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "confirmedById" TEXT;

COMMIT;
