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
-- Applied by `prisma migrate deploy` — on prod via
--   railway run --service postgres node apps/api/scripts/prod-migrate.mjs
-- and only after scripts/rls-preflight.mjs reports zero NULL-"tenantId" rows
-- for every table listed below. This file is the sole authoritative copy of
-- that list (the pre-flight parses it from here); apps/api/prisma/rls.sql is
-- now a pointer stub and applying it does nothing.
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
    'RouteRunStop', 'DeliveryMutation', 'Order', 'OrderItem',
    'OrderIdempotencyKey', 'OrderTemplate', 'OrderTemplateItem',
    'Transaction', 'TransactionItem', 'Payment',
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

-- =============================================================================
-- Post-apply assertion — RAISES, does not just NOTICE.
--
-- The per-table loop above swallows every failure on a table (WHEN OTHERS =>
-- RAISE NOTICE, so a failed ALTER/CREATE POLICY never aborts the DO block or
-- the migration). That means `prisma migrate deploy` exiting 0 proves nothing
-- about whether RLS actually ended up enabled — the loop can silently skip
-- every table and the migration still "succeeds". This block re-checks
-- pg_class/pg_policies for the exact same table list and RAISES EXCEPTION
-- (aborting the migration with a non-zero exit) unless every table this file is
-- supposed to policy shows ALL THREE of:
--   • relrowsecurity      = true  (ENABLE ROW LEVEL SECURITY landed)
--   • relforcerowsecurity = true  (FORCE landed — without it the table owner,
--                                  which is the app role on Railway, bypasses
--                                  every policy and RLS is decorative)
--   • a pg_policies row named tenant_isolation (CREATE POLICY landed)
-- Checking relrowsecurity alone would pass the WORST failure mode: ENABLE+FORCE
-- succeed, then CREATE POLICY fails (insufficient privilege, or a duplicate-name
-- race) and is swallowed as a NOTICE. Forced RLS with zero policies denies every
-- row to every role including the app's — a silently deny-all table shipped by a
-- migration that exited 0. A table that does not exist at all in this database is
-- not counted as a failure here — that is a separate, pre-existing condition the
-- loop above already reports via `undefined_table` and is not something this
-- assertion can fix by raising.
-- =============================================================================
DO $rls_assert$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'User', 'Customer', 'CustomerAddress', 'CustomerPrice', 'CustomerTag',
    'CustomerTagAssignment', 'CustomerComment', 'ContactPerson',
    'Driver', 'Product', 'Route', 'RouteStop', 'RouteCustomer', 'RouteRun',
    'RouteRunStop', 'DeliveryMutation', 'Order', 'OrderItem',
    'OrderIdempotencyKey', 'OrderTemplate', 'OrderTemplateItem',
    'Transaction', 'TransactionItem', 'Payment',
    'Invoice', 'InvoiceItem', 'InvoicePayment', 'PaymentCounter',
    'CreditNote', 'Estimate', 'EstimateItem', 'RecurringInvoice',
    'RecurringInvoiceItem', 'AdvancePayment', 'Return', 'ReturnItem',
    'Supplier', 'PurchaseOrder', 'PurchaseOrderItem', 'VendorBill',
    'VendorBillItem', 'BillPayment', 'Expense', 'ExpenseCategory',
    'ExpenseLineItem', 'MileageRate', 'StockMovement', 'StockLot',
    'Message', 'RefreshToken', 'DeviceToken', 'UserPreference', 'ProductMapping'
  ];
  failed TEXT[] := ARRAY[]::TEXT[];
  reasons TEXT[];
  is_enabled BOOLEAN;
  is_forced BOOLEAN;
  has_policy BOOLEAN;
BEGIN
  FOREACH t IN ARRAY tables LOOP
    SELECT c.relrowsecurity, c.relforcerowsecurity
      INTO is_enabled, is_forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relname = t;

    -- is_enabled IS NULL means the table does not exist in this database —
    -- the policy loop above already reported that via undefined_table; it is
    -- not a policy failure this assertion should raise on.
    CONTINUE WHEN is_enabled IS NULL;

    SELECT EXISTS (
      SELECT 1
        FROM pg_policies p
       WHERE p.schemaname = 'public'
         AND p.tablename = t
         AND p.policyname = 'tenant_isolation'
    ) INTO has_policy;

    reasons := ARRAY[]::TEXT[];
    IF is_enabled IS NOT TRUE THEN
      reasons := array_append(reasons, 'RLS not enabled');
    END IF;
    IF is_forced IS NOT TRUE THEN
      reasons := array_append(reasons, 'FORCE not set');
    END IF;
    IF NOT has_policy THEN
      reasons := array_append(reasons, 'policy tenant_isolation missing');
    END IF;

    IF array_length(reasons, 1) > 0 THEN
      failed := array_append(failed, t || ' (' || array_to_string(reasons, ', ') || ')');
    END IF;
  END LOOP;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION
      'RLS assertion failed: %. A table listed with "policy tenant_isolation missing" while RLS is enabled+forced is DENY-ALL right now — no role, including the app''s, can read it. The loop above swallows per-table errors (WHEN OTHERS => RAISE NOTICE) — re-run this migration''s output through `railway logs --build` (or apply this migration file directly with psql) to see the underlying NOTICE for each of these tables before retrying.',
      array_to_string(failed, '; ');
  END IF;
END
$rls_assert$;
