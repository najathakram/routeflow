# W16 — Settings QA Findings

**Agent:** W16
**Date:** 2026-04-30
**Tenant:** `ux-audit-1777265477001` (UX Audit Co)
**Operator:** `ux_admin` / `UxAdmin@123!`
**App URL:** https://routeflowmobile-production.up.railway.app

---

## Executive Summary

The Settings section is significantly underdeveloped. The app renders a **single flat Settings page** (`/settings`) instead of the expected tabbed layout (Business Profile, Users, Notifications, Branding, Invoicing). The `canActAsDriver` toggle is missing from the UI entirely. The mode-switcher pill does not appear on the operator Home screen for TENANT_ADMIN — **F-012 confirmed**.

---

### W16-001 — Settings — Missing Tabbed Layout

- **Severity:** P1
- **Tab:** All
- **Issue:** Settings page (`/settings`) is one flat form: Contact Phone, Address (City/ZIP), Invoicing (Tax Rate), Notifications (Push toggle). No tabs for Users, Branding, or detailed Invoicing.
- **Expected:** Full tabbed Settings: Business Profile, Users, Notifications, Branding, Invoicing tabs.
- **Actual:** One flat page, 4 fields, 1 toggle. No subtabs at all.
- **Fix:** Implement full tabbed Settings layout. Users tab is especially critical.

---

### W16-002 — Business Profile — No ZIP Validation (Accepts "ABC")

- **Severity:** P2
- **Tab:** Business-Profile
- **Issue:** ZIP field accepts non-numeric strings like "ABC". Save shows "Settings saved" toast without any validation error.
- **Expected:** Reject invalid ZIP formats with inline error before saving.
- **Actual:** ZIP="ABC" accepted and saved silently.
- **Fix:** Add ZIP validation regex (e.g. /^\d{5}(-\d{4})?$/). Show inline error before saving.

---

### W16-003 — Business Profile — No Business Name / Email Edit Fields

- **Severity:** P2
- **Tab:** Business-Profile
- **Issue:** Tenant name ("UX Audit Co") and admin email shown as read-only header text. No editable inputs.
- **Expected:** Editable fields for Business Name and Contact Email.
- **Actual:** Name and email are static, read-only.
- **Fix:** Add editable input fields for Business Name and Contact Email.

---

### W16-004 — Invoicing — No Tax Rate Range Validation (Accepts 101 and -1)

- **Severity:** P2
- **Tab:** Invoicing
- **Issue:** Tax rate accepts `101` and `-1` with no validation error — both saved successfully.
- **Expected:** Validate range 0–1 (decimal). Inline errors for out-of-range values.
- **Actual:** Both `-1` and `101` saved with "Settings saved" toast. No error shown.
- **Fix:** Add min=0, max=1 validation. Gate save on valid range.

---

### W16-005 — Users Tab — Entirely Absent

- **Severity:** P0
- **Tab:** Users
- **Issue:** No Users management tab in Settings. Routes `/settings/users` and `/users` both return "Unmatched Route — Page could not be found." The Drivers section (`/drivers`) manages only driver accounts.
- **Expected:** Users tab: list all tenant users, create/edit/delete operators, canActAsDriver toggle per user, delete confirmation dialog.
- **Actual:** No Users tab or route exists. No way to manage operator users from Settings.
- **Fix:** Build Users tab at `/settings/users` with user list, create form, per-user canActAsDriver toggle, edit/delete with confirmation dialog.

---

### W16-006 — canActAsDriver Toggle — Not Exposed in UI (F-012 Root Cause)

- **Severity:** P0
- **Tab:** Users
- **Issue:** `canActAsDriver` toggle not visible anywhere — not in Settings, not on Profile page (`/profile`). `ux_admin` (TENANT_ADMIN) cannot enable dual-role mode from the UI.
- **Expected:** TENANT_ADMIN should have `canActAsDriver` defaulting to true, visible as a toggle in Users tab or Profile. Enabling should show Operator/Driver mode-switcher pill on Home screen.
- **Actual:** No toggle exists. Mode-switcher pill absent on Home screen.
- **Fix:** (1) Expose canActAsDriver toggle in Users tab per-user and in Profile for self-service. (2) Home screen header renders ModeSwitcherPill when canActAsDriver is true. (3) Verify `PATCH /users/:id { canActAsDriver: true }` is wired to frontend state.

---

### W16-007 — Home Screen — Mode-Switcher Pill Absent for TENANT_ADMIN (F-012 Confirmed)

- **Severity:** P1
- **Tab:** Home (Users side effect)
- **Issue:** After login as ux_admin (TENANT_ADMIN), Home screen header shows only bell icon and "UA" avatar. No Operator/Driver mode-switcher pill visible.
- **Expected:** TENANT_ADMIN with `canActAsDriver: true` should see Operator/Driver toggle pill in fixed header.
- **Actual:** No pill. Header: bell + avatar only.
- **Fix:** (1) Ensure `/auth/me` returns `canActAsDriver: true` for TENANT_ADMIN. (2) Add conditional: `if (user.canActAsDriver) show <ModeSwitcherPill />`. (3) Confirm `feat: canActAsDriver defaults true for TENANT_ADMIN` commit is live in production and frontend reads the flag.

