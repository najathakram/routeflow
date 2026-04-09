# RouteFlow QA Plan — Role-Based Testing

**Production API:** `https://routeflowapi-production.up.railway.app/api/v1`
**Platform Admin UI:** `https://routeflowweb-production.up.railway.app/admin`
**Tenant UI:** `https://routeflowweb-production.up.railway.app` (with `X-Tenant-Slug: <slug>` header or subdomain)

---

## Setup Before Testing

Run the seed script to create a full dataset in a test tenant:
```bash
node apps/api/scripts/fresh-data.js
```
Or create a tenant manually via the Platform Admin UI and use the credentials below.

**Test tenant slug:** `demo` (or whatever slug you create)
**API header required for tenant calls:** `X-Tenant-Slug: demo`

---

## Role 1: SUPER_ADMIN

**Login endpoint:** `POST /api/v1/platform-admin/login`
**Credentials:** `najathakram / Najath123!`

### 1.1 Authentication
| # | Action | Expected |
|---|--------|----------|
| 1 | POST `/platform-admin/login` with correct credentials | 200 — returns JWT with `role: SUPER_ADMIN`, no `tenantId` |
| 2 | POST `/platform-admin/login` with wrong password | 401 |
| 3 | Call any `/api/v1/orders` endpoint with SUPER_ADMIN JWT (no tenant header) | 200 — returns data from ALL tenants (unscoped) |
| 4 | Call any tenant endpoint with SUPER_ADMIN JWT + `X-Tenant-Slug` header | 200 — scoped to that tenant |

### 1.2 Tenant Management
| # | Action | Expected |
|---|--------|----------|
| 5 | GET `/platform-admin/tenants` | 200 — list of all tenants |
| 6 | POST `/platform-admin/tenants` with `{ name, slug, plan, adminUsername, adminEmail, adminPassword }` | 201 — tenant created, TENANT_ADMIN user created |
| 7 | GET `/platform-admin/tenants/:id` | 200 — tenant details including subscription and config |
| 8 | PATCH `/platform-admin/tenants/:id/status` with `{ status: "SUSPENDED" }` | 200 — tenant suspended |
| 9 | Try any tenant API call with a valid JWT from that suspended tenant | 403 — "Tenant account is suspended" |
| 10 | PATCH `/platform-admin/tenants/:id/status` with `{ status: "ACTIVE" }` | 200 — tenant reactivated; calls succeed again |
| 11 | POST `/platform-admin/tenants/:id/extend-trial` | 200 — trial extended |

### 1.3 Impersonation
| # | Action | Expected |
|---|--------|----------|
| 12 | POST `/platform-admin/tenants/:id/impersonate` | 200 — returns short-lived JWT with `impersonatedBy: "najathakram"` |
| 13 | Use impersonation JWT for GET `/orders` | 200 — reads succeed, scoped to that tenant |
| 14 | Use impersonation JWT for POST `/orders` (any mutation) | 403 — "Impersonation tokens are read-only" |

### 1.4 Platform Stats & Audit
| # | Action | Expected |
|---|--------|----------|
| 15 | GET `/platform-admin/stats` | 200 — tenant counts, user counts, order counts |
| 16 | GET `/platform-admin/audit-logs` | 200 — list of audit events |
| 17 | GET `/platform-admin/tenants/:id/billing` | 200 — subscription info (empty if Stripe not configured) |

### 1.5 Tenant Isolation Check (Security)
| # | Action | Expected |
|---|--------|----------|
| 18 | Create 2 tenants (A and B). Create an order in tenant A. Use tenant B's JWT to GET `/orders` | 200 — empty list (tenant B cannot see tenant A's orders) |
| 19 | Use tenant B's JWT with tenant A's order ID: GET `/orders/:orderIdFromA` | 404 — not found |

---

## Role 2: OPERATOR (Tenant Admin / Operator)

**Login endpoint:** `POST /api/v1/auth/login`
**Credentials:** `admin / Admin@123` (from fresh-data seed)
**Header:** `X-Tenant-Slug: demo`

