# api — misc (reference — enums)

> Split from `.claude/code-map/api.md` (verbatim, lines 2177-2193) on 2026-09-13. See [`../INDEX.md`](../INDEX.md).

## Reference — enums (directional; verify in `prisma/schema/*.prisma` / `packages/types`)

UserRole(SUPER_ADMIN, TENANT_ADMIN, OPERATOR, DRIVER, CUSTOMER) · TenantStatus(TRIAL, ACTIVE,
SUSPENDED, CANCELLED) · OrderStatus(DRAFT, PENDING, CONFIRMED, OUT_FOR_DELIVERY,
PARTIALLY_DELIVERED, DELIVERED, CANCELLED) · RouteRunStatus(SCHEDULED, IN_PROGRESS, COMPLETED,
CANCELLED) · InvoiceStatus(DRAFT, SENT, VIEWED, PARTIAL, PAID, OVERDUE, VOID) ·
EstimateStatus(DRAFT, SENT, ACCEPTED, DECLINED, CONVERTED) · ReturnStatus(PENDING, APPROVED,
REJECTED, IN_TRANSIT, RECEIVED, REFUNDED, PROCESSED, CANCELLED) · VendorBillStatus(DRAFT,
RECEIVED, PARTIAL, PAID, OVERDUE, VOID) · PaymentMethod(CASH, CHECK, ACH, OTHER, CREDIT_NOTE,
ADVANCE, CREDIT_CARD, **ZELLE** — added 2026-08-21, migration
`20260830000000_payment_method_zelle`; enum-only, no backfill. DTOs validate with
`@IsEnum(PaymentMethod)` from `@prisma/client` so new values need NO API change; the client
lists live in `apps/{web,mobile}/lib/payment-methods.ts`. `import.service.ts`
`mapPaymentMethod` maps a source `"zelle"` to ZELLE — it used to fold it into ACH) ·
MovementType(PURCHASE, SALE, ADJUSTMENT, RETURN, WRITE_OFF) ·
CreditNoteStatus(ISSUED, APPLIED, VOID).

