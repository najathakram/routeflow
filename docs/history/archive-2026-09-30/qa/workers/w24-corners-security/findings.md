# W24 — Phase 9 Corner Scenarios & Phase 10 Security Code Audit

**Audited:** 2026-04-30
**Scope:** Phase 9 (money correctness, cascading deletes, standing order scheduling) + Phase 10 (CORS/CSP, rate limiting, buyer IDOR, audit log)
**Method:** Source code analysis
**Status:** Complete

---

## Summary

Six new bugs identified. Three PASS items confirmed. Three findings overlap with previously filed RFs (cross-references noted).

---

## Phase 9.A — Money Correctness

### 9.A.1 — Float arithmetic in invoice/order totals (P2)

- **Files:** `apps/api/src/invoices/invoices.service.ts:107–151, 569–603, 1519–1535`; `apps/api/src/orders/orders.service.ts:589–607`
- **Issue:** All totals calculated using native JS `number` (IEEE 754), not a decimal library. Pattern: `const lineSub = qty * item.unitPrice - (item.discount ?? 0)`. DB stores `Decimal(10,2)` but Prisma returns JS `number`. Classic $0.01 rounding errors accumulate on multi-line invoices. `applyPriceAdjustment` never rounds before persisting.
- **Fix:** Round each line subtotal and final total: `Math.round(value * 100) / 100`, or adopt `decimal.js`/`big.js`.

### 9.A.2 — Discount stacking allows $0 invoice with no confirmation (P2)

- **Files:** `apps/api/src/orders/orders.service.ts:565–607`; `apps/api/src/invoices/invoices.service.ts:107–161`
- **Issue:** Three discount layers (tier price, line-item flat discount, invoice-level flat discount) stack with no documentation. Guard `invDiscount <= subtotal` allows invoice discount = subtotal → total = $0 + shipping + tax. With zero shipping and zero tax, an operator can silently zero out an invoice via discounts with no confirmation step.
- **Fix:** Document discount-application order in JSDoc. Add a `confirmZeroTotal: true` flag before persisting a $0 invoice.

### 9.A.3 — Tax-inclusive/exclusive toggle — PASS (Feature gap, not a bug)

No `isTaxInclusive` field exists on `TenantConfig`. The feature does not exist.

### 9.A.4 — Credit note cap ignores existing payments (P2) — DUPLICATE of RF-010

- `credit-notes.service.ts:42–63` validates against `invoice.total`, not `invoice.total - payments`. Already filed as RF-010. Confirmed by W24.

### 9.A.5 — PDF uses stored totals (not recalculated) — PASS

PDF template reads `invoice.total` directly from DB. UI and PDF will always agree. ✓

---

## Phase 9.C — Cascading Deletes

### 9.C.1 — `bulkDeleteProducts()` has no guard for open invoice/order items (P1)

- **File:** `apps/api/src/products/products.service.ts:255–277`
- **Issue:** `remove()` (single delete) correctly checks for active order items and blocks. `bulkDelete()` has **no such guard** — it directly deletes `OrderItem` rows (including PENDING/CONFIRMED orders) and `InvoiceItem` rows (including SENT/PARTIAL invoices). `clearAll()` runs `TRUNCATE TABLE "Product" CASCADE` with zero checks.
- **Fix:** Add pre-checks in `bulkDelete()` mirroring the single-delete guard. Restrict `clearAll()` to dev/test only.

### 9.C.2 — Delete driver mid-run is blocked — PASS

`drivers.service.ts:220–244` counts SCHEDULED/IN_PROGRESS runs and throws `BadRequestException` if any exist. ✓

### 9.C.3 — Delete customer with outstanding balance is unconditional (P1) — confirms RF-074

`customers.service.ts:1220–1350` performs no outstanding-invoice check before the cascade-delete transaction. A customer with $10,000 in unpaid invoices can be deleted with no warning. Already filed as RF-074.

---

## Phase 9.D — Standing Order Scheduling

### 9.D.1 — No skip-one-occurrence API (P3)

- **File:** `apps/api/src/order-templates/order-templates.service.ts`
- **Issue:** No endpoint or `skipDates` field exists to skip a single standing order fire. Only deactivate-all or delete available.
- **Fix:** Add `skipDates DateTime[]` to `OrderTemplate`. Filter in cron: exclude dates in `skipDates`.

