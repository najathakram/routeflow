-- Keep every purchase-invoice scan.
--
-- The scan endpoint was stateless: it called the model, handed the result to the
-- browser and kept nothing. Abandoning a review therefore lost both the
-- extraction and the money spent producing it, and nothing recorded that a given
-- document had ever been seen — which is how the same PDFs were imported 21
-- times before anyone noticed.
--
-- InvoiceScan is written at scan time and carries three duplicate keys, strongest
-- first: fileHash (identical bytes — checked before the model runs, so a repeat
-- upload is free and instant), lineFingerprint (identical qty/unit-cost figures,
-- which survives re-photographing and the OCR wording drift that defeated text
-- comparison), and supplierInvoiceNumber (the printed identity, when legible).
-- extractedPayload holds the full model output, including the per-line sku,
-- packSize, lineTotal, confidence and candidate matches that no bill column can.
--
-- Also stops the bill tables discarding what the scan already read: tax and
-- subtotal on the bill (tax was folded into totalOwed and lost on the first edit)
-- and sku / packSize / lineTotal on each line.
--
-- Entirely additive: one new table plus nullable columns. Nothing reads these
-- until the application code that populates them ships.

CREATE TYPE "InvoiceScanStatus" AS ENUM ('SCANNED', 'POSTED', 'DISCARDED', 'DUPLICATE');

CREATE TABLE "InvoiceScan" (
  "id"                    TEXT NOT NULL,
  "tenantId"              TEXT,
  "fileKey"               TEXT,
  "fileName"              TEXT,
  "mimeType"              TEXT,
  "byteSize"              INTEGER,
  "pageCount"             INTEGER,
  "fileHash"              TEXT NOT NULL,
  "extractedPayload"      JSONB NOT NULL,
  "model"                 TEXT,
  "scanDurationMs"        INTEGER,
  "supplierNameRaw"       TEXT,
  "supplierId"            TEXT,
  "supplierInvoiceNumber" TEXT,
  "invoiceDate"           TIMESTAMP(3),
  "subtotal"              DECIMAL(12,2),
  "tax"                   DECIMAL(12,2),
  "total"                 DECIMAL(12,2),
  "lineCount"             INTEGER,
  "lineFingerprint"       TEXT,
  "status"                "InvoiceScanStatus" NOT NULL DEFAULT 'SCANNED',
  "vendorBillId"          TEXT,
  "duplicateOfId"         TEXT,
  "scannedById"           TEXT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InvoiceScan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InvoiceScan_tenantId_fileHash_idx"              ON "InvoiceScan"("tenantId", "fileHash");
CREATE INDEX "InvoiceScan_tenantId_lineFingerprint_idx"       ON "InvoiceScan"("tenantId", "lineFingerprint");
CREATE INDEX "InvoiceScan_tenantId_supplierInvoiceNumber_idx" ON "InvoiceScan"("tenantId", "supplierInvoiceNumber");
CREATE INDEX "InvoiceScan_tenantId_status_idx"                ON "InvoiceScan"("tenantId", "status");
CREATE INDEX "InvoiceScan_vendorBillId_idx"                   ON "InvoiceScan"("vendorBillId");
CREATE INDEX "InvoiceScan_supplierId_idx"                     ON "InvoiceScan"("supplierId");

ALTER TABLE "InvoiceScan" ADD CONSTRAINT "InvoiceScan_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InvoiceScan" ADD CONSTRAINT "InvoiceScan_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InvoiceScan" ADD CONSTRAINT "InvoiceScan_vendorBillId_fkey"
  FOREIGN KEY ("vendorBillId") REFERENCES "VendorBill"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InvoiceScan" ADD CONSTRAINT "InvoiceScan_duplicateOfId_fkey"
  FOREIGN KEY ("duplicateOfId") REFERENCES "InvoiceScan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Stop discarding what the scan already read.
ALTER TABLE "VendorBill"     ADD COLUMN IF NOT EXISTS "taxAmount" DECIMAL(12,2);
ALTER TABLE "VendorBill"     ADD COLUMN IF NOT EXISTS "subtotal"  DECIMAL(12,2);
ALTER TABLE "VendorBillItem" ADD COLUMN IF NOT EXISTS "sku"       TEXT;
ALTER TABLE "VendorBillItem" ADD COLUMN IF NOT EXISTS "packSize"  INTEGER;
ALTER TABLE "VendorBillItem" ADD COLUMN IF NOT EXISTS "lineTotal" DECIMAL(12,2);
