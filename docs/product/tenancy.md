# Tenancy, Identity, Roles & Settings

_Who is allowed to do what, in whose workspace, configured once and inherited everywhere._

## The problem

A wholesale/distribution business running on spreadsheets, a paper delivery book, WhatsApp and a
separate accounting package has no concept of "who is allowed to do what". The master price list
lives on the owner's laptop, a copy lives on the warehouse PC, the driver carries a paper book, and
the bookkeeper works in a different program entirely — anyone holding a file can change anything,
nothing is attributable, and when a picker or driver leaves there is no way to actually cut off
their access. There is also nowhere that "how this business works" is written down once: its
trading name and logo on invoices, its sales-tax rate, its remit-to bank details, which email
address invoices are sent from, and what invoice number to carry on from after switching systems.
Every one of those facts gets re-typed, drifts, and eventually ends up wrong on a document a
customer sees.

## Why it matters to a tenant

One workspace per business, one login per person, and a role that bounds what each person can
reach — so a warehouse hire cannot see margins and a driver cannot edit prices. Offboarding becomes
one status change that kills every live session on every device instead of a password everyone
knows. Business identity is configured once and is then inherited automatically by invoice PDFs,
buyer-portal statements and the web theme, so no one hand-edits a letterhead. Trial, suspension and
read-only states are enforced at the API edge, which means a lapsed account degrades to
exports-only rather than to a support ticket. And platform support can diagnose a tenant's problem
through a time-boxed impersonation session instead of the owner emailing a password.

## Core use cases

1. **Provision an isolated workspace and get the owner in.** A business signs up (or is created by
   platform support), gets its own slug/host, a verified owner login, a trial clock, and a hard
   data boundary — no query it runs can ever see another business's rows.
2. **Give each person their own login bounded by a role, and revoke it instantly.** Owner, office
   staff, warehouse, drivers and buyers each authenticate as themselves with a role that decides
   which endpoints and screens they reach; deactivating a person ends their access and their live
   sessions.
3. **Configure business identity and operating defaults once, everywhere.** Trading name, logo,
   brand colour, address, tax rate, sending email, document numbering and remit-to details are set
   in one hub and are read by invoices, statements, emails, the buyer portal and the apps.

## Must have (P0)