---

### W16-008 — Notifications — No Test Notification Button; No Channel Preferences

- **Severity:** P2
- **Tab:** Notifications
- **Issue:** Only a single push toggle in Notifications. No test notification button. No per-channel or per-event preferences.
- **Expected:** Test notification button; per-channel toggles (email, push, in-app); per-event type preferences.
- **Actual:** Single push toggle. Toggling ON shows dialog: "Push enabled — We'll register this device with the push service on your next launch." Toggle state persists across navigation. No test button.
- **Fix:** Add "Send test notification" button. Add per-channel and per-event notification preference toggles.

---

### W16-009 — Branding Tab — Entirely Absent

- **Severity:** P2
- **Tab:** Branding
- **Issue:** No Branding tab in Settings. No logo upload, color picker, or branding preview.
- **Expected:** Logo upload (PNG/JPG accepted, SVG rejected), brand color picker with live preview, save persists on refresh.
- **Actual:** No Branding tab or any branding customization.
- **Fix:** Implement Branding tab with logo upload, file type validation (reject SVG), color picker, and preview.

---

### W16-010 — Invoicing — No Invoice Prefix or Due Days Fields

- **Severity:** P2
- **Tab:** Invoicing
- **Issue:** Invoicing settings only has Default Tax Rate. No invoice number prefix or payment due days fields.
- **Expected:** Tax rate + Invoice prefix (e.g. "INV-") + Payment due days (e.g. 30).
- **Actual:** Only tax rate present.
- **Fix:** Add Invoice prefix and payment due days fields to Invoicing section.

---

### W16-011 — Settings — "Save changes" Toast Fires Without Confirming PATCH

- **Severity:** P2
- **Tab:** Business-Profile
- **Issue:** Network monitoring after "Save changes" captured only OPTIONS (204) preflight and GET `/api/v1/settings` (200). No PATCH/PUT captured. ZIP=99999 did not persist (reverted to 12345 from earlier save) while earlier saves did persist. Toast fires on every click regardless.
- **Expected:** Each save fires one PATCH/PUT. Toast appears only after confirmed 2xx response.
- **Actual:** Intermittent save failures. Toast fires regardless of actual save outcome.
- **Fix:** Ensure PATCH/PUT always fires before GET re-fetch. Gate success toast on confirmed 2xx. Show error toast on 4xx/5xx.

---

### W16-012 — Settings — Business Name Header Flash on Load

- **Severity:** P3
- **Tab:** Business-Profile
- **Issue:** Header briefly shows generic "Business" text instead of "UX Audit Co" until GET `/api/v1/settings` completes.
- **Expected:** Business name shown immediately from cached auth context, with loading skeleton if unavailable.
- **Actual:** "Business" shown first, replaced by "UX Audit Co" after API responds — visible flash.
- **Fix:** Initialize from cached auth context data or add proper loading skeleton.

---

### W16-013 — Profile Page — Role Displays Raw Enum String

- **Severity:** P3
- **Tab:** Users/Profile
- **Issue:** Profile page (`/profile`) shows Role as "TENANT_ADMIN" (raw enum string).
- **Expected:** Human-readable label: "Administrator".
- **Actual:** "TENANT_ADMIN" displayed verbatim.
- **Fix:** Map role enums to display strings: `TENANT_ADMIN` -> "Administrator", `DRIVER` -> "Driver".

---

## Summary Table

| Finding | Severity | Tab              | Issue                               |
| ------- | -------- | ---------------- | ----------------------------------- |
| W16-001 | P1       | All              | Missing tabbed layout               |
| W16-002 | P2       | Business-Profile | No ZIP validation                   |
| W16-003 | P2       | Business-Profile | No name/email edit fields           |
| W16-004 | P2       | Invoicing        | No tax rate range validation        |
| W16-005 | P0       | Users            | Users tab entirely absent           |
| W16-006 | P0       | Users            | canActAsDriver toggle not exposed   |
| W16-007 | P1       | Home             | Mode-switcher pill absent (F-012)   |
| W16-008 | P2       | Notifications    | No test button, no channel prefs    |
| W16-009 | P2       | Branding         | Branding tab entirely absent        |
| W16-010 | P2       | Invoicing        | No prefix/due-days fields           |
| W16-011 | P2       | Business-Profile | Toast fires without confirmed PATCH |
| W16-012 | P3       | Business-Profile | Business name header flash          |
| W16-013 | P3       | Users/Profile    | Role shows raw enum string          |

---

## What Works

- Settings page loads correctly from More -> INSIGHTS -> Settings (/settings)
- Business name "UX Audit Co" and admin email displayed (read-only) in header
- Contact phone, city, ZIP, and tax rate fields are editable
- "Save changes" does persist data in most cases (ZIP and tax rate confirmed persistent across navigation)
- "Settings saved" success toast appears on click
- Push notifications toggle works — shows "Push enabled" confirmation dialog on enable
- Push toggle state persists across navigation (confirmed: toggle ON survives back/return)
- Drivers page (/drivers) lists 2 active drivers: ux_driver_a and ux_driver_b
- Profile page (/profile) shows correct username (ux_admin) and role (TENANT_ADMIN)
- Change password accessible from More and Profile pages
- Sign out works correctly
