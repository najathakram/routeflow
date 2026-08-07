-- Backdated orders: an operator who forgot to enter an order on the day it
-- happened enters it later, and the order must carry the date it ACTUALLY
-- happened. `createdAt` cannot serve that purpose — it is the entry timestamp
-- and several analytics surfaces key on it — so the business date gets its own
-- nullable column.
--
-- When set, orderDate drives `deliveredAt` on the already-delivered sale path
-- and the issueDate/dueDate of every invoice generated from the order, which in
-- turn moves the regulated sales ledger's period bucket into that past month.
-- Staff-only at the service layer (OPERATOR / TENANT_ADMIN).
--
-- Additive: nullable column + one index, no data change. Existing rows stay NULL
-- and every read path falls back to createdAt, so behaviour is unchanged for them.
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "orderDate" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Order_orderDate_idx" ON "Order"("orderDate");
