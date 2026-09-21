-- T6 part 2 of 2: VALIDATE the 56 `<table>_tenantId_nn` CHECK constraints added by the previous
-- migration. VALIDATE takes only SHARE UPDATE EXCLUSIVE (reads AND writes continue) and scans each
-- table once. It FAILS if any row still has a NULL tenantId — run the read-only pre-check in the PR
-- body first. A failure aborts this migration (nothing is left half-validated by it) and leaves the
-- part-1 constraints in place, so new NULLs are already refused.
--
-- Rollback: none needed (validation changes no data); to remove the guard entirely see part 1.
-- If this migration FAILS it is recorded as failed: fix the NULL rows the error names (or drop that
-- table's constraint), then `prisma migrate resolve --rolled-back 20260920220100_t6_tenantid_check_validate`
-- from apps/api and re-run. NEVER `--applied`.
--
-- lock_timeout: VALIDATE holds SHARE UPDATE EXCLUSIVE (writes continue) but conflicts with DDL and
-- autovacuum, and Prisma holds all 56 until COMMIT — so a wait is bounded, not open-ended.
SET lock_timeout = '5s';

ALTER TABLE "Product" VALIDATE CONSTRAINT "Product_tenantId_nn";
ALTER TABLE "Supplier" VALIDATE CONSTRAINT "Supplier_tenantId_nn";
ALTER TABLE "PurchaseOrder" VALIDATE CONSTRAINT "PurchaseOrder_tenantId_nn";
ALTER TABLE "ProductMapping" VALIDATE CONSTRAINT "ProductMapping_tenantId_nn";
ALTER TABLE "StockCountSession" VALIDATE CONSTRAINT "StockCountSession_tenantId_nn";
ALTER TABLE "StockCountLine" VALIDATE CONSTRAINT "StockCountLine_tenantId_nn";
ALTER TABLE "StockLot" VALIDATE CONSTRAINT "StockLot_tenantId_nn";
ALTER TABLE "StockMovement" VALIDATE CONSTRAINT "StockMovement_tenantId_nn";
ALTER TABLE "Customer" VALIDATE CONSTRAINT "Customer_tenantId_nn";
ALTER TABLE "CustomerDocument" VALIDATE CONSTRAINT "CustomerDocument_tenantId_nn";
ALTER TABLE "CustomerAddress" VALIDATE CONSTRAINT "CustomerAddress_tenantId_nn";
ALTER TABLE "Driver" VALIDATE CONSTRAINT "Driver_tenantId_nn";
ALTER TABLE "DriverLocation" VALIDATE CONSTRAINT "DriverLocation_tenantId_nn";
ALTER TABLE "Route" VALIDATE CONSTRAINT "Route_tenantId_nn";
ALTER TABLE "RouteStop" VALIDATE CONSTRAINT "RouteStop_tenantId_nn";
ALTER TABLE "RouteRun" VALIDATE CONSTRAINT "RouteRun_tenantId_nn";
ALTER TABLE "RouteRunStop" VALIDATE CONSTRAINT "RouteRunStop_tenantId_nn";
ALTER TABLE "Order" VALIDATE CONSTRAINT "Order_tenantId_nn";
ALTER TABLE "OrderRevision" VALIDATE CONSTRAINT "OrderRevision_tenantId_nn";
ALTER TABLE "ChangeRequest" VALIDATE CONSTRAINT "ChangeRequest_tenantId_nn";
ALTER TABLE "OrderItem" VALIDATE CONSTRAINT "OrderItem_tenantId_nn";
ALTER TABLE "DeliveryMutation" VALIDATE CONSTRAINT "DeliveryMutation_tenantId_nn";
ALTER TABLE "OrderTemplate" VALIDATE CONSTRAINT "OrderTemplate_tenantId_nn";
ALTER TABLE "OrderTemplateItem" VALIDATE CONSTRAINT "OrderTemplateItem_tenantId_nn";
ALTER TABLE "ContactPerson" VALIDATE CONSTRAINT "ContactPerson_tenantId_nn";
ALTER TABLE "CustomerTag" VALIDATE CONSTRAINT "CustomerTag_tenantId_nn";
ALTER TABLE "CustomerComment" VALIDATE CONSTRAINT "CustomerComment_tenantId_nn";
ALTER TABLE "Return" VALIDATE CONSTRAINT "Return_tenantId_nn";
ALTER TABLE "ReturnItem" VALIDATE CONSTRAINT "ReturnItem_tenantId_nn";
ALTER TABLE "SalesAgent" VALIDATE CONSTRAINT "SalesAgent_tenantId_nn";
ALTER TABLE "SalesAgentRate" VALIDATE CONSTRAINT "SalesAgentRate_tenantId_nn";
ALTER TABLE "CustomerCommissionRate" VALIDATE CONSTRAINT "CustomerCommissionRate_tenantId_nn";
ALTER TABLE "AgentAssignment" VALIDATE CONSTRAINT "AgentAssignment_tenantId_nn";
ALTER TABLE "CommissionStatement" VALIDATE CONSTRAINT "CommissionStatement_tenantId_nn";
ALTER TABLE "CommissionStatementLine" VALIDATE CONSTRAINT "CommissionStatementLine_tenantId_nn";
ALTER TABLE "CommissionPayout" VALIDATE CONSTRAINT "CommissionPayout_tenantId_nn";
ALTER TABLE "Invoice" VALIDATE CONSTRAINT "Invoice_tenantId_nn";
ALTER TABLE "InvoiceItem" VALIDATE CONSTRAINT "InvoiceItem_tenantId_nn";
ALTER TABLE "InvoicePayment" VALIDATE CONSTRAINT "InvoicePayment_tenantId_nn";
ALTER TABLE "Expense" VALIDATE CONSTRAINT "Expense_tenantId_nn";
ALTER TABLE "ExpenseLineItem" VALIDATE CONSTRAINT "ExpenseLineItem_tenantId_nn";
ALTER TABLE "MileageRate" VALIDATE CONSTRAINT "MileageRate_tenantId_nn";
ALTER TABLE "CreditNote" VALIDATE CONSTRAINT "CreditNote_tenantId_nn";
ALTER TABLE "OrderCreditNote" VALIDATE CONSTRAINT "OrderCreditNote_tenantId_nn";
ALTER TABLE "Estimate" VALIDATE CONSTRAINT "Estimate_tenantId_nn";
ALTER TABLE "EstimateItem" VALIDATE CONSTRAINT "EstimateItem_tenantId_nn";
ALTER TABLE "VendorBill" VALIDATE CONSTRAINT "VendorBill_tenantId_nn";
ALTER TABLE "InvoiceScan" VALIDATE CONSTRAINT "InvoiceScan_tenantId_nn";
ALTER TABLE "SupplierStatementScan" VALIDATE CONSTRAINT "SupplierStatementScan_tenantId_nn";
ALTER TABLE "BillPayment" VALIDATE CONSTRAINT "BillPayment_tenantId_nn";
ALTER TABLE "AdvancePayment" VALIDATE CONSTRAINT "AdvancePayment_tenantId_nn";
ALTER TABLE "SupplierCredit" VALIDATE CONSTRAINT "SupplierCredit_tenantId_nn";
ALTER TABLE "Message" VALIDATE CONSTRAINT "Message_tenantId_nn";
ALTER TABLE "MessageThread" VALIDATE CONSTRAINT "MessageThread_tenantId_nn";
ALTER TABLE "MessageTemplate" VALIDATE CONSTRAINT "MessageTemplate_tenantId_nn";
ALTER TABLE "NotificationRule" VALIDATE CONSTRAINT "NotificationRule_tenantId_nn";

RESET lock_timeout;
