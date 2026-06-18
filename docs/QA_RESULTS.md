# RouteFlow Web UI QA Results

**Date:** 2026-04-09  
**Environment:** https://routeflowweb-production.up.railway.app  
**Tenant tested:** `legacy` (RouteFlow Legacy)  
**Tester:** Claude Code (automated browser QA via Chrome extension)

---

## Fixes Applied During This QA Session

| #   | Issue                                                                                                                                | Fix                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Google OAuth URL had double `/api/v1` (e.g. `.../api/v1/api/v1/auth/google`)                                                         | Fixed `login/page.tsx` `apiUrl` construction                                                                                                |
| 2   | Railway hostname (`routeflowweb-production.up.railway.app`) was extracted as tenant slug `routeflowweb-production` by the middleware | Fixed `middleware.ts` to skip subdomain extraction on known hosting provider domains (`.railway.app`, `.vercel.app`, etc.)                  |
| 3   | Login page used per-tenant OAuth even when no valid tenant branding loaded                                                           | Fixed to require `branding !== null` before using per-tenant OAuth URL                                                                      |
| 4   | `GOOGLE_CALLBACK_URL` env var missing in Railway                                                                                     | Set to `https://routeflowapi-production-d504.up.railway.app/api/v1/auth/google/callback` via Railway API                                    |
| 5   | Superadmin email not set                                                                                                             | Confirmed `najathakram` SUPER_ADMIN has email `najathakram1@gmail.com` — will auto-link on first Google sign-in once credentials configured |

---

## Platform Admin Section

| Page            | URL                  | Result  | Notes                                                 |
| --------------- | -------------------- | ------- | ----------------------------------------------------- |
| Admin Login     | `/admin/login`       | ✅ Pass | Renders correctly, login works                        |
| Admin Dashboard | `/admin/dashboard`   | ✅ Pass | 18 tenants, 2 active, 7 trial; plan breakdown correct |
| Tenant List     | `/admin/tenants`     | ✅ Pass | Full list with search/filter                          |
| Tenant Detail   | `/admin/tenants/:id` | ✅ Pass | Info, usage stats, all action buttons, audit log      |
| Create Tenant   | `/admin/tenants/new` | ✅ Pass | Form renders all fields correctly                     |
| Audit Logs      | `/admin/audit-logs`  | ✅ Pass | Paginated log entries render                          |

---

## Operator Section (legacy tenant, `admin` user)

| Page              | URL                  | Result  | Notes                                                                                      |
| ----------------- | -------------------- | ------- | ------------------------------------------------------------------------------------------ |
| Dashboard         | `/dashboard`         | ✅ Pass | Revenue $683.67, 6 active orders, 8 routes, 10 drivers, route runs table                   |
| Customers         | `/customers`         | ✅ Pass | 10 customers with name, email, phone, receivables, status                                  |
| Orders            | `/orders`            | ✅ Pass | 10 orders (6 pending, 4 delivered) with correct data                                       |
| Routes            | `/routes`            | ✅ Pass | Route runs today (A+B completed, others scheduled), route templates listed                 |
| Invoices          | `/invoices`          | ✅ Pass | 14 invoices, total outstanding $683.67                                                     |
| Returns           | `/returns`           | ✅ Pass | 5 returns, all pending, correct reasons                                                    |
| Products          | `/products`          | ✅ Pass | 12 products with barcode, price, stock status                                              |
| Drivers           | `/drivers`           | ✅ Pass | 10 drivers with vehicle info and status                                                    |
| Suppliers         | `/suppliers`         | ✅ Pass | 10 suppliers listed                                                                        |
| Credit Notes      | `/credit-notes`      | ✅ Pass | 3 issued credit notes                                                                      |
| Finance Dashboard | `/finance/dashboard` | ✅ Pass | Total receivables $683.67, YTD sales chart                                                 |
| Finance Payments  | `/finance/payments`  | ✅ Pass | Loads, no payments recorded (expected)                                                     |
| Settings          | `/settings`          | ✅ Pass | Tabbed: Business Profile, Notifications, AI & Integrations, User Management, Import, Email |

### Operator — Pages Not Found (404)

| URL                | Notes                                                     |
| ------------------ | --------------------------------------------------------- |
| `/order-templates` | No web page — order templates are API-only or mobile-only |
| `/standing-orders` | No web page — standing orders are API-only or mobile-only |
| `/reports`         | No web page — analytics at `/analytics` instead           |

---

## Customer Section (`harbor_cafe` user)

| Page      | URL          | Result     | Notes                                                                                                                         |
| --------- | ------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Orders    | `/orders`    | ✅ Pass    | Shows only Harbor Café's 1 order — data isolation correct                                                                     |
| Invoices  | `/invoices`  | ✅ Pass    | Shows only Harbor Café's 2 invoices ($44.00 outstanding)                                                                      |
| Returns   | `/returns`   | ✅ Pass    | Shows only Harbor Café's 2 returns — data isolation correct                                                                   |
| Dashboard | `/dashboard` | ⚠️ Partial | Loads but shows operator-specific widgets with errors (Revenue unavailable, Could not load drivers, Could not load inventory) |

### Customer UX Gap

The dashboard uses the same operator widget layout for all roles. CUSTOMER and DRIVER roles see:

- "Revenue unavailable"
- "Could not load drivers"
- "Could not load inventory"

These are not errors — customers legitimately can't access those resources — but the UX is poor. **Recommendation:** Hide operator-only widgets for non-operator roles, or build a dedicated customer dashboard view.

---

## Driver Section (`driver_tom` user)

| Page      | URL          | Result     | Notes                                        |
| --------- | ------------ | ---------- | -------------------------------------------- |
| Dashboard | `/dashboard` | ⚠️ Partial | Same operator widget errors as customer role |

**Note:** The primary driver experience is in the React Native driver mobile app, not the web app. The web app's DRIVER role support is minimal by design.

---

## Authentication

| Feature                 | Result     | Notes                                                                                                                              |
| ----------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Username/password login | ✅ Pass    | Works for all roles with correct `tenant-slug` cookie                                                                              |
| Google OAuth URL        | ✅ Pass    | Now correctly points to `/api/v1/auth/google` (no double path, no wrong tenant)                                                    |
| Google sign-in flow     | ❌ Blocked | `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` env vars not set in Railway — shows "invalid_client"                                 |
| Superadmin Google link  | 🔧 Pending | Email `najathakram1@gmail.com` confirmed on `najathakram` user; will auto-link on first Google sign-in once credentials configured |

### To enable Google sign-in

1. Create a Google OAuth 2.0 app in [Google Cloud Console](https://console.cloud.google.com)
2. Add authorized redirect URI: `https://routeflowapi-production-d504.up.railway.app/api/v1/auth/google/callback`
3. Set in Railway API service (`@routeflow/api`):
   - `GOOGLE_CLIENT_ID` = your client ID
   - `GOOGLE_CLIENT_SECRET` = your client secret
4. Redeploy the API service

---

## Summary

| Category       | Pass   | Partial | Fail  | N/A     |
| -------------- | ------ | ------- | ----- | ------- |
| Platform Admin | 6      | 0       | 0     | 0       |
| Operator       | 13     | 0       | 0     | 3 (404) |
| Customer       | 3      | 1       | 0     | 0       |
| Driver         | 0      | 1       | 0     | 0       |
| Auth           | 2      | 1       | 1     | 0       |
| **Total**      | **24** | **3**   | **1** | **3**   |

**Overall: The core operator and platform admin flows are fully functional. The only hard failure is Google sign-in (missing credentials). Customer and driver dashboard UX has a known gap (operator widgets rendering for non-operator roles).**
