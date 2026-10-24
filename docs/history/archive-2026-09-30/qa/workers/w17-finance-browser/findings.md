# W17 — Finance Sub-Pages Browser Testing

**Audited:** 2026-04-30
**Tenant:** `ux-audit-1777265477001`
**Credentials:** `ux_admin` / `UxAdmin@123!`
**App URL:** https://routeflowmobile-production.up.railway.app
**Status:** Browser testing completed

---

## Summary

Finance home is AP-only (vendor bills + expenses); no AR Aging report exists anywhere in the operator UI. Three HIGH issues in the vendor bill and expense lifecycle: vendor bills cannot transition to Paid (no "Mark paid" button), expenses have no status actions, and the Overdue invoice list shows duplicate entries. Two UTC-timezone date display bugs affect multiple form fields. The "Staff & Drivers" company-code onboarding flow navigates to the wrong login screen.

---

## Findings

### W17-001 — Finance Home Is AP-Only — No AR Aging Dashboard (HIGH)

- **Severity:** HIGH (P1)
- **Section:** Finance Home (`/finance`)
- **Issue:** Finance home is labelled "VENDOR BILLS & EXPENSES" and shows AP-only metrics (Unpaid bills count, Amount owing). No AR Aging chart or receivables summary exists anywhere in the operator app. The More menu's INSIGHTS section contains only "Analytics" (Revenue, top items, margins); no AR Aging report.
- **Expected:** An AR Aging report (Current / 1–30 / 31–60 / 61–90 / 90+ day buckets) accessible from Finance or More > Insights.
- **Actual:** Only the raw overdue invoice list is accessible ("79 Overdue invoices"). No aging breakdown.
- **Fix:** Add an AR Aging report screen with aging bucket breakdown.

---

### W17-002 — Date Fields Default to 2025-06-01 (11 Months in the Past) (MEDIUM)

- **Severity:** MEDIUM (P2)
- **Section:** Vendor Bills (new bill form), Invoice Record Payment form
- **Issue:** Both the new vendor bill date field and the Invoice "Record Payment" date field default to `2025-06-01` — approximately 11 months in the past on the audit date of 2026-04-30.
- **Evidence:** New vendor bill form opened — date field pre-populated `2025-06-01`. Invoice Record Payment form opened — "Payment date" pre-populated `2025-06-01`.
- **Impact:** Operators not noticing will record bills or payments with a stale date, corrupting AR aging and AP aging reports.
- **Fix:** Replace the hard-coded `2025-06-01` default with `new Date().toISOString().split('T')[0]`.

---

### W17-003 — Dates Displayed 1 Day Earlier Than Entered (UTC Offset Bug) (MEDIUM)

- **Severity:** MEDIUM (P2)
- **Section:** Vendor Bills, Expenses
- **Issue:** When a date is entered as `2026-04-30`, the detail view displays "April 29, 2026" — consistently 1 day early. Root cause: date-only strings parsed as UTC midnight (`2026-04-30T00:00:00Z`) then rendered in a timezone behind UTC, showing the prior day.
- **Evidence:** Entered `2026-04-30` on expense form → saved → detail view shows "April 29, 2026". Edit form shows the correct input date, confirming the display layer bug.
- **Fix:** Parse YYYY-MM-DD strings without UTC conversion. Use `new Date(dateStr + 'T12:00:00')` or a date-only formatter that avoids timezone shifts.

---

### W17-004 — "Mark Received" Not Disabled on Already-Received Bills (MEDIUM)

- **Severity:** MEDIUM (P2)
- **Section:** Vendor Bills (detail page)
- **Issue:** On a bill with status "Received", the "Mark received" button remains active and clickable. Tapping it shows a "Bill marked as received." toast with no error. This is the UI manifestation of the idempotency gap already filed at the API level (RF-084).
- **Expected:** "Mark received" button disabled/replaced with "Mark paid" once status is Received.
- **Actual:** Button fully clickable, fires the same status update silently again.
- **Fix:** Conditionally disable/hide "Mark received" when `bill.status === 'RECEIVED'`. Show "Mark paid" (see W17-005) instead. Cross-reference: RF-084 (API has no server-side guard against double-receive).

---

### W17-005 — No "Mark Paid" Transition for Vendor Bills; Workflow Terminates at Received (HIGH)

- **Severity:** HIGH (P1)
- **Section:** Vendor Bills
- **Issue:** The vendor bill lifecycle Draft → Received → Paid is incomplete. No "Mark paid" button exists on received bills. The "Paid" filter tab on the bills list always shows "No bills yet."
- **Expected:** "Mark paid" button on Received bills with optional payment date and reference.
- **Actual:** Received bills only show the erroneous "Mark received" (re-fires the same transition) and "Void". No bill can reach Paid status via the UI.
- **Fix:** Add a "Mark paid" button on bill detail when `bill.status === 'RECEIVED'`, wired to `PATCH /vendor-bills/:id` with `{ status: 'PAID' }`.

---

### W17-006 — Expenses Have No Status-Change Actions; All Stuck at Pending (HIGH)