### 2.1 Authentication
| # | Action | Expected |
|---|--------|----------|
| 20 | POST `/auth/login` with correct credentials | 200 — JWT with `role: OPERATOR` and `tenantId` |
| 21 | POST `/auth/login` with wrong password | 401 |
| 22 | POST `/auth/refresh` with valid refresh token | 200 — new access token |
| 23 | Call any endpoint without JWT | 401 |

### 2.2 Customers
| # | Action | Expected |
|---|--------|----------|
| 24 | GET `/customers` | 200 — list of customers for this tenant |
| 25 | POST `/customers` with `{ businessName, contactName, email, phone }` | 201 — customer created |
| 26 | GET `/customers/:id` | 200 — customer details with addresses |
| 27 | PATCH `/customers/:id` | 200 — customer updated |
| 28 | POST `/customers/:id/addresses` | 201 — address added |
| 29 | DELETE `/customers/:id` | 200 or 204 — soft delete |

### 2.3 Products & Suppliers
| # | Action | Expected |
|---|--------|----------|
| 30 | GET `/products` | 200 — product list |
| 31 | POST `/products` with `{ name, sku, pricePerUnit, unit }` | 201 |
| 32 | PATCH `/products/:id` | 200 |
| 33 | GET `/suppliers` | 200 |
| 34 | POST `/suppliers` | 201 |

### 2.4 Orders
| # | Action | Expected |
|---|--------|----------|
| 35 | GET `/orders` | 200 — all tenant orders |
| 36 | POST `/orders` with `{ customerId, lineItems: [{ productId, qty }] }` | 201 — order with calculated totals |
| 37 | GET `/orders/:id` | 200 — order with lineItems |
| 38 | PATCH `/orders/:id/status` with `{ status: "CONFIRMED" }` | 200 |
| 39 | PATCH `/orders/:id/status` with `{ status: "DELIVERED" }` | 200 |
| 40 | Deliver an order — confirm auto-invoice is created | GET `/invoices` — invoice appears for that order |

### 2.5 Routes & Route Runs
| # | Action | Expected |
|---|--------|----------|
| 41 | GET `/routes` | 200 — all routes |
| 42 | POST `/routes` with stops | 201 |
| 43 | POST `/route-runs` for a route | 201 — run created with status SCHEDULED |
| 44 | GET `/route-runs` | 200 — all runs |
| 45 | PATCH `/route-runs/:id/status` with `{ status: "IN_PROGRESS" }` | 200 |

### 2.6 Invoices
| # | Action | Expected |
|---|--------|----------|
| 46 | GET `/invoices` | 200 — all invoices |
| 47 | POST `/invoices` (manual invoice) | 201 |
| 48 | PATCH `/invoices/:id/status` with `{ status: "SENT" }` | 200 |
| 49 | PATCH `/invoices/:id/status` with `{ status: "PAID" }` | 200 |
| 50 | POST `/invoices/:id/send-email` | 200 — email queued |

### 2.7 Credit Notes
| # | Action | Expected |
|---|--------|----------|
| 51 | POST `/credit-notes` with `{ invoiceId, amount, reason }` | 201 |
| 52 | GET `/credit-notes` | 200 |
| 53 | PATCH `/credit-notes/:id/status` with `{ status: "APPLIED" }` | 200 |

### 2.8 Returns
| # | Action | Expected |
|---|--------|----------|
| 54 | GET `/returns` | 200 — all returns |
| 55 | PATCH `/returns/:id/status` with `{ status: "APPROVED" }` | 200 |
| 56 | PATCH `/returns/:id/status` with `{ status: "REJECTED" }` | 200 |

### 2.9 Estimates
| # | Action | Expected |
|---|--------|----------|
| 57 | POST `/estimates` with items | 201 — estimate with auto-number |
| 58 | POST `/estimates/:id/send` | 200 — status → SENT |
| 59 | POST `/estimates/:id/accept` | 200 — status → ACCEPTED |
| 60 | POST `/estimates/:id/convert` | 201 — invoice created from estimate |

