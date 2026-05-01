# W23 - E2E Revenue Cycle QA Findings

**Worker:** W23  
**Date:** 2026-04-30  
**Tenant:** ux-audit-1777265477001 (ID: 8ee7bbf5-991b-41b1-adcb-4a6c20981401, Name: "UX Audit Co")  
**API Base:** https://routeflowapi-production.up.railway.app/api/v1

---

## E2E-1 - Full Revenue Cycle

### Step 1: Buyer 1 Places Order - PASS (with note)
Order created: ORD-1777431385836, PENDING, $72.63, 2026-04-30T14:11:13Z  
3 products submitted, 4 items in order (standing template merge - see BUG-2)  
requestedDeliveryDate 2026-05-05 stored correctly

### Step 2: Operator Confirms Order - PASS
PATCH /orders/:id/status -> CONFIRMED. Buyer portal reflects CONFIRMED immediately.

### Step 3: Invoice from Confirmed Order - PASS
INV-2026-0010, total $72.63, items match order exactly (4 line items, subtotal $62.88, tax $9.75, due 2026-05-30)

### Step 4: Buyer Views Invoice - FAIL
tenantId=null bug: buyer invoice list returns 0 results. See BUG-1.
PDF accessible via direct URL (HTTP 200, application/pdf) but buyer cannot discover it.

### Step 5: Record Full Payment - PASS
Invoice PAID, balanceDue=0, paidAmount=$72.63. method=CASH, paidAt field required.

### Step 6: Stock Decrement - INFORMATIONAL
No stock decrement at confirmation. Expected - decrements on delivery completion.

---

## E2E-2 - Damaged Return to Credit Note

### Step 1: Delivered Order + Paid Invoice - PARTIAL
ORD-00002 found (Butter 500g x4, Multigrain Bread x5, $51.91). No pre-seeded PAID invoice linked to order. INV-2026-0004 promoted DRAFT->SENT->PAID as test setup.

### Step 2: Create DAMAGED Return - PASS
RET-2026-683578, reason=DAMAGED, 2x Butter 500g, restock=false. HTTP 201.

### Step 3: Credit Note - PASS (manual, no auto-gen)
Return creditNoteId=null (no auto-gen). Manual: CN-2026-0001, $10.98, status=ISSUED.

### Step 4: Apply Credit Note - PASS
Apply to PAID invoice correctly blocked (400). Applied to INV-2026-0005 (SENT, $11.97):
INV-2026-0005 -> PARTIAL (paid=$10.98, balance=$0.99). CN-2026-0001 -> APPLIED.

### Step 5: AR + Inventory - PASS
No stock movement on PENDING return. Damaged restock=false will not restock on receive. AR balance updated correctly.

---

## Recurring Invoice - PASS (end-date gap)
Monthly template created for UX Empty Cafe, $25/month, nextRunAt=2026-05-01. Appears in list. No endDate field available (OBSERVATION-2).

---

## Summary Table

| Flow | Step | Result |
|------|------|--------|
| E2E-1 | 1. Buyer places order | PASS |
| E2E-1 | 2. Operator confirms | PASS |
| E2E-1 | 3. Invoice from order | PASS |
| E2E-1 | 4. Buyer views invoice | FAIL |
| E2E-1 | 4. PDF download | PARTIAL |
| E2E-1 | 5. Record full payment | PASS |
| E2E-1 | 6. Stock decrement | INFO |
| E2E-2 | 1. Delivered + paid invoice | PARTIAL |
| E2E-2 | 2. Create DAMAGED return | PASS |
| E2E-2 | 3. Credit note | PASS |
| E2E-2 | 4. Apply credit note | PASS |
| E2E-2 | 5. AR + inventory | PASS |
| Recurring | Template creation | PASS |
| Recurring | End-date support | FAIL |

---

## Bugs

### BUG-1 (Critical): Buyer Cannot View Invoices - tenantId=null
File: apps/api/src/invoices/invoices.service.ts createInvoiceFromOrder()  
Invoices created via POST /invoices/from-order/:orderId have tenantId=null.  
forTenant() scoped queries exclude them. GET /buyer/invoices always returns 0 results.  
Impact: Buyers cannot see any invoices in buyer portal. Core finance flow broken.

### BUG-2 (Minor): Silent Standing Order Item Injection
POST /buyer/orders triggers mergeAllPendingForCustomer() silently.  
Buyer submitted 3 items, received order with 4 items and inflated quantities. No notification.

### BUG-3 (Minor): No Buyer Credit Note Listing
GET /buyer/credit-notes returns 404. Buyers cannot view their credit notes.

---

## Observations

OBS-1: No AR aging API endpoint exists.  
OBS-2: Recurring invoice has no endDate/endsAt field.  
OBS-3: Returns never auto-generate credit notes (Return.creditNoteId always null).  
OBS-4: No return photo upload endpoint for operator-initiated returns.

---

## Test Data Created

| Type | ID | Number | Status |
|------|-----|--------|--------|
| Order | b3565cc1-5633-4841-8055-41cdc50e7ca0 | ORD-1777431385836 | CONFIRMED |
| Invoice | 81f4d981-e5f9-405d-89d0-a6275d4d4fe1 | INV-2026-0010 | PAID, tenantId=null |
| Return | 23fae434-d2a6-465f-a8fd-ac0d52cffa3a | RET-2026-683578 | PENDING |
| Credit Note | 01380e0b-f301-4a56-bcf2-807d58f57587 | CN-2026-0001 | APPLIED |
| Recurring Invoice | 15e9d9f1-f333-40ec-8ac2-cecd840fe668 | - | ACTIVE |

Modified: INV-2026-0004 (60c270b6) DRAFT->SENT->PAID as test setup.
