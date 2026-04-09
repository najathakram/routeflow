-- =============================================================================
-- RouteFlow — PostgreSQL Row-Level Security (Phase 5.2)
-- Defense-in-depth Layer 3: RLS policies per tenant-scoped table.
--
-- How it works:
--   • tenantTransaction() sets: SELECT set_config('app.current_tenant_id', '<id>', true)
--     at the start of every transaction (true = local to this transaction).
--   • Each RLS policy allows rows WHERE tenant_id = current_setting(...).
--   • SUPER_ADMIN queries run unscoped (empty string bypasses = all rows).
--
-- Apply once on production DB:
--   psql $DATABASE_URL -f apps/api/prisma/rls.sql
-- =============================================================================

-- Helper: enable RLS + create policy on a given table
-- All tables use "tenant_id" column (Prisma maps camelCase → snake_case).

DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'User', 'Customer', 'CustomerAddress', 'CustomerPrice', 'CustomerTag',
    'CustomerTagAssignment', 'CustomerComment', 'ContactPerson',
    'Driver', 'Product', 'Route', 'RouteStop', 'RouteCustomer', 'RouteRun',
    'RouteRunStop', 'DeliveryMutation', 'Order', 'OrderItem', 'OrderTemplate',
    'OrderTemplateItem', 'Transaction', 'TransactionItem', 'Payment',
    'Invoice', 'InvoiceItem', 'InvoicePayment', 'PaymentCounter',
    'CreditNote', 'Estimate', 'EstimateItem', 'RecurringInvoice',
    'RecurringInvoiceItem', 'AdvancePayment', 'Return', 'ReturnItem',
    'Supplier', 'PurchaseOrder', 'PurchaseOrderItem', 'VendorBill',
    'VendorBillItem', 'BillPayment', 'Expense', 'ExpenseCategory',
    'ExpenseLineItem', 'MileageRate', 'StockMovement', 'StockLot',
    'Message', 'RefreshToken', 'DeviceToken', 'UserPreference', 'ProductMapping'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    BEGIN
      -- Enable RLS (idempotent)
      EXECUTE format('ALTER TABLE "%s" ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE "%s" FORCE ROW LEVEL SECURITY', t);

      -- Drop existing policy if re-running
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON "%s"', t);

      -- Policy: allow rows where tenant_id matches the session variable,
      -- OR the session variable is empty (SUPER_ADMIN / migration context).
      EXECUTE format($$
        -- Prisma uses camelCase column names (no snake_case mapping unless @map is used)
        CREATE POLICY tenant_isolation ON "%s"
          USING (
            "tenantId"::text = current_setting('app.current_tenant_id', true)
            OR coalesce(current_setting('app.current_tenant_id', true), '') = ''
          )
      $$, t);

      RAISE NOTICE 'RLS enabled on %', t;
    EXCEPTION
      WHEN undefined_table THEN
        RAISE NOTICE 'Table % not found — skipping', t;
      WHEN OTHERS THEN
        RAISE NOTICE 'Error on % : %', t, SQLERRM;
    END;
  END LOOP;
END
$$;

-- Verify
SELECT tablename, rowsecurity, forcerowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND rowsecurity = true
ORDER BY tablename;
