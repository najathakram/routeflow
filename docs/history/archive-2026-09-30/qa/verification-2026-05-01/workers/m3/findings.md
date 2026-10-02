# m3

| RF     | Status      | Evidence (≤ 30 words)                                                                                                                                                          |
| ------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RF-201 | ⚠️ PARTIAL  | Adjust-stock form has REASON chips (Received/Damaged/Count correction/Waste/Other) + NOTES text field present; network POST payload unverifiable (navigation clears tracking). |
| RF-206 | ✅ VERIFIED | Dispatch → All routes shows 4 unique rows: W32-Bug5-TestRoute, W32-Bug5-Test, UX Route B, UX Route A. No duplicates found.                                                     |
| RF-214 | ❌ FAIL     | Submitted ZIP="1234" + tax rate="150"; toast "Settings saved" appeared — no inline validation errors shown at all.                                                             |
| RF-221 | ❌ FAIL     | BILL-2026-0001 (badge: "Received") still shows fully active green "Mark received" CTA — not disabled or hidden.                                                                |
| RF-223 | ❌ FAIL     | Vendor Bills tabs: All · Unpaid · Paid · Draft only. "Partial" and "Void" filter tabs absent.                                                                                  |
| RF-224 | ❌ FAIL     | Returns page shows All/Pending/Processed/Cancelled filters and empty state — zero Create Return / + CTA anywhere.                                                              |
| RF-225 | ❌ FAIL     | Settings → NOTIFICATIONS shows only "Push notifications" toggle. No "Send Test" button, no per-event preferences.                                                              |
| RF-226 | ❌ FAIL     | Tenant name "UX Audit Co" and email are static display text; clicking does not open input. PHONE/CITY/ZIP editable only.                                                       |
| RF-227 | ❌ FAIL     | Settings → INVOICING shows only "DEFAULT TAX RATE" field. No invoice prefix or due-days field present.                                                                         |

## Failures

### RF-214 — Settings Business Profile validation missing

- **Repro**: Settings → set ZIP = "1234", tax rate = "150" → click Save changes
- **Expected**: Inline errors: ZIP must be 5+ digits; tax rate must be in valid range
- **Got**: Toast "Settings saved" — invalid values accepted and persisted
- **Proposed fix**: Add frontend validation (ZIP min 5 chars; tax rate 0–100 or 0.0–1.0 range) before submit

### RF-221 — Vendor Bills "Mark Received" active on already-received bills

- **Repro**: Finance → All Bills → open BILL-2026-0001 (badge: Received)
- **Expected**: "Mark received" CTA disabled or hidden for already-received bills
- **Got**: Full-width active green "Mark received" button present and clickable
- **Proposed fix**: Conditionally disable/hide "Mark received" when bill.status === RECEIVED

### RF-223 — Vendor Bills filter tabs missing Partial/Void

- **Repro**: Finance → All bills tab row
- **Expected**: Tabs include Partial and Void statuses
- **Got**: Tabs: All · Unpaid · Paid · Draft only
- **Proposed fix**: Add Partial and Void filter tabs to vendor-bills list page

### RF-224 — Returns "Create Return" CTA absent

- **Repro**: More → Returns → all tabs
- **Expected**: Operator can initiate a return via a prominent CTA
- **Got**: No Create Return / + button anywhere on the Returns screen
- **Proposed fix**: Add "New Return" FAB or header button to operator Returns page

### RF-225 — Settings Notifications "Send Test" + per-event prefs missing

- **Repro**: /settings → NOTIFICATIONS section
- **Expected**: Per-event notification toggles + "Send Test" button
- **Got**: Single "Push notifications" toggle only
- **Proposed fix**: Add per-event notification controls and a "Send Test" action

### RF-226 — Settings Business Profile tenant name/email not editable

- **Repro**: /settings → click on "UX Audit Co" or email text
- **Expected**: Tenant name and contact email should be editable input fields
- **Got**: Both render as read-only static text; no cursor, no input activation
- **Proposed fix**: Convert tenant name and email into editable inputs with Save flow

### RF-227 — Settings Invoicing prefix + due-days missing

- **Repro**: /settings → INVOICING section
- **Expected**: Invoice number prefix field + default payment due-days field
- **Got**: Only "DEFAULT TAX RATE (E.G. 0.0875)" field
- **Proposed fix**: Add invoice prefix and due-days fields to Invoicing settings section

## Adjacent bugs noticed

- NEW-m3-1 [P3] Settings accepted tax rate "150" without validation — if consumed as multiplier, invoices would be overcharged; stored invalid value may silently corrupt invoice totals.
- NEW-m3-2 [P2] QA tenant stock permanently mutated by test adjustments (Almond Mix 0→5, Apple Juice 100→103, Baby Spinach 100→102) — no rollback guard on ux-audit tenant.
