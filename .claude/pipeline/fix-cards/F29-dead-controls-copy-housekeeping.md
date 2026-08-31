# F29 · Dead controls, copy and housekeeping

**Bug IDs (14):** B03, B05, B06, B07, B22, B36, B38, B39, B173, B174, B178, B179, B184, B187

**Root cause:** A deliberate final sweep of low-severity, low-coupling entries: the demo form that submits nowhere (B06), password rules that disagree across forms (B03), branding copy pointing at a control that does not exist (B05), drivers that cannot be deactivated (B36), unread nav.* translation keys (B178), the GPS breadcrumb table with no retention job (B184), and the impersonation-timeout residual (B173, deliberately deferred here from F14).

**Ships as:** One PR. Each is independently small; batching them avoids fourteen merge windows.

**Files:** per-bug single-file locations across web, mobile and API (see the register's own evidence per ID)

**Together because:** No shared hot file or root cause — batched purely as the campaign's low-coupling tail.

**Guardrails / shared infra:** None new. No lane conflicts — freely parallel.

**Dependencies / lane notes:** None (B173 deliberately deferred here from F14 by the plan).

---

## Proof-tier assignment (frozen at seed — see plan's Phase 2 and `.claude/campaign/status/F29.jsonl`)

| ID   | Tier | Hunt-round SHA | Citation status              |
| ---- | ---- | -------------- | ---------------------------- |
| B03  | T1   | 2d0270fd       | MOVED (disambiguate in-file) |
| B05  | T3   | 2d0270fd       | NO_TOKEN_UNVERIFIED          |
| B06  | T2   | 2d0270fd       | NO_TOKEN_UNVERIFIED          |
| B07  | T3   | 2d0270fd       | OK                           |
| B22  | T3   | 2d0270fd       | NO_TOKEN_UNVERIFIED          |
| B36  | T2   | 2d0270fd       | OUT_OF_BOUNDS                |
| B38  | T3   | 2d0270fd       | NO_TOKEN_UNVERIFIED          |
| B39  | T3   | 2d0270fd       | NO_TOKEN_UNVERIFIED          |
| B173 | T3   | 0b2c3a0a       | OUT_OF_BOUNDS                |
| B174 | T2   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED          |
| B178 | T2   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED          |
| B179 | T2   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED          |
| B184 | T1   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED          |
| B187 | T2   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED          |

> T1 = jest spec (api or mobile pure-logic) · T2 = Playwright e2e, web-visible (proven-pending-deploy through the PR, per the plan) · T3 = recorded manual check (forbidden for Critical/High — none here are). See `.claude/campaign/citation-reanchor-log.md` for any bug ID flagged above whose citation needs a discovery-time check before trusting it verbatim.

---

## Bug details — register triple, evidence and suggested fix, pasted verbatim

### B03 — Password rules disagree between forms

**Area:** Accounts · web + API

**Meant to do:** Enforce one consistent password-strength policy across every place a staff or buyer user sets or changes their password, so a password valid at one point stays valid everywhere.

**Actually does:** Web staff self-signup's client-side zod schema requires only uppercase + digit (apps/web/app/(auth)/signup/page.tsx:30-34); staff reset-password, buyer signup, and buyer change-password server DTOs all require uppercase + lowercase + (digit or symbol) via the same regex.

**The gap:** A password like "PASSWORD1" passes signup (no lowercase required) but is rejected by reset-password/buyer flows (lowercase required) — inconsistent, confusing policy.

**Evidence:** apps/web/app/(auth)/signup/page.tsx:30-34 (client regex, uppercase+digit only); apps/api/src/auth/dto/reset-password.dto.ts:16, apps/api/src/buyer/dto/buyer-register.dto.ts:18, apps/api/src/buyer/dto/buyer-change-password.dto.ts:22 (all `/^(?=.*[a-z])(?=.*[A-Z])(?=.*[\d\W])/`).

**Suggested fix:** Extract one shared password-policy regex/message (mirrored client+server per the money-math-mirror pattern) and apply it uniformly to signup, reset, and change-password everywhere.

### B05 — Branding tab points to a colour control that doesn’t exist

**Area:** Settings / branding · mobile + web

**Meant to do:** Tell mobile operators where to go to customize their brand colour, and have that place actually let them set it.

**Actually does:** Mobile Branding tab says colours are 'configured in the operator web portal.' The tenant-facing web settings page (apps/web/app/(dashboard)/settings/page.tsx) only has a logo-upload control — no primaryColor field anywhere in it. The only place tenant.primaryColor appears in a UI is platform-admin's tenant detail page, as a read-only swatch+hex `<dd>` with no input/onChange.

**The gap:** Following the mobile app's instruction to the web portal leads nowhere — there is no tenant-facing color picker; only an internal, read-only platform-admin view exists.

**Evidence:** apps/mobile/app/(operator)/settings/index.tsx:241-243 (claim text); apps/web/app/(dashboard)/settings/page.tsx (grep for primaryColor: 0 hits; only logoUrl/logo upload ~lines 111-313); apps/web/app/(platform-admin)/admin/tenants/[id]/page.tsx:489-499 (read-only display, no form control).

**Suggested fix:** Either ship a tenant-facing brand-colour picker in web settings (near the logo uploader) or update the mobile copy to say it's not yet available instead of pointing to a non-existent web control.

### B06 — “Request a Demo” form goes nowhere

**Area:** Marketing site · web

**Meant to do:** Let a prospective customer submit a 'Book a Demo' request (name, email, company, fleet size) that reaches the RouteFlow sales team.

**Actually does:** The `<form>` has no `onSubmit` handler and no `action` attribute; every input is uncontrolled (no `value`/`onChange`, no component state at all); the submit button is a plain `type="submit"` with no wiring.

**The gap:** Clicking 'Request a Demo' does a client-side no-op form submission — no network request, no data captured, no confirmation state — while the page implies 'we usually reply within one business day.'

**Evidence:** apps/web/app/contact/page.tsx:46 (`<form className="space-y-6">`, no onSubmit/action), :108-113 (submit button, no handler), whole file has zero useState/useForm usage.

**Suggested fix:** Wire the form to a real submission path (POST to an API route or a lead-capture service) with client state, validation, and a success/error UI.

### B07 — Integrations tab is all “coming soon”

**Area:** Settings · mobile

**Meant to do:** Show operators which third-party integrations exist and, presumably, offer a way to connect them once available.

**Actually does:** IntegrationsTab renders a static INTEGRATIONS array (Xero, QuickBooks, Stripe, Shopify, Google Maps API, Twilio SMS) each with a permanent 'Coming soon' badge; no row has an onPress or any connect action.

**The gap:** None beyond what's stated — the tab is transparently labeled as unimplemented for every listed integration; there is no hidden/broken connect path to fix.

**Evidence:** apps/mobile/app/(operator)/settings/index.tsx:270-311 (INTEGRATIONS array + IntegrationsTab, comingSoonBadge always rendered, no onPress anywhere in the map).

**Suggested fix:** No functional fix needed since it's honestly labeled; if these are on the roadmap, add real connect flows only when a given integration ships.

### B22 — Return photos are wired but unofferable

**Area:** Returns · all clients

**Meant to do:** Operators/drivers should be able to attach photos as evidence when filing a return, using Return.photoUrls.

**Actually does:** Return.photoUrls is a real column and create() persists dto.photoUrls when sent, but no UI (web modal, mobile operator new.tsx, mobile driver return screen) offers any photo capture control.

**The gap:** A working server-side field stays permanently empty because no client ever populates it.

**Evidence:** apps/api/prisma/schema.prisma:2645; apps/api/src/returns/returns.service.ts:130 (`photoUrls: dto.photoUrls ?? []`); apps/mobile/lib/api/returns.ts:106; grep photo/camera/image across apps/web/.../returns/_, apps/mobile/.../returns/_, driver return/index.tsx = no matches

**Suggested fix:** Add an image-picker step to the driver return flow (most natural capture point) wired to dto.photoUrls via the existing uploads/storage service.

### B36 — Drivers can’t be deactivated

**Area:** Drivers · web + mobile

**Meant to do:** An operator should be able to deactivate (or reactivate) a driver account from the web dashboard, e.g. when a driver leaves or is suspended.

**Actually does:** useChangeDriverStatus (apps/web/lib/api/drivers.ts:99-106, PATCH /drivers/:id/status) is defined but has zero callers anywhere in apps/web or apps/mobile; the driver edit modal (EditDriverModal.tsx) has no status field either, so no UI path can change a driver's ACTIVE/INACTIVE status.

**The gap:** Drivers list/detail pages only display and filter on status (drivers/page.tsx, drivers/[id]/page.tsx) — there is no button/toggle that invokes the mutation, so a driver can never be deactivated from the UI.

**Evidence:** Grep 'useChangeDriverStatus' over apps/ -> only the definition file. apps/web/app/(dashboard)/drivers/_components/EditDriverModal.tsx has no 'status' field. apps/mobile has a separate, unrelated /users/:id/status toggle (lib/api/admin.ts:1216 useToggleUserStatus) for app users, not drivers.

**Suggested fix:** Add a Deactivate/Activate action (e.g. a status toggle or dropdown item) on the driver detail page that calls useChangeDriverStatus, mirroring the pattern used for customers/users.

### B38 — Driver Cash tab is a placeholder

**Area:** Driver app · cash

**Meant to do:** Driver should be able to reconcile total cash/cheque/card collected across the whole day's runs against their manifest at end of shift.

**Actually does:** apps/mobile/app/(driver)/cash.tsx renders a hardcoded empty state ("End-of-day cash-up is coming soon") with a comment stating no /driver/cash-up endpoint or denomination-tracking schema exists.

**The gap:** No end-of-day, cross-run cash reconciliation exists; only a per-run settlement screen (apps/mobile/app/(driver)/route/settlement.tsx) reconciles cash for a single completed run, not the full day.

**Evidence:** apps/mobile/app/(driver)/cash.tsx:7-23 (placeholder + comment); apps/mobile/app/(driver)/route/settlement.tsx exists as the per-run counterpart.

**Suggested fix:** Either remove the Cash tab until end-of-day cash-up ships, or build the aggregation endpoint + UI to sum per-run settlements into a daily reconciliation.

### B39 — Pick &amp; Load is a placeholder

**Area:** Warehouse · mobile

**Meant to do:** Warehouse staff should be able to scan/verify picked items against a route's manifest before it goes out for delivery.

**Actually does:** apps/mobile/app/(operator)/pick.tsx renders a hardcoded empty state ("Pick & load isn't live yet") with a comment confirming no /routes/:id/picks endpoint or barcode-scan flow exists; reachable via a real nav entry in the More tab.

**The gap:** The feature is entirely unimplemented (no backend, no scan flow) but is discoverable/tappable from the operator More menu, which could confuse staff looking for warehouse verification.

**Evidence:** apps/mobile/app/(operator)/pick.tsx:8-29 (placeholder + comment); nav entry apps/mobile/app/(operator)/(tabs)/more.tsx:208-210 (title "Pick & load", onPress router.push("/(operator)/pick")).

**Suggested fix:** Either hide the More-menu entry behind a feature flag until Pick & Load ships, or build the /routes/:id/picks endpoint + scan UI.

### B173 — An impersonation timeout bounces the admin silently and leaves the tenant cookie set

**Area:** Impersonation exit · web

**Meant to do:** An impersonation session that times out restores the super admin's own identity and chrome and says what happened, the way the explicit Exit button does.

**Actually does:** Both auto-exit paths clear only the impersonation keys — the tenant-slug cookie survives, so brand colour variables and the tenant header stay applied — and the expired marker appended to the redirect has no reader anywhere.

**The gap:** Automatic exit was never brought up to the manual Exit button's shape, so it half-restores the session and explains nothing.

**Evidence:** apps/web/lib/api-client.ts:105-112 (the expired branch clears impersonation but not the tenant cookie) and :189-198 (the 401 branch, same omission); apps/web/app/(dashboard)/layout.tsx:979-987 (manual exit does clear it first); grep for the expired marker across apps/web returns exactly two writers and zero readers; apps/web/components/tenant-provider.tsx:46-54 (the cookie fallback), with layout.tsx:981-983's own comment confirming a super-admin session carries no slug to self-heal from; apps/web/lib/impersonation.ts:19-27 (parseExp now base64url-normalizes, so the expired path is genuinely reachable).

**Suggested fix:** Call clearTenantCookie() alongside clearImpersonation() in both auto-exit paths so they match the Exit button, and either read the expired marker on the tenants page to show a "your impersonation session expired" banner or drop the marker.

### B174 — A driver's only web nav item opens the operator Routes console, half of which 403s

**Area:** Driver navigation · web

**Meant to do:** A DRIVER signing in on web clicks "My Routes" — the single content item in their nav — and gets their assigned runs on a page built for them.

**Actually does:** They get the operator console. The active-runs panel is driver-scoped and does work, but the templates panel shows a permanent red error, a hidden drivers query 403s, and operator-only controls render.

**The gap:** The driver's landing page was never given a role branch, and the driver-scoped my-runs page is never linked for the DRIVER role.

**Evidence:** apps/web/app/(dashboard)/layout.tsx:170-172 (the nav item points at /routes), :182-188, :211-227 (my-runs is spliced in only for operators who can act as drivers), :273-287; apps/web/app/(dashboard)/routes/page.tsx contains zero occurrences of role, useAuth or DRIVER, :329-330 (the templates query), :82 (the drivers query inside a modal that is always mounted at :596-600, so it fires on every load), :571-575 (the error state); apps/api/src/routes/routes.controller.ts:51-55 and apps/api/src/drivers/drivers.controller.ts:41-44 (both operator-only); roles.guard.ts:22.

**Suggested fix:** Branch the routes page on role: render the my-runs view (or redirect to it) for DRIVER, and skip the templates and drivers queries and the operator-only controls for that role.

### B178 — nav.* translation keys exist in both locales but no code ever reads them

**Area:** Web shell · sidebar navigation

**Meant to do:** Switching Language to Español translates the sidebar nav, which is exactly what the nav.* keys were authored for.

**Actually does:** The three nav definitions hardcode English label literals and the renderer prints those literals; the four nav.* keys have zero read sites in the entire web tree.

**The gap:** Keys shipped in both locale tables when the i18n foundation landed and were never wired to the shell that owns them.

**Evidence:** apps/web/lib/i18n/messages.ts:62-65 (en) and :108-111 (es); grep for the four keys across apps/web returns only those 8 definition lines and no call site; apps/web/app/(dashboard)/layout.tsx:86,89,107,149 (operator nav literals), :154,157,165, :170,172, :406 and :486 (the renderer prints item.label / group.label); git log -S shows the keys were introduced in the i18n foundation PR and untouched since.

**Suggested fix:** Either give each nav leaf and group an optional message key and render the translation with the literal as a fallback, or delete the four unused keys from both locale tables so the catalog stops advertising coverage it does not have.

### B179 — The 'g d' shortcut and the ⌘K Drivers command are gated on recurring routes, unlike Drivers itself

**Area:** Dispatch navigation shortcuts · web

**Meant to do:** Drivers is shared by both delivery add-ons by design, so on an order-delivery-only workspace every route to it — sidebar, keyboard shortcut, command palette — works.

**Actually does:** The sidebar leaf, the route guard prefix and the API all honour the either-gate, but the g-d handler, the shortcut-help list and the palette's Drivers command are all gated on routes access alone.

**The gap:** Three navigation surfaces were left on the old routes-only gate when Drivers was reclassified as shared, so the command palette cannot find a page sitting in the operator's own sidebar.

**Evidence:** apps/web/app/(dashboard)/layout.tsx:100-105 (the Drivers leaf), :196-207 (the children filter touches only two other prefixes), :242-249 (the guard prefix uses "either"), :1215-1221 (both g-shortcuts gated on routes access), :1244-1256 (the help sheet filtered the same way, so the shortcut is never advertised); apps/web/components/CommandPalette.tsx:120-126 and :124 (the Drivers command is inside the routes-only id set), :274-277 (the filter); apps/api/src/drivers/drivers.controller.ts:29-37 (the server's either-gate).

**Suggested fix:** Move the Drivers command out of the routes-only command set into an either-gated one, and change the shortcut handler and the help filter to routes-or-delivery access so all three surfaces match the sidebar and the API.

### B184 — Driver location breadcrumbs have no retention job — the table grows without bound

**Area:** Driver GPS tracking · API + database

**Meant to do:** Continuously-written telemetry is bounded by some retention policy so the table and its indexes do not grow forever.

**Actually does:** There is no expiry column, no scheduled prune, and the only deleter is a destructive manual tenant wipe.

**The gap:** A missing retention policy on an append-only telemetry table — a growth and cost concern rather than wrong behaviour.

**Evidence:** apps/api/prisma/schema.prisma:919-938 (the model has no expiry field, plus two composite indexes); repo-wide grep for the model in apps/api returns only schema.prisma:427/919, drivers.service.ts:105 (create), routes.service.ts:734 (read) and scripts/wipe-tenant-fresh-start.js:99; none of the nine cron-bearing services reference it; cadence at apps/mobile/lib/location-tracker.native.ts:61-71 (30-second interval, 50-metre distance filter, automatic pausing).

**Suggested fix:** Add a nightly cron that deletes breadcrumbs older than a configurable window (e.g. 90 days), keeping a per-run summary or polyline if history is needed for disputes.

### B187 — The Language toggle ships to production while translations cover only the shell, palette and re-auth

**Area:** Web · i18n coverage

**Meant to do:** Picking Español translates the operator experience the way the avatar menu and command palette do.

**Actually does:** 22 translation call sites across 3 files; every dashboard page renders fixed English. The catalog itself documents this as the deliberate Phase-1 foundation set, not a regression.

**The gap:** An incomplete-by-design feature whose user-facing toggle promises more than the staged catalog delivers.

**Evidence:** apps/web/lib/i18n/messages.ts:2-11 (the header states coverage grows per phase and names this the Phase-1 foundation set — shell, command palette, undo, re-auth); the only importers are apps/web/app/(dashboard)/layout.tsx:72, apps/web/app/providers.tsx:8, apps/web/components/CommandPalette.tsx:35 and apps/web/components/ReAuthProvider.tsx:11, with 8 + 10 + 4 = 22 call sites; apps/web/app/(dashboard)/layout.tsx:929-944 (the Language menu offering English/Español); for scale, 111 .tsx files under app/(dashboard), 216 under app/, 54 under components/.

**Suggested fix:** Either gate the Language menu behind a flag until catalog coverage reaches the main screens, or label it as a preview; otherwise keep expanding the catalog per the documented phase plan, starting with page titles and table headers.

---

## Discovery instructions (per the campaign plan)

Discovery's job is to confirm these lines still say what the register says they say on
current master, and find what the register missed — **never a broad repo sweep**. Where the
citation table above flags a bug ID, search within the files that ID's evidence already
names; do not expand beyond them without a specific reason. Classify every bug ID as
`CONFIRMED on master@<sha>`, `ALREADY FIXED (evidence)`, or `EVIDENCE MOVED (new path:line)`
before writing any code. An already-fixed ID is flipped in the register with its evidence —
never silently carried, never silently dropped.
