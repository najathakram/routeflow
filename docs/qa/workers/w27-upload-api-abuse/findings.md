# W27 — Upload Fuzzing & API Abuse Findings

**Worker:** W27
**Date:** 2026-04-30
**Environment:** `https://routeflowapi-production.up.railway.app/api/v1` | Tenant: `ux-audit-1777265477001`
**Operator:** `ux_admin / UxAdmin@123!`

---

## Upload Endpoints Discovered

| Endpoint | Method | Field |
|---|---|---|
| `POST /bookkeeping/expenses/:id/receipt` | multipart | `file` |
| `POST /products/:id/images` | multipart | `files` (multi) |
| `POST /customers/:id/tax-documents` | multipart | `files` (multi) |
| `POST /customers/:id/documents` | multipart | `files` (multi) |
| `POST /tenants/logo` | multipart | `file` |

Note: `/expenses`, `/vendor-bills`, `/returns` as top-level paths return 404. No upload routes exist for vendor-bills or returns.

---

## Phase 8 — Upload Fuzzing

### F19 — SVG with XSS Script

#### Expense receipt endpoint
- Input: `receipt.svg`, Content-Type: `image/svg+xml`
- Response: `500 Internal Server Error` — `{"statusCode":500,"message":"Internal server error"}`
- Cause: `sharp` cannot process SVG, throws unhandled exception
- SVG stored? NO
- Verdict: Not an XSS vector here but unhandled 500 (see BUG-4)

#### Product images endpoint — CRITICAL
- Input: `receipt.svg`, Content-Type: `image/svg+xml`, body contains `<script>window._xss_w27=1</script>`
- Response: `201 Created`
- Stored URL: `https://routeflowapi-production.up.railway.app/api/v1/uploads/products/f31568b9.../3be5065f....svg`
- Served Content-Type: `image/svg+xml`
- Script present in served body: YES
- XSS exploitable: YES — browsers execute JS from image/svg+xml URLs inline

#### Customer tax-documents endpoint — CRITICAL
- Input: `tax-exempt.svg`, Content-Type: `image/svg+xml`
- Response: `201 Created`
- Stored URL: `.../api/v1/uploads/customers/.../.../cc8cc28d....svg`
- Served Content-Type: `image/svg+xml`
- Script present in served body: YES
- XSS exploitable: YES

**BUG-1 (P0): Stored XSS via SVG upload on product images and customer tax-documents**
`POST /products/:id/images` and `POST /customers/:id/tax-documents` accept SVG files with embedded `<script>` tags and serve them back with `Content-Type: image/svg+xml`. Any authenticated user can inject and execute arbitrary JavaScript in other users browsers by sharing the stored URL. Product images are especially dangerous since they render across operator and buyer UIs.

---

### F17 — Corrupt/Truncated File
- Input: 50 random bytes as `corrupt.pdf`, Content-Type: `application/pdf`
- Response: `201 Created` — stored, URL returned
- Served Content-Type: `application/pdf`
- Verdict: No magic-byte validation. Corrupt data silently stored.

**BUG-2 (P2): No file content validation for PDF uploads — corrupt bytes silently stored**

---

### F20 — Oversized File (>10MB)
- Input: 12MB payload as `big.pdf`, Content-Type: `application/pdf`
- Response: `413 Payload Too Large` — `{"message":"File too large","error":"Payload Too Large","statusCode":413}`
- No stack trace or server paths leaked
- Verdict: PASS. Also confirmed on product images endpoint.

---

### F18 — MIME Mislabeling

#### F18a: JPEG bytes as application/pdf
- Input: JPEG magic bytes, Content-Type: `application/pdf`, filename `invoice.pdf`
- Response: `201 Created` — stored as receipt.pdf
- Served Content-Type: `application/pdf`
- Verdict: Server trusts Content-Type header; no content sniffing performed

**BUG-3 (P3): MIME type not validated against actual file content**

#### F18b: PDF bytes as image/jpeg
- Input: PDF bytes, Content-Type: `image/jpeg`, filename `receipt.jpg`
- Response: `500 Internal Server Error`
- Cause: `sharp` fails on PDF bytes; unhandled exception