### 9.D.2 — Template edits take effect on next cron fire immediately (P2) — complements RF-117

- **File:** `apps/api/src/order-templates/order-templates.service.ts:265–322`
- **Issue:** `createOrderFromTemplate()` reads live template items at fire time. An edit at 11:55 PM alters the midnight cron order with no staging. This is undocumented. Note: already-generated pending orders use a snapshot (RF-117); future cron fires use the live template. Mixed behavior.
- **Fix:** Document explicitly or add `effectiveFrom` date to template edits.

### 9.D.3 — Delete template with existing orders → FK 500 (P2) — DUPLICATE of RF-118

`Order.orderTemplate` has no `onDelete` clause (defaults to Restrict). Already filed as RF-118. Confirmed by W24.

---

## Phase 10 — Security

### 10.6 — Login rate limit exists but weak; Redis fails open — confirms RF-021

- `auth.controller.ts:54` — `@Throttle({ default: { ttl: 60_000, limit: 30 } })` — 30/min.
- `redis-throttler.storage.ts:97–100` — fails open on Redis error.
- Recommendation: reduce to 5–10 attempts per 15 minutes; add service-layer account lockout independent of Redis. Already filed as RF-021.

### 10.8 — No CSP header; localhost CORS bypass active in production (P2)

- **File:** `apps/api/src/main.ts:82–116`
- **Issues:**
  1. `app.use(helmet())` with default options — no Content-Security-Policy set. Swagger UI at `/api/docs` exposed without CSP.
  2. CORS origin function contains `if (/^http:\/\/localhost:\d+$/.test(origin)) return callback(null, true)` in all environments including production. Any `http://localhost:N` origin bypasses CORS in production.
- **Note:** `Access-Control-Allow-Origin: *` is NOT used — allowlist pattern is correct overall.
- **Fix:** (1) Restrict localhost CORS bypass to `NODE_ENV !== 'production'`. (2) Add CSP to Swagger route.

### 10.1 — Buyer IDOR on orders/invoices/templates — PASS

All buyer endpoints check `resource.customerId !== ctx.customerId` and throw `ForbiddenException`. ✓

### Audit log — PASS with P3 gap

- `apps/api/src/audit/audit.service.ts` + `audit.interceptor.ts` — global `AuditInterceptor` logs every `POST/PUT/PATCH/DELETE` with `tenantId`, `userId`, `action`, `entityType`, `entityId`, `ip`. Login, invoice mutations, and customer deletes are all captured.
- **P3 gap:** No field-level change tracking. A role change (`DRIVER → TENANT_ADMIN`) logs only `PATCH /users/:id` with no before/after diff. Sensitive mutations should include payload diffs.

---

## Summary Table

| Finding | Severity | New/Duplicate      | Title                                                |
| ------- | -------- | ------------------ | ---------------------------------------------------- |
| 9.A.1   | P2       | **New**            | Float arithmetic in invoice/order totals             |
| 9.A.2   | P2       | **New**            | Discount stacking allows $0 invoice                  |
| 9.A.3   | —        | N/A                | Tax-inclusive toggle not implemented                 |
| 9.A.4   | P2       | Dup RF-010         | Credit note cap ignores existing payments            |
| 9.A.5   | —        | PASS               | PDF uses stored totals                               |
| 9.C.1   | P1       | **New**            | bulkDeleteProducts() destroys open invoice items     |
| 9.C.2   | —        | PASS               | Delete driver mid-run blocked                        |
| 9.C.3   | P1       | Dup RF-074         | Delete customer with balance unconditional           |
| 9.D.1   | P3       | **New**            | No skip-one-occurrence for standing orders           |
| 9.D.2   | P2       | Complements RF-117 | Template edits take effect on next cron immediately  |
| 9.D.3   | P2       | Dup RF-118         | Delete template → FK 500                             |
| 10.6    | P1/P2    | Dup RF-021         | Login rate limit weak + Redis fails open             |
| 10.8    | P2       | **New**            | localhost CORS bypass in production; no CSP          |
| 10.1    | —        | PASS               | Buyer IDOR checks correct                            |
| Audit   | P3       | **New**            | Audit log no field-level diff on sensitive mutations |

**Net new findings: RF-139 (P2), RF-140 (P2), RF-141 (P1), RF-142 (P2), RF-143 (P3), RF-144 (P3)**
