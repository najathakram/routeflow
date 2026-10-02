# W13 — Controller & Endpoint Coverage Audit

**Audited:** 2026-04-29
**Scope:** All NestJS controllers — missing guards, double-receive/void gaps, messaging ownership, RBAC coverage
**Status:** Read-only audit — no files modified

---

## Summary

Four findings identified: one P0 (uploads endpoint has no auth guard — all files publicly accessible), two P1s (vendor bill receive idempotency and void stock-reversal), and one P2 (messages controller no ownership check).

---

## Findings

### W13-013 — GET /uploads/\* has no authentication guard — all uploaded files are public (P0)

- **Severity:** P0
- **File:** `apps/api/src/uploads/uploads.controller.ts:16`
- **Issue:** `UploadsController` has no `@UseGuards(JwtAuthGuard)` decorator at the class or method level. Any unauthenticated HTTP client can fetch any file by its storage key path (e.g. `GET /uploads/products/some-uuid.jpg`, `GET /uploads/tenants/logo.svg`, `GET /uploads/customers/id/tax-documents/cert.pdf`). This is the local-storage fallback path (when R2 is not configured), which is the path used in development and likely in early Railway deploys.
- **Evidence:** `uploads.controller.ts:1-68` — `@Controller("uploads")` with no guards. `GET *path` handler at line 25 with no auth.
- **Repro:**
  1. Upload a product image as operator.
  2. Copy the returned `key` (e.g. `products/abc-123/uuid.jpg`).
  3. In a new incognito window (not logged in): `GET /api/v1/uploads/products/abc-123/uuid.jpg`
  4. Image is served without authentication.
- **Also:** Files are served with `Content-Type` derived from extension (line 63-64) with no `Content-Disposition: attachment` header. SVG files would be served inline with `Content-Type: image/svg+xml`, enabling XSS if an SVG with scripts was uploaded.
- **Impact:** All tenant PII documents, product images, customer tax certificates, driver photos, and signatures are publicly accessible to anyone who knows or guesses the key. Key format (`tenants/{id}/logo.svg`) is guessable.
- **Fix:** Add `@UseGuards(JwtAuthGuard)` to the controller. For cross-tenant safety, verify that the key prefix matches the requesting user's tenantId. Add `Content-Disposition: attachment` for non-image types; for images, ensure SVGs are rejected or sanitized.

---

### W13-001 — vendor-bills.service.ts receive() has no idempotency guard — double-receive doubles stock (P1)

- **Severity:** P1
- **File:** `apps/api/src/vendor-bills/vendor-bills.service.ts:141-283`
- **Issue:** `receive(id)` checks the bill exists but does NOT verify that `bill.status !== 'RECEIVED'` before proceeding. If called twice (e.g., double-click, network retry), the second call re-runs the entire inventory increment loop on the same items — doubling the stock increment for each product line.
- **Evidence:** `vendor-bills.service.ts:141-149` — only check is `if (!bill) throw NotFoundException`. No `if (bill.status === 'RECEIVED') throw ConflictException`.
- **Repro:**
  1. Create a vendor bill with 5 units of Product A (stock starts at 10).
  2. Call `POST /vendor-bills/:id/receive` twice in rapid succession.
  3. Product A stock = 10 + 5 + 5 = 20. Expected: 15.
- **Impact:** Stock levels become incorrect; financial cost calculations (weighted average) are corrupted.
- **Fix:** Add `if (bill.status === 'RECEIVED') throw new ConflictException('Bill already received')` at the start of `receive()`.

---

### W13-002 — voidBill() does not reverse stock movements from receive() (P1)

- **Severity:** P1
- **File:** `apps/api/src/vendor-bills/vendor-bills.service.ts:286-290`
- **Issue:** `voidBill()` is a single-line Prisma update that sets `status = VOID` with no stock reversal. When a received vendor bill is voided, the stock increments from `receive()` are never reversed. Inventory remains inflated even though the bill was voided.
- **Evidence:** `vendor-bills.service.ts:286-290` — `vendorBill.update({ data: { status: "VOID" } })` only.
- **Repro:**
  1. Receive vendor bill (stock +10 units).
  2. Void the bill.
  3. Check product stock — still shows +10 units above baseline.
- **Impact:** Phantom inventory that can be oversold. Financial cost records wrong.
- **Fix:** `voidBill()` must check `bill.status === 'RECEIVED'`; if so, create reverse `StockMovement` entries for each item before setting `VOID`.

---

### W13-008 — messages.controller.ts has JwtAuthGuard only — no ownership check on message reads (P2)

- **Severity:** P2
- **File:** `apps/api/src/messages/messages.controller.ts`
- **Issue:** The messages endpoint allows any authenticated user to read any message thread by ID, regardless of whether they are a participant. There is no `RolesGuard` to limit to OPERATOR, and no check that the requesting user's tenantId or userId matches the thread participants.
- **Evidence:** Controller has `@UseGuards(JwtAuthGuard)` only; service `findOne()` queries by id without participant check.
- **Impact:** Any authenticated user (including drivers, customers, buyers) can read message threads they weren't part of.
- **Fix:** Add participant ownership check: `WHERE id = :id AND (senderId = :userId OR recipientId = :userId OR tenantId = :tenantId)`.

---

### W13-009 — messages.controller.ts allows any user to post messages to any thread (P2)

- **Severity:** P2
- **File:** `apps/api/src/messages/messages.controller.ts`
- **Issue:** `POST /messages` and `POST /messages/:id/reply` accept messages from any authenticated user without verifying thread membership. A customer or driver could inject messages into an operator-only communication thread.
- **Fix:** Same ownership check as W13-008 on write paths.

---

## Summary Table

| ID      | Severity | Title                                                                          |
| ------- | -------- | ------------------------------------------------------------------------------ |
| W13-013 | P0       | GET /uploads/\* — no auth guard, all files publicly accessible                 |
| W13-001 | P1       | vendor-bills receive() has no idempotency guard — double-receive doubles stock |
| W13-002 | P1       | voidBill() does not reverse stock movements                                    |
| W13-008 | P2       | messages.controller.ts — no ownership check on message reads                   |
| W13-009 | P2       | messages.controller.ts — any user can post to any thread                       |