### 2.10 Recurring Invoices
| # | Action | Expected |
|---|--------|----------|
| 61 | POST `/recurring-invoices` with `{ customerId, frequency: "WEEKLY", items }` | 201 |
| 62 | POST `/recurring-invoices/:id/run-now` | 201 — invoice generated immediately |
| 63 | GET `/recurring-invoices` | 200 |

### 2.11 Standing Orders (Order Templates)
| # | Action | Expected |
|---|--------|----------|
| 64 | POST `/order-templates` with `{ customerId, daysOfWeek: [1,3,5], items }` | 201 |
| 65 | POST `/order-templates/:id/generate` | 201 — order created from template |
| 66 | GET `/order-templates` | 200 |

### 2.12 Settings
| # | Action | Expected |
|---|--------|----------|
| 67 | GET `/system-config/all` | 200 — all config keys for this tenant |
| 68 | PATCH `/system-config` with `{ key: "company.name", value: "Test Co" }` | 200 |
| 69 | GET `/analytics` | 200 — revenue, order counts, etc. |

---

## Role 3: DRIVER

**Login endpoint:** `POST /api/v1/auth/login`
**Credentials:** `driver_tom / Driver1!` (or `driver_sara / Driver1!`)
**Header:** `X-Tenant-Slug: demo`

### 3.1 Authentication
| # | Action | Expected |
|---|--------|----------|
| 70 | POST `/auth/login` with driver credentials | 200 — JWT with `role: DRIVER` |
| 71 | Try GET `/customers` (operator-only) | 403 |
| 72 | Try POST `/orders` | 403 |

### 3.2 Route Runs
| # | Action | Expected |
|---|--------|----------|
| 73 | GET `/route-runs/my-runs` | 200 — only runs assigned to this driver |
| 74 | GET `/route-runs/:id` for a run assigned to another driver | 403 or 404 |
| 75 | POST `/route-runs/:id/start` | 200 — status → IN_PROGRESS |
| 76 | GET `/route-runs/:id/stops` | 200 — stop list with customer info |

### 3.3 Stop Completion (Delivery Flow)
| # | Action | Expected |
|---|--------|----------|
| 77 | PATCH `/route-runs/:runId/stops/:stopId` with `{ status: "ARRIVED" }` | 200 |
| 78 | POST `/route-runs/:runId/stops/:stopId/complete` with `{ deliveredItems: [...], signature: "..." }` | 200 — stop marked COMPLETED, order status → DELIVERED |
| 79 | POST `/route-runs/:runId/stops/:stopId/complete` with partial delivery | 200 — partial qty recorded correctly |
| 80 | POST `/route-runs/:runId/stops/:stopId/complete` marking item as DAMAGED | 200 — damage recorded |
| 81 | After completing all stops: POST `/route-runs/:id/complete` | 200 — run status → COMPLETED |

### 3.4 Barcode Scanning
| # | Action | Expected |
|---|--------|----------|
| 82 | GET `/products/scan/:barcode` with valid barcode (`2000000000001`) | 200 — product details returned |
| 83 | GET `/products/scan/:barcode` with unknown barcode | 404 |

### 3.5 Driver Stats
| # | Action | Expected |
|---|--------|----------|
| 84 | GET `/route-runs/my-stats` | 200 — completed runs, stops, delivery rate for this driver |

### 3.6 Password Change
| # | Action | Expected |
|---|--------|----------|
| 85 | POST `/auth/change-password` with `{ currentPassword, newPassword }` | 200 |
| 86 | Login with old password after change | 401 |
| 87 | Login with new password | 200 |

---

## Role 4: CUSTOMER

**Login endpoint:** `POST /api/v1/auth/login`
**Credentials:** `harbor_cafe / Customer1!` (has a delivered order)
**Header:** `X-Tenant-Slug: demo`

### 4.1 Authentication
| # | Action | Expected |
|---|--------|----------|
| 88 | POST `/auth/login` with customer credentials | 200 — JWT with `role: CUSTOMER` |
| 89 | Try GET `/customers` (list all customers) | 403 |
| 90 | Try GET `/drivers` | 403 |
| 91 | Try GET `/routes` | 403 |