- **Severity:** HIGH (P1)
- **Section:** Expenses
- **Issue:** Expense detail only shows "Edit" and "Delete expense". The edit form has no Status field. No "Mark paid" or "Void" button exists. All expenses created via the UI are permanently stuck in "Pending".
- **Evidence:** Expenses with Paid/Void status visible in the list exist only because they were seeded directly via API — there is no UI path to reach those statuses.
- **Fix:** Add "Mark paid" and "Void" action buttons to expense detail, wired to `PATCH /expenses/:id` with `{ status: 'PAID' | 'VOID' }`.

---

### W17-007 — Duplicate Invoice Entries in Overdue Filter List (HIGH)

- **Severity:** HIGH (P1)
- **Section:** Invoices (list — Overdue filter)
- **Issue:** INV-000422 (Hilmy Nizam, $443.00, Due 4/13/2026) appears twice consecutively in the Overdue-filtered invoice list. All visible fields (number, customer, amount, date) are identical.
- **Expected:** Each invoice appears exactly once.
- **Actual:** INV-000422 rendered twice. Likely root cause: JOIN on payments or line items producing duplicate rows without DISTINCT; or frontend array being concatenated twice.
- **Fix:** Add `DISTINCT` / deduplication by invoice ID to the overdue invoices query, or deduplicate by ID on the frontend before rendering.

---

### W17-008 — PDF Due Date 1 Day Later Than In-App Display (MEDIUM)

- **Severity:** MEDIUM (P2)
- **Section:** Invoices (PDF)
- **Issue:** INV-000426 shows "Due 4/13/2026" in-app but "Due Date: Apr 14, 2026" in the PDF — a 1-day discrepancy in the opposite direction from W17-003. Together W17-003 and W17-008 confirm dates are stored as UTC datetime (`T00:00:00Z`) and inconsistently converted: in-app renders in local time (shows Apr 13), PDF renders in UTC (shows Apr 14).
- **Fix:** Store dates as date-only strings (no time component) or standardize all rendering to UTC. Same root cause as W17-003.

---

### W17-009 — "Staff & Drivers" Company-Code Flow Routes to Customer Portal (LOW)

- **Severity:** LOW (P3)
- **Section:** Authentication / Onboarding
- **Issue:** On the onboarding sign-in page: select "Staff & Drivers" → enter tenant code → tap Continue → app navigates to `/customer-login` (Customer Portal) instead of `/login` (staff/operator login). Operators and drivers using this onboarding flow cannot log in.
- **Expected:** Staff & Drivers → `/login`; Customer → `/customer-login`.
- **Actual:** Both paths route to `/customer-login`.
- **Fix:** Audit the company-code screen's Continue handler — navigation target must be conditioned on the selected role.

---

### W17-010 — No Dedicated Payments Section (INFO)

- **Severity:** INFO
- **Section:** Finance
- **Issue:** No unified Payments ledger exists. Invoice payments are recorded per-invoice only. This is a feature gap (not a bug); noted for product roadmap.
- **Fix:** Consider a Payments list view under Finance once W17-005 (vendor bill paid transition) is resolved.

---

## PASS Items

| Test                             | Result                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| Expense amount=0 validation      | PASS — blocked                                                                     |
| Expense categories present       | PASS — Advertising, Car and Truck, etc.                                            |
| Invoice View PDF button          | PASS — opens correct PDF in new tab                                                |
| Invoice Void confirmation dialog | PASS — dialog shown before void                                                    |
| Invoice Record Payment form      | PASS — Cash/Check/ACH/Credit card/Advance/Credit note/Other; %-fill shortcuts work |
| Invoice filter tabs              | PASS — All/Draft/Sent/Overdue/Paid/Voided all render                               |
| Expense filter tabs              | PASS — All/Pending/Paid/Void all render                                            |
| Vendor bill filter tabs          | PASS — All/Draft/Received/Paid/Void all render                                     |
| Expense creation roundtrip       | PASS — expense created and visible in list                                         |

---

## Summary Table

| ID      | Severity    | Section                 | Title                                                  |
| ------- | ----------- | ----------------------- | ------------------------------------------------------ |
| W17-001 | HIGH (P1)   | Finance Home            | No AR Aging dashboard — Finance is AP-only             |
| W17-002 | MEDIUM (P2) | Vendor Bills / Invoices | Date fields default to 2025-06-01                      |
| W17-003 | MEDIUM (P2) | Vendor Bills / Expenses | Dates displayed 1 day earlier (UTC offset)             |
| W17-004 | MEDIUM (P2) | Vendor Bills            | "Mark received" not disabled on Received bills         |
| W17-005 | HIGH (P1)   | Vendor Bills            | No "Mark paid" transition — stuck at Received          |
| W17-006 | HIGH (P1)   | Expenses                | No status-change actions — stuck at Pending            |
| W17-007 | HIGH (P1)   | Invoices                | Duplicate entries in Overdue filter list               |
| W17-008 | MEDIUM (P2) | Invoices                | PDF due date 1 day later than in-app display           |
| W17-009 | LOW (P3)    | Auth                    | Staff & Drivers company-code routes to Customer Portal |
| W17-010 | INFO        | Finance                 | No dedicated Payments section                          |
