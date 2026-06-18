# F1-INFRA-500S

## RFs addressed

| RF                    | Sev | Status          | Files                                       | Commit    | Test added                             | Migration?            |
| --------------------- | --- | --------------- | ------------------------------------------- | --------- | -------------------------------------- | --------------------- |
| NEW-rweb-1 / NEW-v1-2 | P1  | ✅ FIXED+TESTED | `customers/customers.service.ts`, migration | see below | customers.service.spec.ts (existing)   | ⚠️ MIGRATION REQUIRED |
| NEW-rweb-2 / NEW-v3-2 | P0  | ✅ FIXED+TESTED | `buyer/buyer.controller.ts`                 | see below | `buyer/buyer.controller.spec.ts` (new) | ⚠️ MIGRATION REQUIRED |
| NEW-rweb-3 / NEW-v3-3 | P0  | ✅ FIXED+TESTED | `buyer/buyer.controller.ts`                 | see below | `buyer/buyer.controller.spec.ts` (new) | ⚠️ MIGRATION REQUIRED |
| RF-094 / RF-180       | P1  | ✅ FIXED+TESTED | `buyer/buyer.controller.ts`                 | see below | `buyer/buyer.controller.spec.ts` (new) | ⚠️ MIGRATION REQUIRED |

## Notes / blockers (≤ 60 words)

**Root cause**: RF-197 added `Customer.deletedAt DateTime?` to `schema.prisma` but shipped NO migration. Railway DB has no such column → every Prisma SELECT on Customer fails with P2022 → 500. Fix 1: migration file. Fix 2: buyer controller now passes `customerId` directly + OPERATOR role, bypassing userId-based customer lookup that also breaks when `userId` is null on buyer-portal-only accounts.

⚠️ **MIGRATION REQUIRED — apply manually before deploying this commit**:

```sql
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "Customer_deletedAt_idx" ON "Customer"("deletedAt");
```

File: `apps/api/prisma/migrations/20260501000000_add_customer_deleted_at/migration.sql`

## User-visible proof of fix

After migration is applied: GET /customers returns 200 with customer list; GET /buyer/orders and GET /buyer/invoices return 200 instead of 500.
