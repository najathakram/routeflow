-- T6 (owner ruling 2026-09-20): tenantId may never be NULL on the 56 tenant-owned business tables
-- whose writers were audited to stamp it (the T6 / D5 audit; the two nested-create gaps it found are
-- fixed by the PR that must land BEFORE this one). Part 1 of 2: ADD the
-- CHECK as NOT VALID — metadata only, no table scan; it is enforced for every NEW insert/update from
-- the moment it commits. Part 2 (the next migration) VALIDATEs it against existing rows.
--
-- A CHECK, not `SET NOT NULL`: the integrity is identical (a NULL tenantId is rejected), but Prisma
-- does not model CHECK constraints, so the schema and the generated client stay untouched and the
-- drift gate stays green. The later `ALTER COLUMN ... SET NOT NULL` (+ `tenantId String` in the
-- schema, + 56 compile fixes) is a separate PR; on PG12+ it skips the scan because the validated
-- CHECK already proves it.
--
-- NOT covered here on purpose: the 19 tables that need a backfill first, and the 6 that stay
-- nullable by design (User, RefreshToken, PaymentCounter, ExpenseCategory, VendorBillItem, AuditLog).
--
-- Rollback (per table, instant, no data touched): ALTER TABLE "<t>" DROP CONSTRAINT "<t>_tenantId_nn";
--
-- Why lock_timeout: each ADD CONSTRAINT needs a brief ACCESS EXCLUSIVE lock on its table, and a
-- waiting ACCESS EXCLUSIVE lock blocks every reader queued behind it. Prisma applies this whole
-- file as ONE transaction, so the 56 locks are held until COMMIT; lock_timeout bounds each WAIT (not
-- their sum). On real tables each ADD is metadata-only and instant, so the whole file takes well
-- under a second; if a wait ever exceeds 5s the statement errors, the transaction rolls back (no
-- constraint is left half-added) and the migration is recorded as FAILED — recover with
-- `prisma migrate resolve --rolled-back 20260920200000_t6_tenantid_check_not_valid` from apps/api,
-- then re-run (see the PR body). NEVER `--applied`: that would mark the guard as installed when it is not.
SET lock_timeout = '5s';

ALTER TABLE "Product" ADD CONSTRAINT "Product_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "ProductMapping" ADD CONSTRAINT "ProductMapping_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "StockCountSession" ADD CONSTRAINT "StockCountSession_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "StockLot" ADD CONSTRAINT "StockLot_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "CustomerDocument" ADD CONSTRAINT "CustomerDocument_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "CustomerAddress" ADD CONSTRAINT "CustomerAddress_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "DriverLocation" ADD CONSTRAINT "DriverLocation_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "Route" ADD CONSTRAINT "Route_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "RouteStop" ADD CONSTRAINT "RouteStop_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "RouteRun" ADD CONSTRAINT "RouteRun_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "RouteRunStop" ADD CONSTRAINT "RouteRunStop_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "Order" ADD CONSTRAINT "Order_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "OrderRevision" ADD CONSTRAINT "OrderRevision_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "DeliveryMutation" ADD CONSTRAINT "DeliveryMutation_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "OrderTemplate" ADD CONSTRAINT "OrderTemplate_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "OrderTemplateItem" ADD CONSTRAINT "OrderTemplateItem_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "ContactPerson" ADD CONSTRAINT "ContactPerson_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "CustomerTag" ADD CONSTRAINT "CustomerTag_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "CustomerComment" ADD CONSTRAINT "CustomerComment_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "Return" ADD CONSTRAINT "Return_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "ReturnItem" ADD CONSTRAINT "ReturnItem_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "SalesAgent" ADD CONSTRAINT "SalesAgent_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "SalesAgentRate" ADD CONSTRAINT "SalesAgentRate_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "CustomerCommissionRate" ADD CONSTRAINT "CustomerCommissionRate_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "AgentAssignment" ADD CONSTRAINT "AgentAssignment_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "CommissionStatement" ADD CONSTRAINT "CommissionStatement_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "CommissionStatementLine" ADD CONSTRAINT "CommissionStatementLine_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "CommissionPayout" ADD CONSTRAINT "CommissionPayout_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "ExpenseLineItem" ADD CONSTRAINT "ExpenseLineItem_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "MileageRate" ADD CONSTRAINT "MileageRate_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "OrderCreditNote" ADD CONSTRAINT "OrderCreditNote_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "EstimateItem" ADD CONSTRAINT "EstimateItem_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "VendorBill" ADD CONSTRAINT "VendorBill_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "InvoiceScan" ADD CONSTRAINT "InvoiceScan_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "SupplierStatementScan" ADD CONSTRAINT "SupplierStatementScan_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "BillPayment" ADD CONSTRAINT "BillPayment_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "AdvancePayment" ADD CONSTRAINT "AdvancePayment_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "SupplierCredit" ADD CONSTRAINT "SupplierCredit_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "Message" ADD CONSTRAINT "Message_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "MessageThread" ADD CONSTRAINT "MessageThread_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "NotificationRule" ADD CONSTRAINT "NotificationRule_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID;

RESET lock_timeout;