| ID      | Capability                                                               | Status          | What it does                                                                                                                                                                             | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------- | ------------------------------------------------------------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TEN-M1  | Tenant provisioning and hard data isolation                              | SHIPPED ✅      | A business gets its own workspace with a unique slug, an owner account, a trial clock and seeded expense categories; every subsequent query is automatically confined to that workspace. | `POST /api/v1/public/tenants/register` → `tenants.service.ts:85 register()`; isolation via `prisma.service.ts` `forTenant()` / `_wrapTxWithTenant()`; tenant id read only from the verified JWT (`tenant.interceptor.ts:18`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| TEN-M2  | Host and slug to workspace mapping                                       | SHIPPED ✅      | The right workspace is inferred from the URL, or picked on the login form; carried to the API on every call.                                                                             | `apps/web/lib/tenant-host.ts` `tenantSlugFromHostname()`; server mirror `tenant-resolution.middleware.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| TEN-M3  | Staff sign-in, refresh and session revocation                            | SHIPPED ✅      | Login, rotating refresh, device list, per-session and full revocation.                                                                                                                   | `auth.controller.ts:63,83,102,161,169`; `RefreshToken` model with realm claim `type:"staff"` vs `"buyer"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| TEN-M4  | Password lifecycle: set, change, forgot, forced rotation                 | PARTIAL 🟡      | Change/set/forgot/reset password with complexity rules and forced rotation for admin-created accounts.                                                                                   | `auth.controller.ts:122,131,143,151`. DEFECT: `auth.service.ts:409` `requestPasswordReset` uses an unscoped `findFirst({where:{email}})` while `User` is `@@unique([tenantId, email])`, so a reset for an address that exists in more than one workspace resolves to whichever row Prisma returns first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| TEN-M5  | Brute-force protection and account lockout                               | SHIPPED ✅      | 10-attempt lockout, 15-min window, per-IP throttle, admin unlock.                                                                                                                        | `auth.service.ts:87-88`; `@Throttle` on `auth.controller.ts:66,135,145,153`; `POST /users/:id/unlock` `@Roles(OPERATOR, TENANT_ADMIN)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| TEN-M6  | Roles and server-side role enforcement                                   | PARTIAL 🟡      | Five roles with a hierarchy, plus a per-user "act as driver" capability, enforced by `RolesGuard`.                                                                                       | `roles.guard.ts` `ROLE_SATISFIES`; `@Roles` per handler. verified: several team-management routes advertised as admin-narrowed are not — see TEN-M7.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| TEN-M7  | Team management — add, deactivate, reset, change role                    | PARTIAL 🟡      | Admin can list staff, create an operator, flip role, grant admin/driver permit, suspend, unlock, force-reset.                                                                            | `users.controller.ts` — `POST /users/operator`, `PATCH /:id/status`, `POST /:id/reset-password`, `PATCH /:id/admin`, `PATCH /:id/driver-permit`. verified: `POST /users/operator` (`:41`), `PATCH /:id/status` (`:89`), `POST /:id/reset-password` (`:96`), `PATCH /:id/driver-permit` (`:120`) are all gated only `@Roles(UserRole.OPERATOR)` — any plain OPERATOR can suspend a colleague, force-reset their password, and grant a driver permit. Only `PATCH /:id/admin` re-checks caller admin status in the service (`users.service.ts:205-207`). No invite email; no seat-cap check; no delete/soft-delete endpoint despite `User.deletedAt` existing.                                                                                                                                                                                                                                                                                            |
| TEN-M8  | Business identity and branding applied to every customer-facing document | PARTIAL 🟡      | Trading name, logo, brand colour, address and phone are set once and appear on invoice PDFs, buyer statements, the web theme and the login page.                                         | `PUT /tenants/me/config/branding`, `POST /tenants/me/config/branding/logo`; public read `GET /public/tenants/:slug/branding`; consumers `invoice-pdf-template.tsx:396`, `statement-pdf-template.tsx:191`, `tenant-provider.tsx:131`. verified: PATCH /settings' allowlist (`settings.controller.ts:130-159`) explicitly excludes `businessName` and email ("NOT editable by tenant admin"), yet the Business Profile form has required Business Name / Account Email inputs that PATCH `/settings` and silently discard the edit; no screen anywhere calls the branding PUT or offers a `primaryColor` picker (only a read-only swatch in the admin panel); mobile never reads `primaryColor` (`apps/mobile/lib/tenant-store.ts:37` has zero consumers). Logo upload and address/phone/notes/terms are genuinely shipped.                                                                                                                               |
| TEN-M9  | Tax rate and invoice defaults as tenant settings                         | PARTIAL 🟡      | Tenant sets sales-tax percentage, invoice prefix, payment-due days, notes and terms once; new documents inherit them.                                                                    | `GET/PATCH /api/v1/settings` (`settings.controller.ts:41,118`); `taxRate` validated 0..100 at `settings.controller.ts:122-128`. verified: the Invoice Numbering card sends `invoicePrefix` and `paymentDueDays` to PATCH `/settings`, but neither field is in the allowlist or the TenantConfig map and neither is returned by GET `/settings` (`:101-116`) — both are dead controls that blank on every reload, not merely ignored at mint time. Separately, `invoices.service.ts:2723 generateInvoiceNumber()` hardcodes `INV-${year}-` and reads the running max through the raw unscoped client outside a transaction (`:467,:2664`), so the fallback sequence is drawn across all tenants.                                                                                                                                                                                                                                                         |
| TEN-M10 | Tenant lifecycle status enforced at the API edge                         | SHIPPED ✅      | Trial, active, read-only, suspended, cancelled are real states enforced at the guard layer, with an anchored mutation allowlist under READ_ONLY.                                         | `tenant-status.guard.ts` (APP_GUARD, 60s cache); `tenant-status.guard.spec.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| TEN-M11 | Super-admin platform administration                                      | SHIPPED ✅      | Platform staff create tenants, see roster/growth stats, change plan/status, extend trial, toggle add-ons, reset the tenant admin's password, read the cross-tenant audit log.            | `platform-admin.controller.ts` under `SuperAdminGuard`; every lifecycle mutation writes an `AuditLog` row via `recordAdminAction`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| TEN-M12 | Guardrails on destructive settings and bulk-delete endpoints             | BROKEN 🔴       | Any endpoint that can erase a workspace's financial history must be tenant-scoped, admin-only, confirmed, and audited. Two are not.                                                      | `DELETE /api/v1/settings/financial-data` (`settings.controller.ts:360-385`) runs ten unscoped `deleteMany({})` calls on the raw `PrismaService` (not `forTenant()`), wiping every tenant's finance tables from any OPERATOR token; no UI caller exists — it is a dead but live endpoint. `DELETE /api/v1/customers/all` (`customers.controller.ts:131`) → `customers.service.ts:1959 deleteAllCustomers()` cascades with no status filter, destroying PAID invoices and payments. verified: `deleteAllCustomers` runs through `this.prisma.tenantTransaction(...)` (the scoped wrapper), so unlike the financial-data endpoint it CANNOT touch another tenant's rows — only the financial-data endpoint is cross-tenant. verified: the web hook `useDeleteAllCustomers` (`apps/web/lib/api/customers.ts:476`) has zero callers anywhere in `apps/web` — it is a dead, unwired hook exactly like the financial-data endpoint, not a reachable UI action. |
| TEN-M13 | Owner email verification and signup availability checks                  | MUST ✅ SHIPPED | Gates the entire provisioning flow: verifying the owner's email, resending a lost verification, and checking username/slug availability before signup.                                   | `POST /api/v1/auth/verify-email` (`auth.controller.ts:113`, `@Throttle` 10/min); `POST /public/tenants/resend-verification`, `GET /public/tenants/username-available`, `GET /public/tenants/:slug/available` (`public-tenants.controller.ts:45,58,70`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Testing criteria

#### TEN-M1

- [ ] Given tenant A and B each own a Customer row, a query under A's context returns only A's row. `Jest`
- [ ] `forTenant().customer.findUnique({where:{id: bRowId}})` under tenant A returns null for tenant B's id. `Jest`
- [ ] `X-Tenant-Slug` header is ignored after login; the bound tenant always comes from the JWT. `Jest`
- [ ] Registering a taken slug returns 409 and leaves no partial Tenant/TenantConfig/User rows. `Playwright`
- [ ] A reserved slug (admin/api/app/www/platform/auth/health/static) is rejected with 409. `Jest`

#### TEN-M2

- [ ] `tenantSlugFromHostname("routeflowweb-production.up.railway.app")` is null; a real subdomain resolves correctly. `Jest`
- [ ] Every `PLATFORM_HOSTS` label and any host with fewer than 3 labels shows the Workspace field. `Jest`
- [ ] On a hosting-provider host, form login sets the tenant-slug cookie to the typed workspace, not the service name. `Playwright`
- [ ] A request for a SUSPENDED tenant resolves no tenant. `Jest`
- [ ] The tenant-slug cookie is readable from `document.cookie` and never httpOnly. `manual`

#### TEN-M3

- [ ] A buyer-realm refresh token is rejected before any staff refresh-token hash lookup. `Jest`
- [ ] Revoking one session leaves other sessions on the same account working. `Jest`
- [ ] Logout invalidates every RefreshToken row for that user. `Jest`
- [ ] Revoking a session from one browser context bounces that context to `/login` on its next call. `Playwright`
- [ ] A legacy refresh token with no realm claim is still accepted. `Jest`

#### TEN-M4

- [ ] A reset requested from tenant B's host, for an email that exists in both A and B, resolves to the tenant-B user. `Jest`
- [ ] A used reset token cannot be replayed. `Jest`
- [ ] A successful reset revokes every RefreshToken for that user. `Jest`
- [ ] `requestPasswordReset` for a non-existent address returns the same 200 body/timing as a real one. `Jest`
- [ ] `POST /auth/set-password` on an account with a non-null password column is rejected. `Jest`

#### TEN-M5

- [ ] The 10th wrong password locks the account for 15 minutes without a bcrypt call on the 11th attempt. `Jest`
- [ ] A login after `lockedUntil` has passed clears the lock and proceeds normally. `Jest`
- [ ] `POST /users/:id/unlock` by TENANT_ADMIN succeeds; by DRIVER returns 403. `Jest`
- [ ] 11 attempts from one IP inside 5 minutes returns 429 regardless of username. `manual`
- [ ] A lockout on tenant A's user does not affect a same-named user in tenant B. `Jest`

#### TEN-M6

- [ ] A handler with no `@Roles` metadata is denied by default. `Jest`
- [ ] A TENANT_ADMIN token satisfies an `@Roles(OPERATOR)` route; a DRIVER token is refused. `Jest`
- [ ] `canActAsDriver=true` passes an `@Roles(DRIVER)` route; the claim only updates after re-login. `Jest`
- [ ] `PATCH /users/:id/admin` from an OPERATOR with `isAdmin=true` still returns 403. `Jest`
- [ ] A DRIVER-role login cannot reach `/settings`. `Playwright`

#### TEN-M7

- [ ] `POST /users/operator` with an email used in the same tenant returns 400; the same email in another tenant is accepted. `Jest`
- [ ] `PATCH /users/:id/status → SUSPENDED` from a bare OPERATOR currently succeeds — confirm this is the intended blast radius before narrowing to TENANT_ADMIN. `Jest`
- [ ] `PATCH /users/:id/driver-permit=true` creates exactly one Driver row and is idempotent. `Jest`
- [ ] `GET /users` under tenant A never returns a tenant-B user, including by direct id (404). `Jest`
- [ ] `PATCH /users/:id/admin` from a non-admin OPERATOR returns 403 (the one route that is actually re-checked). `Jest`

#### TEN-M8

- [ ] `PUT /tenants/me/config/branding` with an invalid hex colour returns 400. `Jest`
- [ ] A logo/address change invalidates previously cached invoice PDFs. `Jest`
- [ ] The tenant-facing Business Profile form's Business Name / Account Email fields are made to actually persist, or are removed so they stop silently discarding edits. `Playwright`
- [ ] `GET /public/tenants/<slug>/branding` for a tenant with no logo returns `logoUrl: null` with a safe fallback. `Playwright`
- [ ] Setting `primaryColor` is reflected in the mobile app theme once mobile reads the field. `manual`

#### TEN-M9

- [ ] `PATCH /settings {taxRate: 150}` returns 400; `{taxRate: 8.75}` is stored and read back exactly. `Jest`
- [ ] `{taxRate: "abc"}` and `{taxRate: -1}` are rejected. `Jest`
- [ ] Document tax = `roundMoney(taxableBase * rate/100)`, applied exactly once. `Jest`
- [ ] Setting the Invoice Number Prefix and creating an invoice yields a number starting with that prefix — currently fails. `Playwright`
- [ ] A PATCH by tenant A's OPERATOR never mutates tenant B's SystemConfig rows. `Jest`

#### TEN-M10

- [ ] READ_ONLY blocks `POST /orders` (403 `READ_ONLY`) while `GET /orders` still returns 200. `Jest`
- [ ] READ_ONLY allows `POST /billing/subscribe` but blocks `POST /billing/addons/:sku/enable`. `Jest`
- [ ] A path merely containing the allowlisted substring is still blocked (anchored match). `Jest`
- [ ] A status change to SUSPENDED takes effect on the very next request (cache invalidated). `Jest`
- [ ] `DELETE /platform-admin/tenants/:id` on ACTIVE returns 400; on SUSPENDED it soft-deletes only. `Jest`

#### TEN-M11

- [ ] Every `/platform-admin/*` route rejects a TENANT_ADMIN token with 403. `Jest`
- [ ] A plan change updates Tenant and TenantSubscription in one transaction and emits a signed billing event. `Jest`
- [ ] Creating a second TENANT_ADMIN on a tenant that already has an active one returns 409. `Jest`
- [ ] Every mutating platform-admin call writes an AuditLog row keyed to the target tenant. `Jest`
- [ ] The plan picker is driven from the published plan catalog, not a hardcoded array (see gaps). `Playwright`

#### TEN-M12

- [ ] Given seeded finance rows in tenant A and B, `DELETE /settings/financial-data` from A leaves B's rows unchanged — currently fails. `Jest`
- [ ] `DELETE /settings/financial-data` from a bare OPERATOR returns 403 once narrowed to TENANT_ADMIN plus confirmation. `Jest`
- [ ] `DELETE /customers/all` refuses (409) while any PAID/PARTIAL invoice exists for the affected customers. `Jest`
- [ ] After any allowed bulk delete, remaining invoices still satisfy `total == sum(line subtotals) + tax`. `Jest`
- [ ] Every destructive bulk endpoint writes an AuditLog row with actor, tenant and row counts before commit. `Jest`

#### TEN-M13

- [ ] `POST /auth/verify-email` with a used or expired token is rejected and the account stays INACTIVE. `Jest`
- [ ] `POST /public/tenants/resend-verification` does not enumerate whether the address exists. `Jest`
- [ ] `GET /public/tenants/:slug/available` returns false for a reserved or taken slug. `Jest`

## Nice to have (P1)

| ID      | Capability                                                          | Status          | What it does                                                                                                                                | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------- | ------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TEN-N1  | Google Workspace sign-in, per tenant                                | SHIPPED ✅      | Staff sign in with Google using the tenant's own OAuth client; can link Google to an existing password account.                             | `auth.controller.ts:200,239,259,349,377,384`; `TenantGoogleOAuth` model (encrypted secret).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| TEN-N2  | Device list and new-device sign-in alert                            | SHIPPED ✅      | Sessions show device/IP/last-used; an unrecognised device triggers an email.                                                                | `auth.service.ts:170-196,322`; trust-proxy-aware IP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| TEN-N3  | Bring-your-own SMTP and verified sending domain                     | SHIPPED ✅      | Invoices/notifications send from the tenant's own address, with a connection test and DNS verification.                                     | `tenants.controller.ts:57,66,75`; `settings.controller.ts:227-355`; secrets via `EncryptionService`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| TEN-N4  | Remittance / how-to-pay details                                     | PARTIAL 🟡      | Bank, Zelle, cheque payee and instructions configured once, shown to buyers.                                                                | `settings.controller.ts:515,520`; `REMITTANCE_KEY` = `remittance.config`. verified: the block never actually appears on the invoice PDF or the buyer statement PDF (`invoice-pdf-template.tsx`, `statement-pdf-template.tsx` — zero matches for remit/bank fields); it is shown only in the buyer portal (`GET /buyer/remittance`, `apps/web/app/buyer/portal/[seller]/payments/page.tsx`, `apps/mobile/app/(customer)/payments.tsx`).                                                                                                                                                                                            |
| TEN-N5  | Document numbering continuity when migrating from an old system     | PARTIAL 🟡      | A tenant switching systems continues its existing invoice/estimate/credit-note/payment sequence.                                            | `NumberingService`; `GET/PUT /import/numbering`. NOT WIRED: `invoices.service.ts:2723` and `estimates.service.ts:253` never call `NumberingService` — see TEN-M9.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| TEN-N6  | Renaming the price tiers to the tenant's own vocabulary             | SHIPPED ✅      | Tiers relabelled (e.g. Wholesale/Retail/Club) for staff and customers.                                                                      | `settings.controller.ts:531,537`; `common/tier-label.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| TEN-N7  | Costing method and margin-floor configuration                       | SHIPPED ✅      | Tenant sets how cost is derived and the minimum margin that triggers a warning.                                                             | `settings.controller.ts:491,497`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| TEN-N8  | Per-user preferences that survive device changes                    | SHIPPED ✅      | Column choices and default filters follow the user, not the browser.                                                                        | `users.controller.ts:51,56`; `UserPreference` (`@@unique([userId,key])`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| TEN-N9  | Notification channel matrix and quiet hours                         | PARTIAL 🟡      | Per-event, per-channel control over customer notifications, with a nightly quiet window.                                                    | `NotificationsSettingsTab.tsx`; `messaging-config.service.ts:109-111`; `isQuietHours` (`messaging.helpers.ts:80`). verified: a per-tenant `MessagingSettings.timezone` column already exists and is written by `updateConfig` (`messaging-config.service.ts:239,246`) — `isQuietHours` simply ignores it and reads the server clock; fixing this does not require the broader tenant-timezone project in TEN-N15. The engine also still only computes the window and never withholds a send.                                                                                                                                      |
| TEN-N10 | Settings hub with grouped, searchable sections                      | PARTIAL 🟡      | One entry point grouping settings with a search box and quick chips.                                                                        | `SettingsHub.tsx` — six groups with hrefs. verified: the hub has no entry for branding/logo, document numbering, pricing-tier labels, or per-tenant Google OAuth — four configured capabilities it cannot reach.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| TEN-N11 | Time-boxed support impersonation                                    | PARTIAL 🟡      | Platform support signs in as a tenant's admin for a short window; session start is audited.                                                 | `platform-admin.service.ts:571 impersonate()` — 15-min token, no refresh, `IMPERSONATION_STARTED` AuditLog row. verified: `ImpersonationGuard` is not merely a logger — it is fully inert. `jwt.strategy.ts` `validate()` never copies `impersonatedBy` onto `req.user`, so the guard's `if (!user?.impersonatedBy) return true;` short-circuits on every request; nothing is logged and nothing is blocked. There is no impersonation write trail anywhere.                                                                                                                                                                      |
| TEN-N12 | Per-tenant feature toggles from the admin panel                     | SHIPPED ✅      | Platform staff turn individual capabilities on/off per tenant; apps hide/show accordingly.                                                  | `platform-admin.controller.ts:315,321,336`; `@RequireAddon` + `addon.guard.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| TEN-N13 | Tenant self-service plan change, add-ons and usage                  | SHIPPED ✅      | Tenant sees subscription/usage/recommendation and can subscribe, upgrade, downgrade, cancel, resume, buy add-ons.                           | `settings-billing.controller.ts`; `entitlements.service.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| TEN-N14 | Settings and team management on mobile                              | PARTIAL 🟡      | An owner running the business from a phone can edit contact details, tax rate, notifications and staff.                                     | `apps/mobile/app/(operator)/settings/index.tsx`. verified: mobile DOES have Branding and Integrations tabs (`:315` `TABS`), contrary to "not present" — but both are non-functional placeholders. `BrandingTab` shows a "Coming soon on mobile" card and falsely claims web colour changes "apply across the mobile app automatically" (no mobile screen reads `primaryColor`); `IntegrationsTab` advertises Xero, QuickBooks, Stripe, Shopify, Google Maps API and Twilio SMS as "Coming soon" with no backing code anywhere in the repo — a worse finding than a missing tab, since it promises integrations that do not exist. |
| TEN-N15 | Tenant timezone and reporting currency                              | MISSING ⬜      | A workspace declares its business-day timezone and trading currency; date buckets, quiet hours and money formats follow.                    | `TenantConfig.timezone`/`.currency` exist with defaults but no writer; PATCH `/settings` allowlist excludes both; `email.service.ts:867` hardcodes `en-US`/USD.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| TEN-N16 | Platform-admin Google sign-in                                       | NICE ✅ SHIPPED | A separate, platform-level Google OAuth realm lets super-admins sign in without a password, distinct from per-tenant staff Google sign-in.  | `platform-google-auth.controller.ts` — `GET /platform-admin/auth/google` (unguarded initiation), `.../google/link` (JwtAuthGuard); `apps/web/app/(auth)/platform/auth/callback/page.tsx`, `admin/login/page.tsx`.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| TEN-N17 | Bring-your-own Anthropic API key per tenant                         | NICE ✅ SHIPPED | A tenant supplies its own Anthropic key for the AI document scanner instead of using the platform's.                                        | `GET/PATCH /settings/anthropic` (`settings.controller.ts:198,212`), `SECRET_KEYS`-encrypted; editor at `settings/page.tsx:854-871`; surfaced in the hub as "Claude AI scanner".                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| TEN-N18 | Platform-level AI provider configuration, usage and connection test | NICE ✅ SHIPPED | Super-admins configure the AI provider, view usage, and test the connection platform-wide.                                                  | `platform-admin.controller.ts:353,359,365,374` — `GET/PATCH ai-config`, `GET ai-config/usage`, `POST ai-config/test`, behind `SuperAdminGuard`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| TEN-N19 | Tenant route/dispatch operating defaults                            | NICE ✅ SHIPPED | Depot location, average speed, service time and default route start time configured once for the tenant's operations.                       | `GET/PATCH /settings/route` (`settings.controller.ts:389,430`; `update-route-settings.dto.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| TEN-N20 | Per-tenant Stripe billing operations from the platform admin panel  | NICE ✅ SHIPPED | Super-admins view a tenant's Stripe billing, start checkout, open the billing portal, view pricing, and override a negotiated price.        | `platform-admin.controller.ts:257,263,273,280,288`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| TEN-N21 | Server-side Google Places proxy for address entry                   | NICE ✅ SHIPPED | Keeps the Google Maps key server-side and avoids CORS for address autocomplete across signup, settings and customer forms.                  | `public-places.controller.ts` — `public/places`, throttled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| TEN-N22 | Tenant-wide deposit and invoice-issue policy                        | NICE ✅ SHIPPED | A default deposit percentage, whether to collect it at order time, and whether to issue the mirror invoice at order placement vs. delivery. | `PATCH /settings/invoice` (`settings.controller.ts:466`) — `depositDefaultPercent`, `depositCollectAtOrder`, `hideOriginalPrice`, `defaultTerms` (`update-invoice-settings.dto.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### Testing criteria

#### TEN-N1

- [ ] A Google profile with `email_verified: false` is rejected; no user or session is created. `Jest`
- [ ] A redeemed exchange code cannot be replayed. `Jest`
- [ ] Linking Google clears `forcePasswordChange` but not the password column. `Jest`
- [ ] With `TenantGoogleOAuth.enabled=false`, the Google button is absent from that tenant's login page. `Playwright`

#### TEN-N2

- [ ] A login from an already-seen user-agent does not send the new-device email; a new one does. `Jest`
- [ ] `GET /auth/sessions` returns only the caller's own sessions. `Jest`
- [ ] A forged leading `X-Forwarded-For` entry does not change the recorded IP. `Jest`

#### TEN-N3

- [ ] `GET /settings/email` never returns the SMTP password in clear. `Jest`
- [ ] Saving an empty `smtpPassword` clears the stored secret. `Jest`
- [ ] `POST .../email/test` from a non-admin OPERATOR returns 403. `Jest`

#### TEN-N4

- [ ] The remittance block is added to the invoice PDF and buyer statement PDF templates so the promised "printed on invoices and statements" is true. `Playwright`
- [ ] A corrupt stored JSON value makes GET return `{}` rather than 500. `Jest`
- [ ] PATCH from a bare OPERATOR returns 403. `Jest`

#### TEN-N5

- [ ] Invoice, estimate, credit-note and payment minting are routed through `NumberingService.reserveNext`. `Jest`
- [ ] Two concurrent creations under the same tenant never collide on the same number. `Jest`
- [ ] An imported document keeps its original number and does not advance the sequence. `Jest`

#### TEN-N6

- [ ] With no labels configured, defaults render rather than blank chips. `Jest`
- [ ] A label set in tenant A does not appear for tenant B. `Jest`

#### TEN-N7

- [ ] A margin floor outside 0..100 is rejected. `Jest`
- [ ] The margin warning uses `roundMoney`'d cost and unit price, never an unrounded boxed-line product. `Jest`

#### TEN-N8

- [ ] A partial preferences PATCH merges rather than replaces. `Jest`
- [ ] A user cannot read or write another user's preferences. `Jest`

#### TEN-N9

- [ ] `isQuietHours` reads `MessagingSettings.timezone`, not the server clock. `Jest`
- [ ] A midnight-spanning window (21:00→07:00) correctly classifies 23:30 as quiet and 08:00 as not. `Jest`
- [ ] A message triggered inside the quiet window is actually withheld or deferred, not merely flagged. `Jest`

#### TEN-N10

- [ ] Branding, numbering, tier labels and Google OAuth each get an entry in the hub. `Playwright`
- [ ] Every hub href resolves to a rendered page for a tenant with all add-ons off. `Playwright`

#### TEN-N11

- [ ] `impersonatedBy` is copied onto `req.user` by the JWT strategy so `ImpersonationGuard` is no longer permanently inert. `Jest`
- [ ] A write made under impersonation records the acting super-admin id in AuditLog. `Jest`
- [ ] The impersonation token expires at 900s and cannot be refreshed. `Jest`

#### TEN-N12

- [ ] With an addon OFF, the gated endpoint returns 403 without naming an internal key. `Jest`
- [ ] `GET /tenants/me/addons` from a pure DRIVER returns 200. `Jest`
- [ ] Every `@RequireAddon` key has a UI path that can grant it. `Jest`

#### TEN-N13

- [ ] A mid-cycle upgrade charges exactly the previewed proration. `Jest`
- [ ] Every POST `/billing/*` mutation from a bare OPERATOR returns 403. `Jest`
- [ ] A tenant in READ_ONLY can still call `POST /billing/subscribe`. `Jest`

#### TEN-N14

- [ ] The mobile Branding tab either implements colour/logo editing or removes the false "applies automatically" claim. `manual`
- [ ] The mobile Integrations tab either implements one listed integration or drops the "Coming soon" list until it does. `manual`
- [ ] The tax-rate field rejects out-of-range values client-side before the request is made. `Jest (mobile)`

#### TEN-N15

- [ ] `PATCH /settings {timezone:"America/Chicago"}` persists and is read back. `Jest`
- [ ] An invalid IANA zone is rejected with 400. `Jest`
- [ ] Analytics day-buckets use the tenant's local day, not UTC or server-local. `Jest`

#### TEN-N16

- [ ] A platform Google sign-in mints only a SUPER_ADMIN-scoped token, never a tenant-scoped one. `Jest`

#### TEN-N17

- [ ] The stored Anthropic key is never returned in clear from `GET /settings/anthropic`. `Jest`

#### TEN-N18

- [ ] `POST /platform-admin/ai-config/test` from a TENANT_ADMIN returns 403. `Jest`

#### TEN-N19

- [ ] `PATCH /settings/route` with an out-of-range `averageSpeedKmh` is rejected. `Jest`

#### TEN-N20

- [ ] `PATCH .../billing/price-override` writes an audited change and does not bypass Stripe's own validation. `Jest`

#### TEN-N21

- [ ] The Google Maps key never appears in any response body reaching the browser. `Jest`

#### TEN-N22

- [ ] `depositDefaultPercent` outside 0..100 is rejected; `depositCollectAtOrder` changes where the deposit is captured. `Jest`

## Advanced / future (P2)

| ID      | Capability                                                                | Status              | What it does                                                                                                                                                     | Evidence                                                                                                                                                                                 |
| ------- | ------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TEN-A1  | Two-factor authentication for staff and admin accounts                    | MISSING ⬜          | A TOTP/SMS second factor on accounts that can move money or change prices, with recovery codes.                                                                  | Repo-wide grep for totp/mfa/otpauth/authenticator returns zero files.                                                                                                                    |
| TEN-A2  | Enterprise SSO (SAML/OIDC) with directory-driven deprovisioning           | MISSING ⬜          | A larger distributor signs in through its own IdP; removing someone from the directory removes access automatically.                                             | `flag.api_sso` documented as RESERVED, no implementation; no SSO model in the schema.                                                                                                    |
| TEN-A3  | Custom roles and granular permissions                                     | MISSING ⬜          | A tenant defines its own roles instead of squeezing everyone into OPERATOR.                                                                                      | No Permission/Role model in the schema; fixed `UserRole` enum only.                                                                                                                      |
| TEN-A4  | Tenant-visible activity and change log                                    | MISSING ⬜          | The owner can answer "who changed this / when" without contacting support.                                                                                       | `AuditLog` rows are captured but `apps/api/src/audit/` has no controller; only SUPER_ADMIN can read them.                                                                                |
| TEN-A5  | Tenant API keys and outbound webhooks                                     | MISSING ⬜          | A distributor connects its own tooling with a scoped, revocable key, and gets pushed events.                                                                     | No `ApiKey` model; only inbound Stripe webhooks exist.                                                                                                                                   |
| TEN-A6  | Business hours, holidays and delivery blackout calendar                   | MISSING ⬜          | The workspace knows when it is open and which dates cannot be scheduled.                                                                                         | Repo-wide grep for businessHours/holiday/openingHours returns zero files.                                                                                                                |
| TEN-A7  | Seat entitlement enforced when a seat is taken                            | PARTIAL 🟡          | Adding staff beyond the plan's included seats prompts an upgrade at the moment of the add, not months later.                                                     | Read-side entitlement exists (`entitlements.service.ts:14`); enforcement exists only at scheduled downgrade (`billing-cron.service.ts:118-162`); `createOperator` performs no cap check. |
| TEN-A8  | Self-service workspace data export and deletion                           | PARTIAL 🟡          | An owner can pull a complete copy of the workspace and request deletion with a stated retention window.                                                          | Only `GET /billing/export` exists; deletion is admin-only, soft, and requires SUSPENDED status first (`platform-admin.service.ts:336`).                                                  |
| TEN-A9  | Consent-based, scoped and fully attributed impersonation                  | MISSING ⬜          | Support access the tenant can see and approve: read-only default, explicit escalation, per-write attribution.                                                    | Current model is all-or-nothing and, per TEN-N11, the write-tracking guard is fully inert, not merely non-blocking.                                                                      |
| TEN-A10 | One person, several workspaces, one identity                              | MISSING ⬜          | An owner with a live and a demo workspace, or a bookkeeper across several distributors, switches without re-entering a slug.                                     | `User` is `@@unique([tenantId, email])`; JWT pins a single tenant; no workspace switcher.                                                                                                |
| TEN-A11 | Developer mode / staged rollout of in-progress surfaces                   | SHIPPED ✅          | Ship an unfinished capability to exactly one willing tenant for end-to-end production exercise.                                                                  | `DEVELOPER_MODE_ADDON`; `scripts/enable-developer-mode.mjs` (dry-run default, `assertTestTenant`-gated).                                                                                 |
| TEN-A12 | Per-tenant security policy (password rotation, session TTL, IP allowlist) | MISSING ⬜          | A compliance-obligated tenant sets its own rotation cadence, session lifetime and admin IP allowlist.                                                            | Lockout threshold, refresh TTL, throttle and complexity are all global constants with no per-tenant override.                                                                            |
| TEN-A13 | Cross-tenant buyer directory and duplicate-buyer merge view               | ADVANCED ✅ SHIPPED | Platform staff view a buyer directory and a duplicate-buyer merge summary spanning tenant boundaries — the one place a buyer identity is visible across tenants. | `platform-admin-buyers.controller.ts` — `GET /platform-admin/buyer-directory` (`:19`), `GET /platform-admin/buyer-merge-summary` (`:41`), `SuperAdminGuard`; web panel `admin/buyers/`.  |

### Testing criteria

#### TEN-A1

- [ ] A TOTP challenge blocks token issuance until a valid code is presented. `Jest`
- [ ] Recovery codes are hashed, single-use, and consuming one revokes every live refresh token. `Jest`

#### TEN-A2

- [ ] An IdP assertion for an unclaimed domain is rejected. `Jest`
- [ ] A SCIM deprovision event suspends the user and revokes refresh tokens within one request cycle. `Jest`

#### TEN-A3

- [ ] A custom role granting `orders:read` but not `products:write` is enforced at exactly that granularity. `Jest`
- [ ] A role cannot self-grant the permission to edit roles. `Jest`

#### TEN-A4

- [ ] `GET /audit-logs` as TENANT_ADMIN returns only that tenant's rows. `Jest`
- [ ] A price change records the old and new value, not just the route called. `Jest`

#### TEN-A5

- [ ] An API-key-authenticated request resolves the same tenant scoping as a JWT. `Jest`
- [ ] A read-only key cannot reach any destructive endpoint. `Jest`

#### TEN-A6

- [ ] Scheduling on a configured closure date is refused and creates no run. `Jest`
- [ ] An order after cut-off rolls to the next open day, skipping closures. `Jest`

#### TEN-A7

- [ ] A tenant at its seat cap gets a grace window on the next hire, never a hard failure. `Jest`
- [ ] Suspending a user frees a seat immediately. `Jest`

#### TEN-A8

- [ ] A workspace export excludes every other tenant's rows and ids. `Jest`
- [ ] A tenant-initiated deletion enters a reversible pending state before purge. `Jest`

#### TEN-A9

- [ ] A read-only impersonation token gets 200 on GET, 403 on every mutation. `Jest`
- [ ] Every impersonated write carries both the impersonated and acting ids. `Jest`

#### TEN-A10

- [ ] A workspace switch mints a token scoped only to a workspace the identity actually belongs to. `Jest`
- [ ] Password reset for a multi-workspace identity resolves unambiguously (closes the TEN-M4 defect). `Jest`

#### TEN-A11

- [ ] `developer_mode` alone does not satisfy the recurring-routes or order-delivery client gates. `Jest`
- [ ] `enable-developer-mode.mjs` refuses a non-approved slug without `--live-tenant-override` plus type-back confirmation. `manual`

#### TEN-A12

- [ ] A tenant-configured rotation policy forces password change past its window. `Jest`
- [ ] A tenant IP allowlist refuses admin sign-in from outside it, audited with the real client IP. `Jest`

#### TEN-A13

- [ ] The buyer directory never surfaces a buyer's raw credentials or payment details. `Jest`
- [ ] A merge action is reversible or requires explicit confirmation before combining two buyer records. `Jest`

## How this varies by tenant

| Variation                                                                                                                                        | Mechanism                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Which feature surfaces exist at all (regulated pack, MSRP, sales agents, driver payments, recurring routes, order delivery, OCR, developer mode) | `TenantAddon` rows toggled by platform admin; enforced via `@RequireAddon` + `addon.guard.ts`.                                                                                                   |
| Which plan-tier features a tenant is entitled to                                                                                                 | `PlanVersion → PlanDefinition.featureFlags` resolved by `entitlements.service.ts`; gated by `@RequirePlanFlag`.                                                                                  |
| Whether plan-flag gating is enforced at all                                                                                                      | Global env `PLAN_FLAG_ENFORCEMENT`, default "off". **NOT PER-TENANT** — a single switch flips every tenant at once.                                                                              |
| How many staff seats are included                                                                                                                | `PlanDefinition.seatsIncluded` + `SEAT_EXTRA` addon quantity. Enforced only at scheduled downgrade — **NOT CONFIGURABLE AS A LIMIT AT ADD TIME**.                                                |
| Business identity on documents                                                                                                                   | `TenantConfig.{businessName, logoKey, primaryColor, addressLine1, city, state, zip, phone, invoiceNotes, invoiceTerms}`.                                                                         |
| Sales-tax percentage                                                                                                                             | `SystemConfig` key `settings.taxRate` per `(tenantId, key)`.                                                                                                                                     |
| Outbound email identity                                                                                                                          | `TenantConfig.smtp*` + sending-domain endpoints; secrets encrypted at rest.                                                                                                                      |
| Federated login (Google)                                                                                                                         | `TenantGoogleOAuth` (clientId/clientSecret/callbackUrl/enabled).                                                                                                                                 |
| Remit-to / how-to-pay block                                                                                                                      | Single JSON document under `remittance.config`, shown only in the buyer portal today (see TEN-N4).                                                                                               |
| Vocabulary for price tiers and margin floor                                                                                                      | `pricing-tier-labels` / `margin` settings, resolved by `common/tier-label.ts`.                                                                                                                   |
| Document number series                                                                                                                           | `NumberingSequence` per `(tenantId, docType)` — configured but **not honoured** at minting time (see TEN-M9).                                                                                    |
| Business timezone and trading currency                                                                                                           | **NOT CONFIGURABLE** — `TenantConfig.timezone`/`.currency` have defaults and no writer; messaging quiet hours has its own separate, writable timezone column.                                    |
| Length of the free trial                                                                                                                         | **NOT CONFIGURABLE** — hardcoded 14 days on self-service signup, 7 days on admin-created tenants; movable only via `extend-trial`.                                                               |
| Which plans a platform admin can actually assign                                                                                                 | **NOT CONFIGURABLE and INCOMPLETE** — the admin picker offers STARTER/PROFESSIONAL/ENTERPRISE, which map through legacy aliases to STARTER/SCALE/ENTERPRISE; GROWTH is unassignable from any UI. |
| Set of roles a tenant can assign                                                                                                                 | **NOT CONFIGURABLE** — fixed `UserRole` enum; `updateUser` permits only OPERATOR or DRIVER.                                                                                                      |
| Password complexity, lockout threshold, session lifetime, login throttle                                                                         | **NOT CONFIGURABLE** — global constants shared by every tenant.                                                                                                                                  |
| Quiet hours for customer notifications                                                                                                           | Per-tenant `MessagingSettings.timezone` is stored and writable, but `isQuietHours` still evaluates against the server clock — the setting is captured, not applied.                              |

## Gaps for a great UX

| Severity | Gap                                                                                                                                   | Impact                                                                                                                                                                                                                                                                                                                                                                            | Suggested direction                                                                                                                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CRITICAL | `DELETE /api/v1/settings/financial-data` destroys every tenant's finance tables from any operator token                               | Ten unscoped `deleteMany({})` calls on the raw Prisma client wipe invoices, payments, credit notes, vendor bills and purchase orders platform-wide. No confirmation, no admin narrowing, no UI caller — one curl call from any staff account of any tenant to unrecoverable, cross-tenant data loss.                                                                              | Delete the endpoint, or rebuild it scoped via `forTenant()`, `@Roles(TENANT_ADMIN)`, typed-back slug confirmation, `assertTestTenant` unless explicitly overridden, a pre-flight count preview, and an AuditLog write before commit.       |
| CRITICAL | No second factor anywhere, on accounts that can move money                                                                            | A stolen or reused password is complete account takeover — invoices, payments, price lists, staff accounts. Only defence today is the 10-attempt lockout and per-IP throttle.                                                                                                                                                                                                     | Add TOTP enrolment with hashed recovery codes and a challenge step in login; make it a tenant-configurable requirement for TENANT_ADMIN and finance-surface roles.                                                                         |
| CRITICAL | `DELETE /api/v1/customers/all` can destroy paid invoices and their payments                                                           | `deleteAllCustomers()` cascades with no status filter through `InvoicePayment → Invoice → CreditNote → Order`. It is tenant-scoped (unlike the endpoint above), but the front-end hook that would call it (`useDeleteAllCustomers`) has no callers in the product today — it is currently dead, not live, though the server route itself is still reachable directly.             | Refuse (409) while any affected invoice is PAID/PARTIAL, or require explicit acknowledgement plus TENANT_ADMIN; show exact row counts before confirming; either wire the hook with these guards or remove it.                              |
| HIGH     | Password reset resolves the wrong workspace when one email exists in several tenants                                                  | `requestPasswordReset` does an unscoped `findFirst` on email against a `(tenantId,email)`-unique column, so the reset link can silently land on the wrong account and revoke the wrong sessions.                                                                                                                                                                                  | Thread the resolved tenant (from `TenantResolutionMiddleware` or an explicit form field) into the lookup; when ambiguous with no workspace given, email a workspace chooser.                                                               |
| HIGH     | Impersonation is not merely under-logged — it is fully inert                                                                          | `jwt.strategy.ts` never copies `impersonatedBy` onto `req.user`, so `ImpersonationGuard`'s check always short-circuits to allow, and nothing about impersonated writes is ever logged or blocked. Only the session start is on the tenant's own audit trail.                                                                                                                      | Propagate `impersonatedBy` through the JWT strategy; add it to the AuditLog write in the interceptor; add a tenant-visible list of support sessions; then build a read-only default with explicit, separately-audited escalation to write. |
| HIGH     | Suspending a user does not revoke their live sessions                                                                                 | `changeStatus` updates only `status`; nothing deletes the user's `RefreshToken` rows, and nothing else in the codebase does either. With a 30-day refresh TTL, a suspended user can keep working for up to 30 days on an existing session. Confirmed by direct code reading, not merely suspected.                                                                                | Delete every RefreshToken for the user in the same transaction as the status change, the way the password-reset path already does; re-check user status on refresh rather than trusting the JWT claim.                                     |
| HIGH     | The tenant cannot read its own audit trail                                                                                            | `AuditLog` rows are captured for every mutation but `apps/api/src/audit/` has no controller; only `SUPER_ADMIN` endpoints can read them, and rows carry no before/after values.                                                                                                                                                                                                   | Add `GET /api/v1/audit-logs` (`@Roles(TENANT_ADMIN)`) scoped via `forTenant()`; start recording a small before/after diff on price, credit limit, tax rate, role/status and invoice-void changes.                                          |
| HIGH     | Timezone and currency are dead columns                                                                                                | `TenantConfig.timezone`/`.currency` can never be anything but the defaults, so analytics day-buckets, on-time calculations and email money formatting are silently wrong for any tenant outside US Eastern/USD. Quiet hours has a _separate_, writable timezone column that is simply ignored — cheaper to fix first.                                                             | Add both fields to the settings allowlist with IANA/ISO-4217 validation; wire quiet hours to its existing per-tenant timezone column immediately, independent of the larger tenant-timezone project.                                       |
| HIGH     | The configured invoice number prefix and payment-due days never reach the database at all                                             | Both fields are collected by the Invoice Numbering card and PATCHed to `/settings`, but neither is in the allowlist or the TenantConfig map and neither is returned by GET — they blank on every reload. Separately, the fallback minting path scans invoice numbers across all tenants via the raw unscoped client.                                                              | Add both fields to the settings allowlist/DTO; route minting through `NumberingService.reserveNext` at `SERIALIZABLE`; make the fallback scan go through `forTenant()`.                                                                    |
| MEDIUM   | Adding staff is free and invisible to billing                                                                                         | `createOperator` performs no seat-cap check; `UsersModule` imports no `MeterService`. Overage is only caught at a downgrade, months later.                                                                                                                                                                                                                                        | Consult `EntitlementsService`/`MeterService` in `createOperator`; over cap opens a grace window and prompts an upgrade rather than blocking the hire.                                                                                      |
| MEDIUM   | Adding a team member has no invite flow — the temp password is returned in the API response                                           | The admin relays it over WhatsApp or reads it aloud; there is no signal on whether the person ever activated.                                                                                                                                                                                                                                                                     | Send an invite email with a single-use, short-TTL activation link (reuse the password-reset token machinery); keep the temp-password path only as an explicit fallback.                                                                    |
| MEDIUM   | Several destructive team-management endpoints are not actually admin-narrowed                                                         | `PATCH /users/:id/status`, `POST /users/:id/reset-password` and `PATCH /users/:id/driver-permit` are gated only `@Roles(OPERATOR)` — any operator can suspend a colleague, force-reset their password, or grant a driver permit. Only `PATCH /users/:id/admin` is re-checked in the service layer.                                                                                | Narrow the highest-blast-radius team endpoints to `@Roles(TENANT_ADMIN)`, starting with status changes and password resets.                                                                                                                |
| MEDIUM   | Every non-admin office worker is squeezed into one wide OPERATOR role                                                                 | A picker, a phone-order clerk and a bookkeeper get identical access, including the bulk-delete endpoints and cost/margin reads.                                                                                                                                                                                                                                                   | Short term, narrow the highest-risk endpoints as above. Medium term, introduce a small named-permission layer mapped onto the existing roles.                                                                                              |
| MEDIUM   | Mobile is the primary operator surface but carries a fraction of the settings, and two of its tabs promise features that do not exist | Branding, SMTP, remittance, numbering, tier labels, costing, regulated sections, import and billing are web-only. Worse: mobile's Branding tab falsely claims web colour choices "apply automatically" and its Integrations tab lists six named third-party integrations (Xero, QuickBooks, Stripe, Shopify, Google Maps, Twilio) as "Coming soon" with no backing code anywhere. | Port branding and remittance to mobile first; either build one listed integration or remove the list; correct the false "applies automatically" copy immediately regardless of build order.                                                |
| MEDIUM   | GROWTH is not just hard to reach from the admin plan picker — it is unassignable                                                      | The picker offers STARTER/PROFESSIONAL/ENTERPRISE, and the legacy-enum mapping (`TEAM→GROWTH`, `PROFESSIONAL→SCALE`) means those three options actually resolve to STARTER/SCALE/ENTERPRISE. No admin action can place a tenant on GROWTH.                                                                                                                                        | Drive the picker from the published `PlanVersion` definitions instead of a hardcoded array so it can never drift from the catalog.                                                                                                         |
| MEDIUM   | Quiet hours compute a window but never withhold a message                                                                             | The engine only computes whether "now" is quiet; it does not defer or block a send, and — see the HIGH item above — it also isn't reading the tenant's own configured timezone yet.                                                                                                                                                                                               | Wire a defer/release queue so a send inside the window is actually held, and read the existing per-tenant timezone while doing it.                                                                                                         |
| MEDIUM   | Plan-flag enforcement is a single global env switch                                                                                   | `PLAN_FLAG_ENFORCEMENT` defaults "off", so most plan gates are inert in production for every tenant at once; there is no way to stage the rollout tenant by tenant.                                                                                                                                                                                                               | Make enforcement resolvable per tenant (a subscription column or entitlement key) so it can be switched on gradually, then retire the env switch.                                                                                          |
| LOW      | The suspended-tenant status cache is per-process                                                                                      | `TenantStatusGuard` caches status for 60s; on a multi-instance deployment an `invalidate()` on one instance leaves others serving a suspended tenant for up to the TTL.                                                                                                                                                                                                           | Move the cache to Redis or publish an invalidation event over the existing Socket.io/Redis channel.                                                                                                                                        |
| LOW      | Two separate super-admin login routes exist                                                                                           | `admin/login` and `admin-login` both exist as separate pages, inviting drift between them.                                                                                                                                                                                                                                                                                        | Keep one; make the other a redirect stub.                                                                                                                                                                                                  |

## Cross-domain handoffs

- **Billing & Plans** — `EntitlementsService.resolve()` turns this domain's Tenant/TenantSubscription/TenantAddon rows into the flags/addons/seats every other domain gates on; a plan or addon change must call both `EntitlementsService.invalidate(tenantId)` and `TenantStatusGuard.invalidate(tenantId)`.
- **Billing & Plans** — `TenantStatusGuard`'s READ_ONLY allowlist deliberately keeps `/billing/subscribe` and `/billing/subscription*` open; any change to billing's route shape must be mirrored in that anchored allowlist.
- **Orders / Invoices / Finance** — `TenantConfig` supplies branding and address fields to invoice and statement PDFs, and `settings.taxRate` feeds `common/tax-rate.ts`; a settings write must invalidate cached invoice PDFs.
- **Orders / Invoices** — document numbering is owned here (`NumberingSequence`) but minted in the invoices/estimates modules; the handoff is currently broken and must be closed at the minting side.
- **Dispatch, Deliveries & Drivers** — the whole dispatch surface is addon-gated from here (`@RequireAddon` on routes/route-runs/drivers/trips); every web/mobile query on those endpoints must key off the same composed access hook.
- **Drivers** — `canActAsDriver` is set here and minted into the JWT at login, so a permit change does not take effect until the user signs in again.
- **Customers & Buyer Portal** — buyer identity is a parallel realm (`BuyerAccount`, `type:"buyer"` refresh tokens); the two realms share the refresh endpoint shape and must keep rejecting each other's tokens.
- **Customers & Buyer Portal** — `GET /public/tenants/:slug/branding` and `/logo` are unauthenticated and feed the buyer login screen and customer-facing PDFs.
- **Messaging & Notifications** — the notification channel matrix and quiet hours are configured through the settings hub but owned by `messaging-config.service.ts`, which already carries its own per-tenant timezone column that quiet hours does not yet read.
- **Import & Migration** — the import hub depends on this domain for numbering continuity and for the tenant scoping of every staged/committed row.
- **Email** — outbound identity (SMTP, from-address, sending domain) is configured here and consumed by every transactional send; secrets round-trip through `SystemConfigService`'s encryption.
- **Analytics & Bookkeeping** — day-bucketing and on-time calculations need the tenant's business timezone, which this domain currently cannot supply.
- **Audit** — `AuditInterceptor` writes for every mutation in every domain, keyed on the JWT's tenantId and sub; the impersonation-attribution gap and the absent tenant-facing reader are this domain's to close.
- **Platform operations** — `scripts/lib/test-tenants.cjs` `assertTestTenant` gates which tenant slugs any script, seed, QA run or cleanup may write to; every tenant-scoped entry point across all domains must call it before its first write.

## What we could not verify

- Whether the actual production values of `PLAN_FLAG_ENFORCEMENT`, or any live tenant's addon rows, differ from the documented defaults — only the code path and default were read.
- Runtime behaviour of the settings tabs and the platform-admin panel beyond source inspection — no Playwright run was executed as part of this pass.
- Whether any live tenant's invoice numbers have already been affected by the cross-tenant fallback scan in `generateInvoiceNumber` — would require a read-only production query.
- The full downstream blast radius of narrowing `PATCH /users/:id/status`, `POST /users/:id/reset-password` and `PATCH /users/:id/driver-permit` to `TENANT_ADMIN` — confirmed as currently OPERATOR-reachable, but no audit of existing tenant workflows that may rely on that breadth was performed.
- Severity ratings remain a judgement of business impact, not a scored model.
