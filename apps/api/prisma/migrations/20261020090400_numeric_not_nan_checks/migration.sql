-- SA-816 (d)1, sitting 4 folder 6: the DB backstop against NaN in money / quantity math.
--   CHECK ("<col>" <> 'NaN') NOT VALID on EVERY NUMERIC column: 192 columns on 67 tables (every Prisma
--   `Decimal` scalar, @map/@@map resolved; it includes the columns this bundle's earlier folders add). NUMERIC accepts
--   'NaN' and node-pg sends a JS NaN as 'NaN', so one bad bind is stored and then poisons every sum. NULL still passes.
--
-- GENERATED, never hand-edited: `node apps/api/scripts/generate-not-nan-checks.mjs > <this file>` from the repo root,
-- reading apps/api/prisma/schema. Regenerate it only while this folder is unapplied (after any schema change in the
-- bundle). Once applied it is immutable: a later Decimal column adds its own CHECK in its own folder
-- (src/common/numeric-not-nan-check.spec.ts names every column without one).
--
-- NOT VALID: no table scan, and existing rows are NOT checked. (SA-816's InvoiceItem.categoryTaxAmount NaN lines
-- are already repaired on prod by the R593 repair, before this sitting.) Postgres enforces the CHECK on every INSERT
-- and on every UPDATE from the moment this commits, so an UPDATE of a row that still holds NaN fails unless the same
-- UPDATE replaces the NaN. VALIDATE is a SEPARATE later folder, per column, after a census reads 0 NaN (SA-816 (d)1).
-- CHECKs are raw SQL (Prisma does not model them), so the schema and the drift gate are unaffected (the T6 precedent,
-- 20260920220000_t6_tenantid_check_not_valid).
--
-- LOCK PROFILE: ONE transaction (the T6 precedent), ONE ALTER TABLE per table (all its CHECKs in one statement). Each
-- ALTER takes a brief ACCESS EXCLUSIVE lock (metadata-only: no scan, no rewrite), and every lock is held until COMMIT.
-- `SET LOCAL lock_timeout = '2s'` bounds each WAIT; a wait past 2s (or a deadlock with live traffic) aborts the
-- statement and the WHOLE folder rolls back cleanly: no constraint is left half-added and no data is touched. It is
-- recorded FAILED: recover with
-- `prisma migrate resolve --rolled-back 20261020090400_numeric_not_nan_checks` from apps/api, then re-run it;
-- NEVER `--applied`.
-- "current transaction is aborted" in the output means an EARLIER statement of this folder failed (a lock_timeout, a
-- deadlock): nothing is applied. Re-check pg_stat_activity (below), run
-- `prisma migrate resolve --rolled-back 20261020090400_numeric_not_nan_checks` from apps/api, then re-deploy the
-- folder; NEVER `--applied`.
--
-- RUNBOOK PRE-STEP (before applying, read-only): run it OFF-PEAK, and first check pg_stat_activity for long-running
-- or idle-in-transaction sessions (any one holding a lock on these tables makes an ACCESS EXCLUSIVE wait, and every
-- reader queues behind that wait), e.g.
--   SELECT pid, state, now() - xact_start AS xact_age, left(query, 60) FROM pg_stat_activity
--    WHERE datname = current_database() AND pid <> pg_backend_pid()
--      AND (state = 'idle in transaction' OR now() - xact_start > interval '30 seconds');
-- and confirm no pg_dump / backup is still running (it holds ACCESS SHARE on every table until it finishes). Apply
-- only when that returns nothing; otherwise wait (or ask the owner) and re-check.
--
-- Rollback (instant, no data touched): ALTER TABLE "<t>" DROP CONSTRAINT "<name>"; for each constraint below. The
-- name is "<t>_<col>_not_nan", or, past 63 bytes, a prefix + "_<8-hex>_not_nan": copy the exact names from below.

BEGIN;
SET LOCAL lock_timeout = '2s';

ALTER TABLE "AddonSku"
  ADD CONSTRAINT "AddonSku_monthlyPrice_not_nan" CHECK ("monthlyPrice" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "AdvancePayment"
  ADD CONSTRAINT "AdvancePayment_amount_not_nan" CHECK ("amount" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "AdvancePayment_balance_not_nan" CHECK ("balance" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "BillPayment"
  ADD CONSTRAINT "BillPayment_amount_not_nan" CHECK ("amount" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "BillingEvent"
  ADD CONSTRAINT "BillingEvent_amountDelta_not_nan" CHECK ("amountDelta" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "BuyerPaymentRequest"
  ADD CONSTRAINT "BuyerPaymentRequest_amount_not_nan" CHECK ("amount" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "CommissionAccrual"
  ADD CONSTRAINT "CommissionAccrual_accruedAmount_not_nan" CHECK ("accruedAmount" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "CommissionAccrual_baseAmount_not_nan" CHECK ("baseAmount" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "CommissionAccrual_claimedAmount_not_nan" CHECK ("claimedAmount" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "CommissionAccrual_payableAmount_not_nan" CHECK ("payableAmount" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "CommissionAccrual_ratePct_not_nan" CHECK ("ratePct" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "CommissionAdjustment"
  ADD CONSTRAINT "CommissionAdjustment_amount_not_nan" CHECK ("amount" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "CommissionPayout"
  ADD CONSTRAINT "CommissionPayout_amount_not_nan" CHECK ("amount" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "CommissionStatement"
  ADD CONSTRAINT "CommissionStatement_paidAmount_not_nan" CHECK ("paidAmount" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "CommissionStatement_totalAmount_not_nan" CHECK ("totalAmount" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "CommissionStatementLine"
  ADD CONSTRAINT "CommissionStatementLine_amount_not_nan" CHECK ("amount" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "CounterDayClose"
  ADD CONSTRAINT "CounterDayClose_countedCash_not_nan" CHECK ("countedCash" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "CounterDayClose_expectedCash_not_nan" CHECK ("expectedCash" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "CounterDayClose_openingFloat_not_nan" CHECK ("openingFloat" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "CounterDayClose_variance_not_nan" CHECK ("variance" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "CreditNote"
  ADD CONSTRAINT "CreditNote_amount_not_nan" CHECK ("amount" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "CreditNote_amountUsed_not_nan" CHECK ("amountUsed" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "CreditNoteItem"
  ADD CONSTRAINT "CreditNoteItem_amount_not_nan" CHECK ("amount" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "CreditNoteItem_categoryTax_not_nan" CHECK ("categoryTax" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "CreditNoteItem_qty_not_nan" CHECK ("qty" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "Customer"
  ADD CONSTRAINT "Customer_creditLimit_not_nan" CHECK ("creditLimit" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Customer_defaultDepositPercent_not_nan" CHECK ("defaultDepositPercent" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "CustomerCommissionRate"
  ADD CONSTRAINT "CustomerCommissionRate_ratePct_not_nan" CHECK ("ratePct" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "CustomerPrice"
  ADD CONSTRAINT "CustomerPrice_msrp_not_nan" CHECK ("msrp" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "CustomerUnitPrice"
  ADD CONSTRAINT "CustomerUnitPrice_price_not_nan" CHECK ("price" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "DeliveryMutation"
  ADD CONSTRAINT "DeliveryMutation_qty_not_nan" CHECK ("qty" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "DeliveryMutation_quantityDelivered_not_nan" CHECK ("quantityDelivered" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "DeliveryMutation_unitPrice_not_nan" CHECK ("unitPrice" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "DriverLocation"
  ADD CONSTRAINT "DriverLocation_accuracy_not_nan" CHECK ("accuracy" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "DriverLocation_heading_not_nan" CHECK ("heading" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "DriverLocation_lat_not_nan" CHECK ("lat" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "DriverLocation_lng_not_nan" CHECK ("lng" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "DriverLocation_speedKph_not_nan" CHECK ("speedKph" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "Estimate"
  ADD CONSTRAINT "Estimate_discount_not_nan" CHECK ("discount" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Estimate_subtotal_not_nan" CHECK ("subtotal" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Estimate_taxAmount_not_nan" CHECK ("taxAmount" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Estimate_total_not_nan" CHECK ("total" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "EstimateItem"
  ADD CONSTRAINT "EstimateItem_originalPrice_not_nan" CHECK ("originalPrice" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "EstimateItem_qty_not_nan" CHECK ("qty" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "EstimateItem_subtotal_not_nan" CHECK ("subtotal" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "EstimateItem_unitPrice_not_nan" CHECK ("unitPrice" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "Expense"
  ADD CONSTRAINT "Expense_amount_not_nan" CHECK ("amount" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Expense_distance_not_nan" CHECK ("distance" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Expense_mileageRateSnapshot_not_nan" CHECK ("mileageRateSnapshot" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "ExpenseLineItem"
  ADD CONSTRAINT "ExpenseLineItem_amount_not_nan" CHECK ("amount" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "ExpenseLineItem_qty_not_nan" CHECK ("qty" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "ExpenseLineItem_unitCost_not_nan" CHECK ("unitCost" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "ImportQueueItem"
  ADD CONSTRAINT "ImportQueueItem_confidence_not_nan" CHECK ("confidence" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "ImportQueueItem_total_not_nan" CHECK ("total" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_depositPercent_not_nan" CHECK ("depositPercent" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Invoice_discount_not_nan" CHECK ("discount" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Invoice_shippingFee_not_nan" CHECK ("shippingFee" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Invoice_subtotal_not_nan" CHECK ("subtotal" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Invoice_taxAmount_not_nan" CHECK ("taxAmount" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Invoice_total_not_nan" CHECK ("total" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "InvoiceItem"
  ADD CONSTRAINT "InvoiceItem_categoryTaxAmount_not_nan" CHECK ("categoryTaxAmount" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "InvoiceItem_categoryTaxRate_not_nan" CHECK ("categoryTaxRate" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "InvoiceItem_discount_not_nan" CHECK ("discount" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "InvoiceItem_msrp_not_nan" CHECK ("msrp" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "InvoiceItem_originalPrice_not_nan" CHECK ("originalPrice" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "InvoiceItem_qty_not_nan" CHECK ("qty" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "InvoiceItem_subtotal_not_nan" CHECK ("subtotal" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "InvoiceItem_taxRate_not_nan" CHECK ("taxRate" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "InvoiceItem_unitPrice_not_nan" CHECK ("unitPrice" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "InvoiceItemComponent"
  ADD CONSTRAINT "InvoiceItemComponent_displayUnitPrice4_not_nan" CHECK ("displayUnitPrice4" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "InvoicePayment"
  ADD CONSTRAINT "InvoicePayment_amount_not_nan" CHECK ("amount" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "InvoicePayment_bankCharges_not_nan" CHECK ("bankCharges" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "InvoicePayment_nsfFeeAmount_not_nan" CHECK ("nsfFeeAmount" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "InvoiceScan"
  ADD CONSTRAINT "InvoiceScan_subtotal_not_nan" CHECK ("subtotal" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "InvoiceScan_tax_not_nan" CHECK ("tax" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "InvoiceScan_total_not_nan" CHECK ("total" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "MileageRate"
  ADD CONSTRAINT "MileageRate_ratePerUnit_not_nan" CHECK ("ratePerUnit" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_commissionRatePct_not_nan" CHECK ("commissionRatePct" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Order_counterCashTendered_not_nan" CHECK ("counterCashTendered" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Order_discountAmount_not_nan" CHECK ("discountAmount" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Order_shippingFee_not_nan" CHECK ("shippingFee" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Order_subtotal_not_nan" CHECK ("subtotal" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Order_tax_not_nan" CHECK ("tax" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Order_taxRate_not_nan" CHECK ("taxRate" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Order_total_not_nan" CHECK ("total" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "OrderCreditNote"
  ADD CONSTRAINT "OrderCreditNote_amount_not_nan" CHECK ("amount" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "OrderItem"
  ADD CONSTRAINT "OrderItem_backorderedPieces_not_nan" CHECK ("backorderedPieces" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "OrderItem_categoryTaxAmount_not_nan" CHECK ("categoryTaxAmount" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "OrderItem_categoryTaxRate_not_nan" CHECK ("categoryTaxRate" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "OrderItem_deliveredQty_not_nan" CHECK ("deliveredQty" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "OrderItem_invoicedQty_not_nan" CHECK ("invoicedQty" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "OrderItem_originalPrice_not_nan" CHECK ("originalPrice" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "OrderItem_qty_not_nan" CHECK ("qty" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "OrderItem_subtotal_not_nan" CHECK ("subtotal" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "OrderItem_taxRate_not_nan" CHECK ("taxRate" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "OrderItem_unitPrice_not_nan" CHECK ("unitPrice" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "OrderItemComponent"
  ADD CONSTRAINT "OrderItemComponent_displayUnitPrice4_not_nan" CHECK ("displayUnitPrice4" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_amount_not_nan" CHECK ("amount" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "PlanDefinition"
  ADD CONSTRAINT "PlanDefinition_annualPrice_not_nan" CHECK ("annualPrice" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "PlanDefinition_monthlyPrice_not_nan" CHECK ("monthlyPrice" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "Product"
  ADD CONSTRAINT "Product_averageCost_not_nan" CHECK ("averageCost" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Product_currentStock_not_nan" CHECK ("currentStock" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Product_msrp_not_nan" CHECK ("msrp" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Product_pricePerUnit_not_nan" CHECK ("pricePerUnit" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Product_priceTier2_not_nan" CHECK ("priceTier2" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Product_priceTier3_not_nan" CHECK ("priceTier3" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Product_priceTier4_not_nan" CHECK ("priceTier4" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Product_priceTier5_not_nan" CHECK ("priceTier5" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Product_standardCost_not_nan" CHECK ("standardCost" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "ProductUnit"
  ADD CONSTRAINT "ProductUnit_price_not_nan" CHECK ("price" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "ProductUnit_priceTier2_not_nan" CHECK ("priceTier2" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "ProductUnit_priceTier3_not_nan" CHECK ("priceTier3" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "ProductUnit_priceTier4_not_nan" CHECK ("priceTier4" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "ProductUnit_priceTier5_not_nan" CHECK ("priceTier5" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "Promotion"
  ADD CONSTRAINT "Promotion_value_not_nan" CHECK ("value" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "PurchaseOrder"
  ADD CONSTRAINT "PurchaseOrder_totalAmount_not_nan" CHECK ("totalAmount" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "PurchaseOrderItem"
  ADD CONSTRAINT "PurchaseOrderItem_qtyOrdered_not_nan" CHECK ("qtyOrdered" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "PurchaseOrderItem_qtyReceived_not_nan" CHECK ("qtyReceived" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "PurchaseOrderItem_totalCost_not_nan" CHECK ("totalCost" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "PurchaseOrderItem_unitCost_not_nan" CHECK ("unitCost" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "RecurringInvoice"
  ADD CONSTRAINT "RecurringInvoice_discount_not_nan" CHECK ("discount" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "RecurringInvoice_shippingFee_not_nan" CHECK ("shippingFee" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "RecurringInvoiceItem"
  ADD CONSTRAINT "RecurringInvoiceItem_discount_not_nan" CHECK ("discount" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "RecurringInvoiceItem_qty_not_nan" CHECK ("qty" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "RecurringInvoiceItem_taxRate_not_nan" CHECK ("taxRate" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "RecurringInvoiceItem_unitPrice_not_nan" CHECK ("unitPrice" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "RegulatedFiling"
  ADD CONSTRAINT "RegulatedFiling_totalCategoryTax_not_nan" CHECK ("totalCategoryTax" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "RegulatedFiling_totalNetSales_not_nan" CHECK ("totalNetSales" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "RegulatedFiling_totalQty_not_nan" CHECK ("totalQty" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "RegulatedFiling_totalUnitBasisQty_not_nan" CHECK ("totalUnitBasisQty" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "RegulatedLedgerParkedReversal"
  ADD CONSTRAINT "RegulatedLedgerParkedReversal_returnedPieces_not_nan" CHECK ("returnedPieces" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "RegulatedSalesLedger"
  ADD CONSTRAINT "RegulatedSalesLedger_categoryTax_not_nan" CHECK ("categoryTax" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "RegulatedSalesLedger_netSales_not_nan" CHECK ("netSales" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "RegulatedSalesLedger_qty_not_nan" CHECK ("qty" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "RegulatedSalesLedger_unitBasisQty_not_nan" CHECK ("unitBasisQty" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "Return"
  ADD CONSTRAINT "Return_creditCategoryTax_not_nan" CHECK ("creditCategoryTax" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Return_creditSubtotal_not_nan" CHECK ("creditSubtotal" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Return_creditTax_not_nan" CHECK ("creditTax" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Return_heldAmount_not_nan" CHECK ("heldAmount" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Return_refundAmount_not_nan" CHECK ("refundAmount" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "ReturnItem"
  ADD CONSTRAINT "ReturnItem_categoryTax_not_nan" CHECK ("categoryTax" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "ReturnItem_originalPrice_not_nan" CHECK ("originalPrice" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "ReturnItem_qty_not_nan" CHECK ("qty" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "ReturnItem_subtotal_not_nan" CHECK ("subtotal" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "ReturnItem_taxAmount_not_nan" CHECK ("taxAmount" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "ReturnItem_unitPrice_not_nan" CHECK ("unitPrice" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "ReturnParkedRestock"
  ADD CONSTRAINT "ReturnParkedRestock_returnedQty_not_nan" CHECK ("returnedQty" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "RfInvoice"
  ADD CONSTRAINT "RfInvoice_amount_not_nan" CHECK ("amount" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "RouteRun"
  ADD CONSTRAINT "RouteRun_settlementVariance_not_nan" CHECK ("settlementVariance" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "SalesAgentRate"
  ADD CONSTRAINT "SalesAgentRate_ratePct_not_nan" CHECK ("ratePct" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "StockCountLine"
  ADD CONSTRAINT "StockCountLine_countedQty_not_nan" CHECK ("countedQty" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "StockCountLine_expectedQty_not_nan" CHECK ("expectedQty" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "StockCountLine_unitCostOverride_not_nan" CHECK ("unitCostOverride" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "StockLot"
  ADD CONSTRAINT "StockLot_qty_not_nan" CHECK ("qty" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "StockLot_remainingQty_not_nan" CHECK ("remainingQty" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "StockLot_unitCost_not_nan" CHECK ("unitCost" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "StockMovement"
  ADD CONSTRAINT "StockMovement_avgCostAfter_not_nan" CHECK ("avgCostAfter" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "StockMovement_quantity_not_nan" CHECK ("quantity" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "StockMovement_stockAfter_not_nan" CHECK ("stockAfter" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "StockMovement_unitCost_not_nan" CHECK ("unitCost" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "SupplierCredit"
  ADD CONSTRAINT "SupplierCredit_amount_not_nan" CHECK ("amount" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "SupplierCredit_balance_not_nan" CHECK ("balance" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "SupplierProduct"
  ADD CONSTRAINT "SupplierProduct_lastUnitCost_not_nan" CHECK ("lastUnitCost" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "SupplierStatementScan"
  ADD CONSTRAINT "SupplierStatementScan_closingBalance_not_nan" CHECK ("closingBalance" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "SupplierStatementScan_openingBalance_not_nan" CHECK ("openingBalance" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "TenantAddon"
  ADD CONSTRAINT "TenantAddon_priceSnapshot_not_nan" CHECK ("priceSnapshot" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "TenantConfig"
  ADD CONSTRAINT "TenantConfig_taxRate_not_nan" CHECK ("taxRate" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "TenantSubscription"
  ADD CONSTRAINT "TenantSubscription_basePriceSnapshot_not_nan" CHECK ("basePriceSnapshot" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "TenantSubscription_discount_not_nan" CHECK ("discount" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "TenantSubscription_priceOverrideAnnual_not_nan" CHECK ("priceOverrideAnnual" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "TenantSubscription_priceOverrideMonthly_not_nan" CHECK ("priceOverrideMonthly" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "TobaccoReport"
  ADD CONSTRAINT "TobaccoReport_endingStockQty_not_nan" CHECK ("endingStockQty" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "TobaccoReport_endingStockValue_not_nan" CHECK ("endingStockValue" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "TobaccoReport_totalPurchaseValue_not_nan" CHECK ("totalPurchaseValue" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "TobaccoReport_totalQtyPurchased_not_nan" CHECK ("totalQtyPurchased" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "TobaccoReport_totalQtySold_not_nan" CHECK ("totalQtySold" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "TobaccoReport_totalSalesValue_not_nan" CHECK ("totalSalesValue" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "TobaccoReport_totalTaxCollected_not_nan" CHECK ("totalTaxCollected" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "TrackedCategory"
  ADD CONSTRAINT "TrackedCategory_rate_not_nan" CHECK ("rate" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "Transaction"
  ADD CONSTRAINT "Transaction_totalOwed_not_nan" CHECK ("totalOwed" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "Transaction_totalPaid_not_nan" CHECK ("totalPaid" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "TransactionItem"
  ADD CONSTRAINT "TransactionItem_qty_not_nan" CHECK ("qty" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "TransactionItem_subtotal_not_nan" CHECK ("subtotal" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "TransactionItem_unitPrice_not_nan" CHECK ("unitPrice" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "VendorBill"
  ADD CONSTRAINT "VendorBill_subtotal_not_nan" CHECK ("subtotal" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "VendorBill_taxAmount_not_nan" CHECK ("taxAmount" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "VendorBill_totalOwed_not_nan" CHECK ("totalOwed" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "VendorBill_totalPaid_not_nan" CHECK ("totalPaid" <> 'NaN'::numeric) NOT VALID;

ALTER TABLE "VendorBillItem"
  ADD CONSTRAINT "VendorBillItem_lineTotal_not_nan" CHECK ("lineTotal" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "VendorBillItem_qty_not_nan" CHECK ("qty" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "VendorBillItem_qtyReceived_not_nan" CHECK ("qtyReceived" <> 'NaN'::numeric) NOT VALID,
  ADD CONSTRAINT "VendorBillItem_unitCost_not_nan" CHECK ("unitCost" <> 'NaN'::numeric) NOT VALID;

COMMIT;
