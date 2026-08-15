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
-- All tables use the "tenantId" column — Prisma does NOT snake_case column names
-- unless a field carries @map, and none of these do.

DO $rls$
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
      -- NOTE: the inner dollar-quote tag MUST differ from the outer DO block's.
      -- A bare $$ here closes the DO body early and leaks CREATE POLICY into the
      -- top level as bare SQL ("syntax error at or near CREATE").
      EXECUTE format($pol$
        CREATE POLICY tenant_isolation ON "%s"
          USING (
            "tenantId"::text = current_setting('app.current_tenant_id', true)
            OR coalesce(current_setting('app.current_tenant_id', true), '') = ''
          )
      $pol$, t);

      RAISE NOTICE 'RLS enabled on %', t;
    EXCEPTION
      WHEN undefined_table THEN
        RAISE NOTICE 'Table % not found — skipping', t;
      WHEN OTHERS THEN
        RAISE NOTICE 'Error on % : %', t, SQLERRM;
    END;
  END LOOP;
END
$rls$;

-- Verify. pg_tables exposes only `rowsecurity`; whether FORCE is on lives in
-- pg_class.relforcerowsecurity, so read both from pg_class directly.
SELECT c.relname            AS tablename,
       c.relrowsecurity     AS rowsecurity,
       c.relforcerowsecurity AS forcerowsecurity
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relrowsecurity
ORDER BY c.relname;
