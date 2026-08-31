# F20 · Mobile error feedback and dead affordances

**Bug IDs (7):** B04, B23, B94, B95, B142, B151, B172

**Root cause:** showToast has Android and web branches and the iOS path is a bare fallthrough with a comment (lib/toast.ts:34), while being the sole failure feedback at 381 call sites across 99 files (B151) — one toast host makes all of them work, including the offline-queue data-loss notice at useNetworkSync.ts:36. On web (B172) there is NO shared getApiErrorMessage helper at all: ~40 sites inline err?.response?.data?.message ?? fallback with no array check, exactly one site handles it correctly (signup/page.tsx:219), and the global funnel at providers.tsx:36 passes the raw array into a toast title where React concatenates it with no separator. Mobile has no global mutation onError at all (app/_layout.tsx:38 is a bare new QueryClient()) — add one.

**Ships as:** One PR.

**Files:** lib/toast.ts · app/_layout.tsx (mobile) · providers.tsx (web) · useNetworkSync.ts

**Together because:** One error-surfacing boundary per client, closing hundreds of silent-failure call sites at once.

**Guardrails / shared infra:** Delivers G5 — one error-surfacing boundary per client (web: apiErrorMessage(err) helper joining NestJS's message array, called from the global mutation handler; mobile: a real toast host in the root layout, keeping the existing showToast signature). Re-count the 381/99 figure at execution time rather than trusting it.

**Dependencies / lane notes:** Requires F05, F19 (semantic/positional — F19 shares mobile payment.tsx).

---

## Proof-tier assignment (frozen at seed — see plan's Phase 2 and `.claude/campaign/status/F20.jsonl`)

| ID   | Tier | Hunt-round SHA | Citation status              |
| ---- | ---- | -------------- | ---------------------------- |
| B04  | T1   | 2d0270fd       | MOVED (disambiguate in-file) |
| B23  | T3   | 2d0270fd       | OK                           |
| B94  | T3   | e5b0af8e       | NO_TOKEN_UNVERIFIED          |
| B95  | T3   | e5b0af8e       | AMBIGUOUS_FILE               |
| B142 | T1   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED          |
| B151 | T1   | 0b2c3a0a       | AMBIGUOUS_FILE               |
| B172 | T2   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED          |

> T1 = jest spec (api or mobile pure-logic) · T2 = Playwright e2e, web-visible (proven-pending-deploy through the PR, per the plan) · T3 = recorded manual check (forbidden for Critical/High — none here are). See `.claude/campaign/citation-reanchor-log.md` for any bug ID flagged above whose citation needs a discovery-time check before trusting it verbatim.

---

## Bug details — register triple, evidence and suggested fix, pasted verbatim

### B04 — Push-notification toggle registers nothing

**Area:** Settings · mobile

**Meant to do:** Let the operator control whether this device receives push notifications, with the alert explaining registration will happen the next time the app launches.

**Actually does:** The Switch only sets a local `pushEnabled` state (never sent to the server, never included in the settings save payload) and shows an alertInfo popup; actual push-token registration/deregistration happens automatically and unconditionally on every login/logout via lib/auth.ts, unrelated to this switch.

**The gap:** Turning the switch off does not deregister the device, and turning it on does not register anything on next launch — the alert describes a mechanism that doesn't exist.

**Evidence:** apps/mobile/app/(operator)/settings/index.tsx:41 (local state), :107-129 (Switch + alertInfo text), :60-73 (save() payload has no pushEnabled field); real registration in apps/mobile/lib/auth.ts:119-142 (registerPushToken), called unconditionally at :168 and :251, deregisterPushToken at :275.

**Suggested fix:** Either persist the preference server-side and gate registerPushToken/deregisterPushToken on it, or replace the switch+misleading alert with an OS-level 'open notification settings' deep link.

### B23 — Return screen’s “+ Add” is decorative

**Area:** Returns · driver app

**Meant to do:** The "+ Add" label next to "Returned items" should let a driver manually add a return line beyond what was auto-derived from delivery mutations.

**Actually does:** SectionRow renders the `action` prop as a plain <Text> with no onPress/Pressable wrapper — tapping "+ Add" does nothing at all.

**The gap:** A button-styled label promises an add-item action that doesn't exist; drivers are stuck with only the auto-derived rows.

**Evidence:** apps/mobile/app/(driver)/route/stop/[stopId]/return/index.tsx:166 (`<SectionRow title="Returned items" action="+ Add" />`); :244-251 (SectionRow = `<Text>{action}</Text>`, no touch handler)

**Suggested fix:** Wrap the action label in a Pressable that opens a manual product picker to add a line, or remove "+ Add" since it isn't actionable today.

### B94 — Driver detail "Assigned routes" rows show a chevron but aren't tappable

**Area:** apps/mobile/app/(operator)/driver.tsx

**Meant to do:** An operator taps an assigned-route row on a driver's detail screen — which shows a forward chevron — to open that route.

**Actually does:** Each row is a plain View wrapping the route text and a chevron icon; there is no Pressable, onPress or TouchableOpacity anywhere in the file except the nav bar's back and Edit buttons.

**The gap:** The chevron promises navigation per the app's own convention (fleet.tsx wraps an identical row+chevron in a Pressable that navigates into this very screen), and a real route-detail screen exists to link to — the row is a dead end to a live destination.

**Evidence:** apps/mobile/app/(operator)/driver.tsx:110-132 (View, chevron at :127); apps/mobile/app/(operator)/fleet.tsx:165-197 (the correct Pressable+onPress pattern); apps/mobile/app/(operator)/routes/[id].tsx (the destination that exists).

**Suggested fix:** Wrap each route row in a Pressable navigating to /(operator)/routes/<id>, matching fleet.tsx.

### B95 — The mobile tenant-admin dashboard is unreachable — no role ever routes there

**Area:** apps/mobile role routing + app/(tenant)

**Meant to do:** A tenant admin opens a dedicated org-level dashboard (Today/Dispatch/Billing/Settings/More) distinct from the operator warehouse-dispatch UI.

**Actually does:** ActiveRole is typed as "driver" | "operator" | null with no third value; defaultRoleForUser folds TENANT_ADMIN into "operator"; every setActiveRole call site passes only driver or operator (the role picker offers only those two cards, and its own comment says it has no in-app entry point); the root layout redirects any operator-role session to /(operator)/home whenever the segment isn't (operator), with no (tenant) branch — so even manual navigation bounces back.

**The gap:** A fully built, hook-backed tenant-admin dashboard sits in the tree, unreachable by any state, control or redirect, for any role including TENANT_ADMIN.

**Evidence:** apps/mobile/lib/auth-store.ts:14, :34-39; apps/mobile/app/_layout.tsx:167-173 (no (tenant) case in the role-routing effect); apps/mobile/app/(auth)/role-picker.tsx:13-16, :78-127; setActiveRole call sites more.tsx:283, home.tsx:491/541, driver-menu.tsx:73, role-picker.tsx:27/43/47; apps/mobile/app/(tenant)/today.tsx (516 lines) and (tenant)/_layout.tsx (69 lines); .claude/code-map/mobile.md:228-230 documents it as an intended area.

**Suggested fix:** Either wire a real entry point (extend ActiveRole with "tenant", route TENANT_ADMIN there by default or via the role picker, add a (tenant) branch to the root redirect) or delete the tree if it's superseded.

### B142 — The mobile product picker offers deactivated SKUs, and no write path rejects them

**Area:** Products · mobile operator + API

**Meant to do:** Deleting a product removes it from the catalog: it disappears from the buyer shop and from the places staff build orders and invoices, on every surface.

**Actually does:** Delete sets isActive:false. Mobile's shared ProductPickerSheet queries products with no isActive filter and renders no Inactive marker, and neither orders nor invoices validate isActive when a line is written.

**The gap:** An operator on a phone silently adds a deleted SKU to an order or invoice, and stock moves against a product the tenant removed.

**Evidence:** apps/api/src/products/products.service.ts:1103-1112 (remove → isActive:false), :221 (the filter is applied only when asked for); apps/mobile/components/ProductPickerSheet.tsx:56-59 (useAdminProducts with no isActive), :125-151 (no Inactive pill); contrast apps/mobile/app/(operator)/products/index.tsx:386-390 (mobile's own list does render one) and apps/web/components/SearchableProductPicker.tsx:117, :311-314, :380-384; write paths: grep isActive in apps/api/src/orders/orders.service.ts returns only :93 (promotions) and zero hits in invoices.service.ts, with the line-build lookups selecting only pricing/unit fields (orders.service.ts:231-234, invoices.service.ts:324-331).

**Suggested fix:** Add an activeOnly prop to ProductPickerSheet (default true, passed false by the stock-count, PO-receive, vendor-bill and variant-parent callers) and render an Inactive pill when a row comes back inactive; belt-and-braces, reject isActive:false productIds in the order and invoice line-create/edit paths.

### B151 — showToast is a no-op on iOS, yet it is the only error feedback at 380 mobile call sites

**Area:** Error feedback · mobile iOS

**Meant to do:** When a mutation fails the user sees why, so they can fix the input or decide whether to retry — on every platform the app ships to.

**Actually does:** toast.ts handles Android and web; the iOS path is an empty fallthrough. 380 showToast calls across 99 files are the sole failure feedback, and no inline error component exists in the mobile app at all.

**The gap:** On iOS a failed mutation is visually identical to a tap that never registered — the spinner clears and nothing else changes.

**Evidence:** apps/mobile/lib/toast.ts:4,6,34 (android and web branches only; the iOS line is a comment saying to use in-screen feedback instead); apps/mobile/app/(driver)/route/stop/[stopId]/payment.tsx:299-303 (catch → setClosing(false) + showToast and nothing else), :323, :329-335 (success DOES fire a native Alert for the maps hand-off, so success is visible on iOS while failure is not); counts run during verification: grep -rn "showToast(" apps/mobile excluding lib/toast.ts = 380 hits across 99 files, and grep -rln "InlineError" apps/mobile packages/ui/src/mobile = zero files; apps/mobile/app.json:16-17 confirms iOS is a real build target.

**Suggested fix:** Replace the iOS no-op with a real in-app toast/banner host rendered in the root layout, reusing the existing showToast signature so all 380 call sites become visible; separately add an inline error row to the driver payment, adjust and return screens.

### B172 — Web toasts render NestJS's multi-message validation errors as one run-on line

**Area:** Validation errors · web toasts

**Meant to do:** A failed mutation surfaces the server's specific validation messages legibly, so the user knows what to fix.

**Actually does:** The validation pipe always returns message as a string array; the global error handler passes it unguarded into the toast title, and React renders the array's strings back to back with no separator.

**The gap:** With two or more failing constraints the toast is an unpunctuated wall of text; only single-message 400s read correctly.

**Evidence:** apps/api/src/main.ts:180-186 (ValidationPipe with no exceptionFactory, so the default flattener always produces an array); apps/web/app/providers.tsx:37-38 (the message is passed straight into toast({ title }) with no Array.isArray check); packages/ui/src/web/Toast.tsx:106-108 (rendered raw); the same unguarded shape at apps/web/app/(dashboard)/drivers/_components/AddDriverModal.tsx:77-80 and apps/web/components/InlineCreateSupplierModal.tsx:95-101; the correct counter-example is apps/web/app/buyer/portal/[seller]/payments/_components/MakePaymentPanel.tsx:41-45, which joins the array.

**Suggested fix:** Normalize once at the boundary with a shared apiErrorMessage(err) helper that joins arrays (or renders them as a list) and call it from the global mutation error handler plus the two component-local copies; optionally have Toast accept a ReactNode and render a list for multi-message errors.

---

## Discovery instructions (per the campaign plan)

Discovery's job is to confirm these lines still say what the register says they say on
current master, and find what the register missed — **never a broad repo sweep**. Where the
citation table above flags a bug ID, search within the files that ID's evidence already
names; do not expand beyond them without a specific reason. Classify every bug ID as
`CONFIRMED on master@<sha>`, `ALREADY FIXED (evidence)`, or `EVIDENCE MOVED (new path:line)`
before writing any code. An already-fixed ID is flipped in the register with its evidence —
never silently carried, never silently dropped.
