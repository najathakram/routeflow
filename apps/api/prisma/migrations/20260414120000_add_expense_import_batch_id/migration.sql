-- Add importBatchId to Expense for import rollback and deduplication tracking
ALTER TABLE "Expense" ADD COLUMN "importBatchId" TEXT;

-- Index for fast batch lookups (rollback, history)
CREATE INDEX "Expense_importBatchId_idx" ON "Expense"("importBatchId");