**BUG-4 (P2): Unhandled 500 when non-image bytes uploaded with image/* MIME type**
Applies to SVG-as-image (F19 expense), PDF-as-jpeg (F18b). `sharp` throws and server returns 500. Should catch and return 400.

---

### F_html — HTML File as PDF
- Input: `<html><script>alert(1)</script></html>` as `receipt.pdf`, Content-Type: `application/pdf`
- Response: `201 Created`
- Served Content-Type: `application/pdf`
- Body: raw HTML content
- XSS? NO — browser sees application/pdf, will not render as HTML
- Verdict: Silently accepted with no validation, but not an XSS vector due to correct Content-Type on retrieval

---

### F16 — Zero-byte File
- Input: 0 bytes as `empty.pdf`, Content-Type: `application/pdf`
- Response: `201 Created` — 0-byte file stored
- Served body: empty (0 bytes, 200 OK)
- Also confirmed on product images endpoint (zero-byte JPEG accepted)

**BUG-5 (P2): Zero-byte files silently accepted on all upload endpoints**

---

### Browser Upload Tests
The mobile web app expense detail (`/expenses/:id`) and product detail (`/products/:id`) pages have no visible file upload UI elements in the current build. Uploads are API-only. No `<input type="file">` found on these pages.

Long filename (499 chars) via API: `POST /products/:id/images` returned 201. Server uses UUID keys so original filename is discarded — no filesystem issues.

Console: No upload-related errors observed during browsing.

---

## Phase 9.N — API Abuse

### Malformed JSON

| Test | Status | Body | Verdict |
|------|--------|------|---------|
| POST /orders with `{this is not json` | 400 | `Expected property name or '}'...` | PASS |
| POST /customers with `null` | 400 | `Unexpected token 'n'...` | PASS |

No stack traces. Clean error messages.

---

### Missing Required Fields

| Test | Status | Body | Verdict |
|------|--------|------|---------|
| POST /orders `{}` | 400 | `customerId is required` | PASS |
| POST /customers `{email only}` | 400 | Array of field errors | PASS |

No DB schema leaked.

---

### Oversized String Fields
- Input: POST /customers with `businessName` of 10,001 chars
- Response: `201 Created` — customer stored with 10,001-char businessName
- Customer ID: `9e7d17d3-b5b4-4d76-ae9f-b691c469ca3b`

**BUG-6 (P2): No max-length validation on CreateCustomerDto string fields**
businessName, contactName, notes accept arbitrary-length strings. 10,001-char name was stored.

---

### Negative/Invalid Numerics

| Test | Input | Status | Verdict |
|------|-------|--------|---------|
| PATCH /products pricePerUnit: -999 (number) | `{"pricePerUnit":-999}` | 400 | PASS |
| PATCH /products pricePerUnit: 9999999999.99 | `{"pricePerUnit":9999999999.99}` | 400 | PASS |
| PATCH /products pricePerUnit: "-1.00" (string) | `{"pricePerUnit":"-1.00"}` | 200 | FAIL — negative stored |
| PATCH /products pricePerUnit: "0.00" (string) | `{"pricePerUnit":"0.00"}` | 200 | Zero price stored |
| POST /orders qty: -5 | items qty -5 | 400 | PASS |
| POST /orders qty: 0 | items qty 0 | 400 | PASS |
| POST /orders qty: 999999 | items qty 999999 | 201 | FAIL — $25.6M order |

**BUG-7 (P1): Negative product price accepted as string decimal**
`{"pricePerUnit":"-1.00"}` (string) sets price to -$1. @IsDecimalString() does not enforce minimum. Cascades to negative order totals and invoices.

**BUG-8 (P2): No maximum order quantity cap**
qty 999,999 accepted, creating order worth $25,664,510.89 (Order ID: `6af05a85-7fb3-479b-ae6f-53fc6bff2a0e`).

---

### SQL/NoSQL Injection in Query Params

| Test | Status | Verdict |
|------|--------|---------|
| GET /orders?status=PENDING' OR '1'='1 | 400 | PASS — enum validation |
| GET /customers?search='; DROP TABLE "Order"; -- | 200 empty | PASS — Prisma parameterized |
| GET /products?search=`<script>alert(1)</script>` | 200 empty | PASS — not reflected |
| GET /orders?id=1 UNION SELECT * FROM users-- | 400 | PASS — whitelist param blocking |

All injection attempts safely handled.

---

### UUID Confusion

| Test | Status | Verdict |
|------|--------|---------|
| GET /orders/not-a-uuid | 404 | Acceptable (not 500) |
| GET /orders/00000000-0000-0000-0000-000000000000 | 404 | PASS |
| GET /orders/1 | 404 | PASS |

No 500s on UUID confusion.

---

### HTTP Method Confusion

| Test | Status | Verdict |
|------|--------|---------|
| POST /orders/:validId (wrong method) | 404 | Returns 404 instead of 405 — minor |
| DELETE /customers/:validId | 200 | Customer permanently deleted |

**BUG-9 (P1): DELETE /customers/:id permanently destroys record with no confirmation or soft-delete**
Single authenticated DELETE call permanently removes customer. Confirmed: customer `dff6f7ac-2381-4322-80d8-43ba89e996a9` deleted. No confirm parameter, no soft-delete, no audit log. CSRF or UI bug could silently destroy production data.

---

### Idempotency
- POST /orders twice with identical payload within 1 second
- Both calls return: `201`, same `id=c332b0c3`, same `orderNumber=ORD-1777431385841`
- Verdict: Orders are idempotent — positive behavior preventing accidental double-orders.

---

### Rate Limit Check

35 rapid GET /products: All 200. No 429. No rate limiting on data endpoints.

15 rapid POST /auth/login (wrong password): All 401. No 429. No lockout.

**BUG-10 (P1): No rate limiting on POST /auth/login — brute-force unrestricted**

**BUG-11 (P2): No rate limiting on authenticated API endpoints**

---

## Bug Summary

| # | Severity | Description |
|---|----------|-------------|
| BUG-1 | P0 | Stored XSS: product images and customer tax-documents accept and serve SVG with embedded scripts |
| BUG-2 | P2 | No content validation for PDF uploads — corrupt bytes silently stored |
| BUG-3 | P3 | MIME type trusted from Content-Type header; no actual content sniffing |
| BUG-4 | P2 | Unhandled 500 when non-image bytes uploaded with image/* MIME type (sharp crash) |
| BUG-5 | P2 | Zero-byte files silently accepted on all upload endpoints |
| BUG-6 | P2 | No max-length validation on string fields — 10,001-char businessName stored |
| BUG-7 | P1 | Negative product price accepted as string decimal ("-1.00") |
| BUG-8 | P2 | No max order quantity cap — qty 999,999 accepted, $25.6M order created |
| BUG-9 | P1 | DELETE /customers/:id permanently destroys record with no confirmation or soft-delete |
| BUG-10 | P1 | No rate limiting on POST /auth/login — brute-force unrestricted |
| BUG-11 | P2 | No rate limiting on authenticated API endpoints |

---

## Test Data Created

Tenant: `ux-audit-1777265477001`

### Expenses (bookkeeping)
| ID | Description |
|----|-------------|
| `aa2521dd-bd5d-4d8e-a3f1-62b87aaf5b1c` | W27 upload test ($10, no receipt) |
| `082fcb73-1d41-493f-be56-8f0b0f6d5422` | W27-F17 corrupt (corrupt PDF stored) |
| `e577471e-f3c2-4f6b-a37f-64e6e8ca77f7` | W27-F18a jpeg-as-pdf (JPEG stored as PDF) |
| `ec437306-f322-4643-add2-c519478e46a1` | W27-Fhtml html-as-pdf (HTML stored as PDF) |
| `656a7586-3a59-47c8-aef1-3a860ccdd159` | W27-F16 zero-byte (0-byte file stored) |
| `eb552e69-9564-4416-b4f9-06574ce0ddef` | W27-F19c svg-octet (no receipt, 500 error) |
| Multiple other IDs | W27-F19/F19b/F20/F18b test expenses |

### Product Images (malicious SVG stored — needs cleanup)
| Product ID | Key | Content |
|------------|-----|---------|
| `f31568b9-99bd-4a86-ae76-85f2b7da7704` | `products/.../3be5065f....svg` | SVG XSS payload |
| `f31568b9-99bd-4a86-ae76-85f2b7da7704` | `products/.../c17e3ad9....svg` | SVG XSS payload |
| `f31568b9-99bd-4a86-ae76-85f2b7da7704` | `products/.../0a8efbbf....svg` | SVG XSS (long filename) |
| `f31568b9-99bd-4a86-ae76-85f2b7da7704` | `products/.../1bcd6be6....jpg` | Zero-byte JPEG |

### Customer Tax Documents (malicious SVG stored — needs cleanup)
| Customer ID | Key | Content |
|-------------|-----|---------|
| `e1f685de-9e84-4215-8c11-44a2a0304cae` | `customers/.../tax-documents/cc8cc28d....svg` | SVG XSS payload |

### Customers Created
| ID | Username | Notes |
|----|----------|-------|
| `9e7d17d3-b5b4-4d76-ae9f-b691c469ca3b` | `w27_test_long` | businessName 10,001 chars |
| `e1f685de-9e84-4215-8c11-44a2a0304cae` | `w27_test_long2` | businessName "Test" |
| `dff6f7ac-2381-4322-80d8-43ba89e996a9` | (deleted) | Permanently deleted via DELETE test |

### Orders Created
| ID | Notes |
|----|-------|
| `6af05a85-7fb3-479b-ae6f-53fc6bff2a0e` | qty 999,999 / total $25.6M (PENDING) |
| `c332b0c3-90d1-4219-a42c-428eb38c93f9` | Idempotency test order |