### 4.2 Orders
| # | Action | Expected |
|---|--------|----------|
| 92 | GET `/orders` | 200 — only THIS customer's orders (not other customers') |
| 93 | GET `/orders/:id` for own order | 200 |
| 94 | GET `/orders/:ownerId` for another customer's order | 404 |
| 95 | PATCH `/orders/:id/status` with `{ status: "CANCELLED" }` on own PENDING order | 200 |
| 96 | PATCH `/orders/:id/status` with `{ status: "CANCELLED" }` on own DELIVERED order | 400 — cannot cancel delivered |

### 4.3 Invoices
| # | Action | Expected |
|---|--------|----------|
| 97 | GET `/invoices` | 200 — only invoices for this customer |
| 98 | GET `/invoices/:id` for another customer's invoice | 404 |

### 4.4 Returns (requires a DELIVERED order)
| # | Action | Expected |
|---|--------|----------|
| 99 | POST `/returns` with `{ orderId: <delivered_order_id>, reason: "DAMAGED", items: [...] }` | 201 |
| 100 | POST `/returns` against another customer's order | 403 — "You can only submit returns for your own orders" |
| 101 | POST `/returns` against a PENDING (non-delivered) order | 400 — "Returns can only be submitted for delivered orders" |
| 102 | GET `/returns` | 200 — only own returns |

### 4.5 Standing Orders (Order Templates)
| # | Action | Expected |
|---|--------|----------|
| 103 | GET `/order-templates` | 200 — only templates for this customer |
| 104 | POST `/order-templates` (create own standing order) | 201 |
| 105 | PATCH `/order-templates/:idOfAnotherCustomer` | 403 |

### 4.6 Profile
| # | Action | Expected |
|---|--------|----------|
| 106 | PATCH `/customers/me` with `{ phone: "0400000000" }` | 200 — own profile updated |
| 107 | POST `/auth/change-password` | 200 |

### 4.7 Credit Notes
| # | Action | Expected |
|---|--------|----------|
| 108 | GET `/credit-notes` | 200 — only credit notes linked to this customer's invoices |

---

## Cross-Role & Security Tests

### Tenant Isolation
| # | Action | Expected |
|---|--------|----------|
| 109 | Login as `admin` for tenant A. Create a customer. Login as `admin` for tenant B (different `X-Tenant-Slug`). GET `/customers` | 200 — tenant B cannot see tenant A's customer |
| 110 | Use tenant A's JWT with `X-Tenant-Slug: tenant-b` header | 403 — tenant mismatch (JWT tenantId != resolved tenantId) |
| 111 | Call any tenant endpoint without `X-Tenant-Slug` header and without subdomain | 400 or 401 — no tenant context |

### SUSPENDED Tenant Guard
| # | Action | Expected |
|---|--------|----------|
| 112 | Obtain a valid JWT for a tenant. SUPER_ADMIN suspends that tenant. Use the old JWT (still within TTL) | 403 — "Tenant account is suspended" |
| 113 | SUPER_ADMIN re-activates the tenant | Subsequent calls with same JWT succeed again |

### Rate Limiting
| # | Action | Expected |
|---|--------|----------|
| 114 | Send 101 requests to any endpoint within 60 seconds from same IP | 429 on the 101st request |

---

## Test Execution Checklist

- [ ] SUPER_ADMIN login and tenant CRUD
- [ ] Create/suspend/reactivate tenant — confirm SUSPENDED guard fires
- [ ] Impersonation — confirm read-only enforcement
- [ ] Tenant isolation — two tenants cannot see each other's data
- [ ] OPERATOR full workflow: customer → order → route → delivery → invoice → paid
- [ ] DRIVER route run: start → arrive at stop → complete stop (with POD) → complete run
- [ ] CUSTOMER: view own data only, create return, cancel pending order, manage standing order
- [ ] Cross-customer data access blocked (customers cannot see each other's data)
- [ ] Rate limiting fires at 101 req/60s
