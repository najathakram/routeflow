# 01 — Authentication & App Entry

**Role(s):** Everyone — unauthenticated visitors, staff (Operator / Tenant-Admin / limited-Customer / Driver), B2B **Buyers** (separate token namespace), and **Super-Admins** (fully isolated platform login). • **Entered via:** cold visit to a login URL, a tenant subdomain (`acme.routeflow.info/login`), the marketing site's "Sign In" / "Get Started" links, an emailed link (email-verification, password-reset, merge-verification, buyer invite), a Google OAuth redirect back to a `/callback` route, or any 401 that drops a session and bounces the user to a login gate.

This ecosystem is the app's **front door and its token-routing brain**. Unlike mobile (one root layout state machine), web splits the job across three layers: (1) **`middleware.ts`** runs on every request — resolves the tenant slug from subdomain → cookie, redirects phones to the mobile-web build, and blocks buyers from operator paths; (2) **three isolated auth providers** (`AuthProvider`, `BuyerAuthProvider`, plus the platform's raw `localStorage` `superAdminToken`) rehydrate their own session from a **namespaced localStorage bucket** (`lib/auth-keys.ts`); (3) each login **page** owns its own form, validation, Google-OAuth kickoff, and post-login redirect. There is **no shared login template** — the three human-facing login screens are hardcoded independently in three different visual languages (catalogued below).

> **Visual inconsistency (redesign target, documented briefly — behavior is the focus):** operator `/login` = **cream `#FAF6EE` page + deep-teal split panel + Instrument Serif** headings; buyer `/buyer/login` = **emerald `buyer-*` gradient split panel + Instrument Serif**; super-admin `/admin-login` = **dark slate `bg-slate-900` single card + indigo accent + Shield icon**. Callback/utility pages are a fourth style (`bg-surface-raised` + a blue `RF` monogram or slate for platform). All three should collapse into one accent-themed template — see **💡 Faster ways**.

---

## Screens

### Operator / staff login — `/login`

- **File:** `apps/web/app/(auth)/login/page.tsx`
- **Purpose:** Username-or-email + password (or Google) sign-in for all staff roles (OPERATOR, TENANT_ADMIN, limited CUSTOMER, DRIVER) within a resolved workspace/tenant. This is the generic platform entry point; on a tenant subdomain it becomes that tenant's branded login.
- **Shows:**
  - Split layout: left **teal gradient value-prop panel** (hidden `< lg`) with "Back to home" link, a dark-variant RouteFlow logo SVG, serif headline "Welcome back to _RouteFlow_." and a 3-item feature list (live driver tracking, auto-invoicing, real-time P&L). Right **form card**.
  - Form fields: **Workspace** (placeholder `e.g. acme`, `autoComplete="organization"`) — **hidden when on a tenant subdomain** (implied by URL); **Username or email** (placeholder `you@company.com`); **Password** (`PasswordInput`, masked with reveal toggle).
  - **Sign in** button (with `ArrowRight`), an "or" divider, **Continue with Google** button, helper "First sign-in? You'll be prompted to change your password."
  - Footer links: "Not a staff member? **Sign in to retailer portal**" (`/buyer/login`) and "New to RouteFlow? **Start your 14-day free trial**" (`/signup`).
  - **Tenant branding:** only applied on a real subdomain (`subdomainWorkspace && branding.logoKey`) — shows `{businessName}` + logo (`${apiUrl}/uploads/{logoKey}`). On platform hosts it is deliberately generic "RouteFlow" (a stale tenant cookie must not leak another tenant's name/logo onto the shared login).
- **Actions:**
  - **Sign in** → `setTenantCookie(workspace)` then `useAuth().login(username, password)` → `POST /auth/login` (via `apiClient`, which sends `X-Tenant-Slug` from the cookie). On success: `forcePasswordChange` → `router.push("/change-password")`, else `→ /dashboard`. Stores tokens under `OP_KEYS` + `rf-op-auth` presence cookie + corrects tenant cookie to `user.tenantSlug`.
  - **Continue with Google** → requires a non-empty workspace value (else inline error "Please enter your workspace before signing in with Google."); `GET {apiUrl}/auth/google?context=staff&tenant={slug}` → follow `data.url` (`window.location.href`). Returns to `/auth/google/callback`.
  - Enter-key wiring: Enter in username focuses password; Enter in password submits.
- **States:**
  - **Loading** — Sign-in button `loading`; Google button its own spinner "Redirecting to Google…".
  - **Throttle (429)** — reads `retry-after` header, starts a **live countdown** (`throttleSeconds`, 1 s `setInterval`) and shows warning banner "Too many login attempts. Try again in N second(s)."; Sign-in button disabled until it hits 0.
  - **API error** — red banner with server `message` (fallback "Invalid username or password.").
  - **Google error** — separate red banner; 503 → server message or "Google sign-in is not configured for this account."; else "Google sign-in is unavailable. Try again or use your username and password."
  - **Field errors** — zod inline: workspace regex `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$` (1–63 chars, trimmed+lowercased), username/password `min(1)`.

### Operator signup (tenant self-registration) — `/signup`

- **File:** `apps/web/app/(auth)/signup/page.tsx`
- **Purpose:** Create a brand-new tenant workspace + its first admin user (14-day free trial). No auto-login — email verification is required first.
- **Shows:** Centered card on `bg-surface-raised`, `/logo.svg`, "Start Your Free Trial", "14 Days Free" pill, "No credit card required". Fields: **Business Name**, **Workspace ID** (monospace, with live availability indicator), **Email**, **Username** (availability indicator), **Password** (reveal toggle), **Confirm Password**. **Create My Account** button. Terms/Privacy line. Footer: "Already have an account? **Sign in**", "Looking for the buyer portal? **Sign up here**" (`/buyer/register`).
- **Actions:**
  - Business Name auto-derives **Workspace ID** via `slugify()` (until user edits slug); slug auto-suggests **Username** as `{slug_with_underscores}_admin` (until user edits username).
  - **Debounced availability (400 ms)**: slug → `GET /public/tenants/{slug}/available`; username → `GET /public/tenants/username-available?username=`. Indicator states: `idle | checking | available | taken`.
  - **Create My Account** → blocks if slug/username `taken`, else `POST /public/tenants/register {slug, businessName, adminEmail, adminUsername, adminPassword}` → on success `router.push("/signup/check-email?email=…")`.
- **States:** Loading (button spinner); API error banner (joins array messages with `. `); per-field zod errors; availability hint/success/error text under slug & username. Button disabled while slug/username `taken`.
- **Validation (zod):** businessName 2–100; slug `^[a-z0-9][a-z0-9-]{2,29}$` (3–30); email; username `^[a-zA-Z0-9_]{3,30}$`; password `min(8)` + one uppercase + one number; confirm must match.

### Signup check-email — `/signup/check-email`

- **File:** `apps/web/app/(auth)/signup/check-email/page.tsx`
- **Purpose:** Post-signup confirmation telling the user to verify their email before logging in.
- **Shows:** Centered card, `Mail` icon, "Check your inbox", "We sent a verification link to **{email}**", a "Didn't receive it?" tips box (spam folder / right email / **link expires in 24 hours**), a **Resend verification email** button. Footer: "Back to Sign In" (`/login`), "Wrong email? **Sign up again**" (`/signup`).
- **Actions:** **Resend** → `POST /public/tenants/resend-verification {email}` (reads `email` from query param). Success → green "Sent! Check your inbox (and spam folder)."
- **States:** `resending` spinner; success message replaces the button; disabled if no email param.

### Super-admin (platform) login — `/admin-login` ⚠️ canonical

- **File:** `apps/web/app/(auth)/admin-login/page.tsx`
- **Purpose:** Platform-owner sign-in. Deliberately **tenant-less** (SUPER_ADMIN has `tenantId=null`, so **no `X-Tenant-Slug` header** is sent — this page uses raw `axios`, not the tenant-scoped `apiClient`).
- **Shows:** Dark `bg-slate-900` page, single centered card (`bg-slate-800`, indigo-ringed). Indigo `Shield` badge, "RouteFlow Platform", "Platform Administrator Login". Fields: **Username** (plain controlled input), **Password** (custom reveal toggle via inline eye SVGs). **Sign in** button (indigo). "or" divider → **Continue with Google**. Footer "…authorized personnel only". **No workspace field, no signup/forgot links.**
- **Actions:**
  - **Sign in** → `POST {apiUrl}/api/v1/auth/login {username, password}` (note: `apiUrl` here is stripped of the `/api/v1` suffix and re-appended). **Client-side role gate**: if `user.role !== "SUPER_ADMIN"` → error "This login is for platform administrators only." Else store `superAdminToken` + `superAdminRefreshToken` in `localStorage` and `router.push("/admin/dashboard")`.
  - **Continue with Google** → `GET /api/v1/platform-admin/auth/google` (distinct endpoint from the staff/buyer `/auth/google`) → follow `data.url`. Returns to `/platform/auth/callback`.
- **States:** Loading ("Signing in…"); error banner (red-on-dark); Google error banner; 503 → "Google sign-in is not configured. Contact the platform administrator." **No 429 countdown, no zod** — uses local `useState` + a manual "Username and password are required." check.

### Super-admin login (duplicate) — `/admin/login` 🟥 **DEAD / redirect-only**

- **File:** `apps/web/app/(auth)/admin/login/page.tsx`
- **Verdict:** **NOT a duplicate implementation — it is a 6-line server redirect.** Its entire body is `redirect("/admin-login")`. The comment reads _"/admin/login → redirect to the canonical admin login page at /admin-login."_ So `/admin-login` is the single real super-admin login screen; `/admin/login` exists only to catch the alternate URL shape and forward it. Nothing links to `/admin/login` for a form; the e2e helper and all tests target `/admin-login`. **Safe to keep as a redirect or delete once no inbound links use `/admin/login`.** (The README catalogue flagged "two super-admin login files, likely a duplicate/legacy fork" — the finding is: one real screen + one redirect stub, not two competing forms.)

### Staff Google OAuth callback — `/auth/google/callback`

- **File:** `apps/web/app/(auth)/auth/google/callback/page.tsx`
- **Purpose:** Lands after Google consent for staff **and** buyer standalone/portal flows; resolves tokens and routes to the right surface. `dynamic = "force-dynamic"`.
- **Shows:** Full-screen loading (`bg-surface-raised`, blue `RF` monogram, "Signing you in…") or an error card with a contextual action button.
- **Actions (mount effect, no controls):**
  - `action=linked` (user linked Google from settings) → `router.replace("/settings?linked=google")`.
  - `error` present → map via `ERROR_MESSAGES`; transient errors (`state_invalid`/`oauth_cancelled`/`unknown_error`) auto-redirect to `/login?error=google_failed` after 4 s.
  - **Token resolution:** prefers **one-time `code`** → `POST /auth/google/exchange {code}` (F8-001); falls back to legacy `accessToken`/`refreshToken` URL params (deploy-skew compat).
  - **`type === "BUYER"`** → store tokens under `BUYER_KEYS` **and** legacy `buyerAccessToken`/`buyerRefreshToken`; set `rf-buyer-auth` cookie; **hard** `window.location.replace("/buyer/portal")` (or `?linked=true`). **Else (staff)** → store under `OP_KEYS` + legacy keys; set `rf-op-auth` cookie; restore `tenantSlug` cookie; hard `window.location.replace("/dashboard")`.
  - **Why a hard navigation (not `router.replace`):** the root auth providers only read `localStorage` on mount, so a client-side nav would leave them unauthenticated and the dashboard guard would bounce the user back — a full document load remounts the provider so the new session is picked up on the first attempt.
- **States:** loading; error with contextual CTA — `google_email_is_staff` → "Go to staff login"; `unauthorized`/`tenant_suspended` → "Back to login"; else auto-redirect note. **Error map covers:** `state_invalid`, `unauthorized`, `tenant_suspended`, `google_email_is_staff`, `google_already_linked`, `google_id_taken`, `oauth_cancelled`, `unknown_error`.

### Platform-admin Google OAuth callback — `/platform/auth/callback`

- **File:** `apps/web/app/(auth)/platform/auth/callback/page.tsx`
- **Purpose:** Google callback specifically for the **super-admin** flow. `dynamic = "force-dynamic"`.
- **Shows:** Slate `bg-slate-900` loading state (indigo Shield + "Signing you in to Platform Admin…") or a slate **"Access denied"** card with "Back to admin login".
- **Actions:** `action=linked` → `/admin/dashboard?linked=google`. Token resolution same **`code` → `/auth/google/exchange`** pattern (or legacy params). **Guard: only proceeds if `bundle.role === "SUPER_ADMIN"`** — otherwise "Access denied". On success stores **only `superAdminToken`** (same key as the admin-login form) and `router.replace("/admin/dashboard")`. Transient errors auto-redirect to `/admin-login?error=google_failed` after 4 s.
- **States:** loading / error. Error map: `state_invalid`, `unauthorized` ("not authorized for platform administration"), `tenant_suspended`, `google_already_linked`, `google_id_taken`, `oauth_cancelled`, `unknown_error`.

### Legacy Google callback — `/callback`

- **File:** `apps/web/app/(auth)/callback/page.tsx`
- **Purpose:** Older/simpler staff-only OAuth landing. `dynamic = "force-dynamic"`. **Overlaps with `/auth/google/callback`** but only handles the direct-param staff path (no `code` exchange, no buyer branch, no error map).
- **Actions:** reads `accessToken`/`refreshToken`/`tenantSlug` from query; if present → store under `OP_KEYS` + legacy keys, set `rf-op-auth` cookie, restore tenant cookie, hard `window.location.replace("/")`; else set error "Google sign-in failed. Please try again." and `router.replace("/login?error=google_failed")` after 2 s.
- **States:** "Signing you in..." spinner or a `text-danger` line. _(Redesign note: this is a thinner, older variant of `/auth/google/callback` — a consolidation candidate.)_

### Buyer portal login — `/buyer/login`

- **File:** `apps/web/app/buyer/login/page.tsx`
- **Purpose:** B2B **buyer** sign-in (email/password or Google). Separate token namespace; no workspace/tenant slug required (buyer is matched by email, seller is resolved after login).
- **Shows:** Split layout — left **emerald `buyer-*` gradient panel** (decorative circles, `/logo-buyer.svg`, serif "Order smarter with _RouteFlow_.", three feature chips). Right form card: **Email**, **Password** (`PasswordInput`), **Sign in**, "or" divider, **Continue with Google**, "Don't have an account? **Create account**" (`/buyer/register`), footer "Staff member? **Sign in to Staff Portal**" (`/login`).
- **Actions:**
  - **Sign in** → `useBuyerAuth().login(email, password)` → `POST /buyer/auth/login`; stores `BUYER_KEYS` tokens + `rf-buyer-auth` cookie; loads sellers in background; `router.push(redirect ?? "/buyer/portal")`.
  - **If already authenticated on mount** → auto-redirect to `redirect ?? /buyer/portal`.
  - **Continue with Google** → `GET /auth/google?context=buyer-standalone` (no tenant) → follow `data.url` → returns to `/auth/google/callback` (BUYER branch).
  - **Open-redirect guard on `?redirect`:** honored only if it starts with `/buyer/` and contains no `..`, `://`, or `//`.
- **States:** Loading; API error banner (fallback "Invalid email or password."); Google error banner (503 → server message or "Google sign-in is not available right now."; else use email/password). Zod: email format, password `min(1)`. **No 429 countdown** (unlike operator login).

### Buyer registration — `/buyer/register`

- **File:** `apps/web/app/buyer/register/page.tsx`
- **Purpose:** Self-serve buyer account creation (email/password or Google). Buyers are **not** tied to a seller at signup — they connect via invite/request later.
- **Shows:** Centered card on `buyer-50→white` gradient, `/logo-buyer.svg`, "Create Account", "Join RouteFlow Buyer Portal". Fields: **Full Name**, **Email**, **Password** (reveal toggle), **Confirm Password**. **Create Account** button, "or" divider, **Continue with Google**. Footer: "Already have an account? **Sign in**", "Staff member? **Sign in to Staff Portal**".
- **Actions:** **Create Account** → `useBuyerAuth().register(email, password, name)` → `POST /buyer/auth/register` → `router.push(redirect ?? "/buyer/portal")`. Google sign-up same as login (`context=buyer-standalone`). Same `?redirect` open-redirect guard; login/register links preserve `redirect`.
- **States:** Loading; API error ("Registration failed. Please try again."); Google error; zod (name `min(2)`, email, password `min(8)`+upper+number, confirm match). Auto-redirects if already authenticated.

### Buyer invite acceptance — `/buyer/invite/[token]`

- **File:** `apps/web/app/buyer/invite/[token]/page.tsx`
- **Purpose:** A seller-issued invite link that connects a buyer account to that seller (creates/accepts a `CustomerLink`).
- **Shows:** Loads invite details from a **public** endpoint (`getInviteDetails(token)` → `GET /buyer/invites/{token}/details` → `{name, slug, logoKey}`). Card shows seller logo (or `Building2` fallback) + "You have been invited by **{name}**".
  - **If authenticated:** "Signed in as **{buyer.email}**", **Accept Invite & Connect** button, **Cancel**.
  - **If not authenticated:** "Sign in or create an account to accept this invite." + (when `invite.slug` known) **Continue with Google to accept** + divider + **Sign in to accept** (`/buyer/login?redirect=/buyer/invite/{token}`) + **Create account to accept** (`/buyer/register?redirect=…`).
- **Actions:**
  - **Accept** → reads `buyerAccessToken` from localStorage → `acceptInvite(token, accessToken)` → `POST /buyer/invites/{token}/accept` → success card → `router.push("/buyer/portal?linked=true")` after 1.5 s.
  - **Google-to-accept** → `GET /auth/google?tenant={slug}&context=portal&invite_token={token}` — the backend reads `invite_token` from OAuth state, accepts the link, and returns to `/auth/google/callback?linked=true`.
- **States:** loading spinner (invite + auth); **Invalid Invite** card ("This invite link is invalid or has expired.") with link to portal; **Invite Accepted!** success card; accept-error banner; Google error banner.

### Buyer merge verification — `/buyer/verify-merge`

- **File:** `apps/web/app/buyer/verify-merge/page.tsx`
- **Purpose:** Confirms ownership of a second buyer account when a **merge request** is in flight (an emailed token). `dynamic = "force-dynamic"`. Styled `bg-surface-raised` + brand (not emerald buyer palette).
- **Shows/Actions:** On mount `GET /buyer/auth/verify-merge/{token}`. States: **loading** ("Verifying…"); **success** (green check, "Account Verified!", server `message`, an info box explaining a platform admin will review & complete the merge and both owners get an email, **Go to Login** → `/buyer/login`); **error** (red X, "Verification Failed", server message + "log in and submit a new merge request from Account Settings", Go to Login). No-token → error "No verification token provided."

### Buyer landing redirect — `/buyer`

- **File:** `apps/web/app/buyer/page.tsx`
- **Purpose/behavior:** **Redirect-only.** Old buyer-marketing landing → now `redirect("/retailers")` (marketing site's canonical retailer route). `/buyer/login`, `/buyer/register`, `/buyer/portal/*` are unaffected (separate files).

### Buyer change password — `/buyer/change-password`

- **File:** `apps/web/app/buyer/change-password/page.tsx`
- **Purpose:** Authenticated buyer self-service password change (not a forced gate).
- **Shows:** Centered card, `/logo-buyer.svg`, "Change Password", "Updating password for {buyer.email}". Fields: **Current password**, **New password** (+ hint "At least 8 characters, one uppercase letter, one number."), **Confirm new password**. **Set new password** button. "Go back" (`router.back()`).
- **Actions:** redirects to `/buyer/login` if unauthenticated. Submit → reads `buyerAccessToken` → `buyerChangePassword(current, new, token)` → `POST /buyer/auth/change-password` → success card → `router.push("/buyer/portal")` after 2 s.
- **States:** null render until auth resolves; success card ("Password changed successfully!"); API error banner. **Google-only hint:** if the error mentions "current password"/"incorrect", appends "If you signed up with Google, you may not have a password set…". Zod: current `min(1)`, new `min(8)`+upper+number, confirm match.

### Operator forced/self change password — `/change-password`

- **File:** `apps/web/app/change-password/page.tsx`
- **Purpose:** The **forced-rotation gate** that `/login` sends `forcePasswordChange` users to (also reachable for a voluntary change).
- **Shows:** Centered card on `bg-surface-raised`, blue `RF` monogram, "Change Password", "You must set a new password before continuing." Fields: **Current / New / Confirm new password**. **Set new password** button.
- **Actions:** redirects to `/login` if unauthenticated. Submit → `changePassword(current, new)` → `POST /auth/change-password` (rotates tokens under `OP_KEYS` if the response returns new ones) → **hard** `window.location.href = "/dashboard"` (so `AuthProvider` reinitialises with the cleared flag).
- **States:** null until auth resolves; API error banner. Zod is **weaker than signup/buyer**: new password only `min(8)` (no uppercase/number rule); confirm match.

### Email verification — `/verify-email`

- **File:** `apps/web/app/verify-email/page.tsx`
- **Purpose:** Consumes the signup verification link's `token`, activates the tenant/admin, and logs the user straight in.
- **Actions (mount effect):** `POST /auth/verify-email {token}`. On success stores `accessToken`/`refreshToken` (**legacy keys only**), sets tenant cookie from `user.tenantSlug`, then `router.push("/dashboard")` after 1.5 s.
- **States:** **verifying** (spinner, "Verifying your email…"); **success** (green check, "Email verified!", auto-nav); **error** (red X, server message or "The link may have expired.", buttons **Sign up again** `/signup` + **Back to Sign In** `/login`). No-token → error immediately.

### Contact / Book a Demo — `/contact`

- **File:** `apps/web/app/contact/page.tsx`
- **Purpose:** Public marketing contact form (grouped here because it carries the top-nav "Sign In"/"Get Started" auth entry points). **Not an auth screen.**
- **Shows:** Sticky nav (logo, **Sign In** → `/login`, **Get Started** → `/signup`), "Book a Demo" heading, a form (First/Last name, Work email, Company name, "How many drivers?" select, optional notes textarea, **Request a Demo** button), and contact info (`hello@routeflow.app`, "reply within one business day").
- **States/Actions:** **Static form — no `onSubmit` handler wired** (plain `<form>`; the button does not POST anywhere in current code). White/navy/`brand` marketing styling.

---

## Key flows

- **Operator normal login (platform host):** `/login` → type workspace + username + password → `setTenantCookie` → `POST /auth/login` → tokens in `OP_KEYS` → `/dashboard` (or `/change-password` if `forcePasswordChange`). Commit point: `login()` writing `OP_KEYS.accessToken` + correcting the tenant cookie to `user.tenantSlug`.
- **Operator login on tenant subdomain:** `acme.routeflow.info/login` → `middleware.ts` sets `tenant-slug=acme` cookie; the workspace field is hidden (pre-filled+locked) and tenant branding (logo/name) is applied → same POST → `/dashboard`.
- **Operator Google login:** `/login` (workspace required) → **Continue with Google** → `GET /auth/google?context=staff&tenant={slug}` → Google consent → `/auth/google/callback?code=…` → `POST /auth/google/exchange` → staff branch stores `OP_KEYS`, restores tenant cookie → hard load `/dashboard`.
- **Tenant self-signup:** `/signup` (live slug/username availability) → `POST /public/tenants/register` → `/signup/check-email` → emailed link → `/verify-email?token=` → `POST /auth/verify-email` → auto-login → `/dashboard`.
- **Forced password rotation:** any operator login with `forcePasswordChange` → `/change-password` → `POST /auth/change-password` → hard load `/dashboard` with the flag cleared.
- **Super-admin login:** `/admin-login` → `POST /auth/login` (tenant-less) → **client-side `role === SUPER_ADMIN` gate** → `superAdminToken` in localStorage → `/admin/dashboard`. Google variant: `GET /platform-admin/auth/google` → `/platform/auth/callback` (role-gated) → `superAdminToken` → `/admin/dashboard`.
- **Buyer login (single flow):** `/buyer/login` → `POST /buyer/auth/login` → `BUYER_KEYS` tokens + `rf-buyer-auth` cookie → sellers loaded in background → `/buyer/portal` (seller selection happens inside the portal, not on the login page — unlike mobile which forks single/multi-seller at login).
- **Buyer invite acceptance (logged-out via Google):** email link → `/buyer/invite/[token]` (public details) → **Continue with Google to accept** → `GET /auth/google?tenant={slug}&context=portal&invite_token={token}` → backend accepts link → `/auth/google/callback?linked=true` (BUYER branch) → `/buyer/portal?linked=true`.
- **Buyer account merge:** platform-initiated merge → owner clicks emailed link → `/buyer/verify-merge?token=` → `GET /buyer/auth/verify-merge/{token}` → confirmation that a platform admin will complete the merge.
- **Cross-tab logout (operator):** Tab A logs out → removes `rf:op:accessToken` → Tab B's `storage` listener (`onCrossTabTokenChange`) fires → unless on a public marketing route, Tab B hard-navigates to `/login`.
- **Buyer blocked from operator surface:** signed-in buyer (only `rf-buyer-auth` cookie, no `rf-op-auth`) hits `/dashboard` etc. → `middleware.ts` redirects to `/buyer/portal`.

## Use cases

- As an **operator on the shared platform host**, I type my workspace, username, and password and land on my dashboard. (`/login` → `/dashboard`)
- As an **operator visiting my own subdomain**, the workspace is pre-filled and my company logo/name shows, so I only type username + password. (`acme.routeflow.info/login`)
- As a **new business owner**, I self-register a workspace, verify my email, and get dropped straight into the dashboard. (`/signup` → `/verify-email`)
- As a **staff member with a temporary password**, I'm forced to set a new one before I can use the app. (`/login` → `/change-password`)
- As the **platform owner**, I sign in on a dedicated tenant-less admin screen that rejects any non-SUPER_ADMIN account. (`/admin-login`)
- As a **retailer/buyer**, I create an account (or sign in) with just an email/password, independent of any single supplier. (`/buyer/register`, `/buyer/login`)
- As a **buyer who received an invite email**, I accept it — even via Google in one click — and get connected to that supplier. (`/buyer/invite/[token]`)
- As a **buyer merging two accounts**, I confirm ownership from an emailed link and wait for a platform admin to finish it. (`/buyer/verify-merge`)

## Business rules & edge cases

- **Three isolated token namespaces (`lib/auth-keys.ts`):** operator (`rf:op:*`), buyer (`rf:buyer:*` + `activeSeller`), driver (`rf:driver:*`); super-admin uses plain `superAdminToken`/`superAdminRefreshToken`. Presence cookies `rf-op-auth` / `rf-buyer-auth` let `middleware.ts` route without reading tokens. **Legacy-key migration:** `migrateLegacyOpToken()` / `migrateLegacyBuyerToken()` copy old `accessToken`/`buyerAccessToken` into the namespaced slots then delete the legacy keys (idempotent). OAuth callbacks still **double-write legacy keys** for any unmigrated code path.
- **Tenant slug plumbing is the login lynchpin:** the `tenant-slug` cookie **must stay non-httpOnly** — the Axios interceptor reads it via `document.cookie` to attach `X-Tenant-Slug`; making it httpOnly silently breaks `/auth/login` with "Invalid credentials". `middleware.ts` precedence: real subdomain (authoritative, overwrites) → existing cookie (preserve) → none (login page asks for workspace). Hosting-provider domains (railway.app, vercel.app, …) and reserved subdomains (`www/app/api/admin/…`) are never treated as tenant slugs.
- **Super-admin is tenant-less by design:** `/admin-login` sends **no** `X-Tenant-Slug` and uses raw `axios`; the role check is **client-side** (`user.role !== "SUPER_ADMIN"` rejected) — the server is still authoritative, but the UI won't store a non-admin token.
- **Google OAuth contexts differ per surface:** staff `context=staff&tenant={slug}` (slug required); buyer `context=buyer-standalone` (no slug, matched by email); buyer-invite `context=portal&tenant={slug}&invite_token=…`; super-admin uses a **separate endpoint** `/platform-admin/auth/google`. All modern callbacks prefer a **one-time `code` → `/auth/google/exchange`** (F8-001) and fall back to direct-token URL params for deploy skew.
- **Callbacks must hard-navigate, not client-route:** because `AuthProvider`/`BuyerAuthProvider` only read `localStorage` on mount, every OAuth/verify success uses `window.location.replace/href` — a `router.replace` would leave the provider unauthenticated and bounce the user (requiring a second Google click).
- **Open-redirect protection:** `/buyer/login` and `/buyer/register` honor `?redirect` only if it starts with `/buyer/` and has no `..`, `://`, or `//`.
- **Throttle UX is operator-only:** only `/login` maps a 429 `retry-after` into a live countdown + disabled button. `/buyer/login` and `/admin-login` surface the raw server message with no countdown.
- **Inconsistent password policy across screens:** signup, buyer-register, and buyer-change-password all require **8+ / one uppercase / one number**; the operator `/change-password` gate only requires **8+** (weaker). Worth unifying in the redesign.
- **Enumeration surfaces differ from mobile:** unlike mobile's always-success forgot-password, web has **no standalone forgot-password page** in this ecosystem — password reset is only reachable via the emailed link → `/verify-email` (signup) / change-password (authenticated). _(If a `/forgot-password` route is expected, it is absent here.)_
- **`middleware.ts` also redirects phones** to the mobile-web Railway build (UA sniff), unless `?desktop=1` / `prefer-desktop` cookie opts out — so on a phone these web login screens are normally never seen.
- **Two "dead-ish" routes:** `/admin/login` (redirect → `/admin-login`) and `/buyer` (redirect → `/retailers`) are redirect stubs, not real screens. `/callback` is a thinner legacy sibling of `/auth/google/callback`.

## Relevant files (all absolute)

- Operator/staff: `C:\ClaudeCode\routeflow\apps\web\app\(auth)\login\page.tsx`, `signup\page.tsx`, `signup\check-email\page.tsx`
- Super-admin: `C:\ClaudeCode\routeflow\apps\web\app\(auth)\admin-login\page.tsx` (canonical), `admin\login\page.tsx` (redirect stub)
- OAuth callbacks: `C:\ClaudeCode\routeflow\apps\web\app\(auth)\auth\google\callback\page.tsx`, `platform\auth\callback\page.tsx`, `callback\page.tsx`
- Buyer: `C:\ClaudeCode\routeflow\apps\web\app\buyer\login\page.tsx`, `register\page.tsx`, `invite\[token]\page.tsx`, `verify-merge\page.tsx`, `page.tsx` (redirect), `change-password\page.tsx`
- Top-level: `C:\ClaudeCode\routeflow\apps\web\app\change-password\page.tsx`, `verify-email\page.tsx`, `contact\page.tsx`
- Supporting libs: `C:\ClaudeCode\routeflow\apps\web\lib\auth.ts`, `auth-context.tsx`, `buyer-auth.ts`, `buyer-auth-context.tsx`, `auth-keys.ts`, `tenant-cookie.ts`, `..\middleware.ts`
- Specs cross-checked: `C:\ClaudeCode\routeflow\apps\web\e2e\05-cross-cutting.spec.ts` (CC-01…08), `01-super-admin.spec.ts`, `02-operator.spec.ts` (OP-21/22), `04-buyer-portal.spec.ts` (BY-06/13), `helpers\auth.ts`

---

## 💡 Faster ways _(suggestions for the redesign — not decisions)_

- **One `<AuthShell>` template, three accent themes.** The operator (teal), buyer (emerald), and super-admin (slate/indigo) screens are three hand-built layouts with duplicated split-panel, card, divider, Google-button, and error-banner markup. Collapse them into a single component that takes an `accent` token (+ optional value-prop panel) so all three inherit the same spacing, focus rings, throttle countdown, and error styling. Kills catalogue items #1 and #3 for this ecosystem.
- **Delete or keep-thin the `/admin/login` stub, and rename for clarity.** It is already just `redirect("/admin-login")`. Either drop it (once no inbound links use `/admin/login`) or, if the redesign wants the nested URL, make `/admin/login` the real page and `/admin-login` the redirect — pick one canonical path.
- **Merge `/callback` into `/auth/google/callback`.** `/callback` is a strictly weaker legacy sibling (no `code` exchange, no buyer branch, no error map). Point any remaining OAuth redirect at `/auth/google/callback` and delete `/callback`.
- **Unify the four Google-button + error-banner copies.** The identical inline `GoogleIcon` SVG and near-identical "Redirecting to Google… / unavailable / 503" logic are copy-pasted across `login`, `buyer/login`, `buyer/register`, `buyer/invite`, and `admin-login`. Extract a `<GoogleSignInButton context=…>` that owns the fetch, 503 handling, and error state.
- **Standardize one password policy + one reveal input.** Adopt the 8+/uppercase/number rule everywhere (the operator `/change-password` is the outlier at 8+ only), and replace the hand-rolled eye-toggle inputs in signup/buyer-register with the shared `PasswordInput` already used on the login screens.
- **Streamline workspace-slug entry.** On the shared platform host the operator must remember and type a workspace slug. Consider (a) resolving workspace from the email domain or a recent-workspaces cookie, (b) a "find my workspace" email flow, or (c) leaning harder on subdomains so the field disappears entirely — the subdomain path already hides it.
- **Add a real forgot-password screen.** Web currently has no standalone reset entry point in this ecosystem (mobile does). A single `/forgot-password` under the unified `<AuthShell>`, enumeration-safe like mobile, would close the gap.
- **Wire `/contact`'s form or route it to the demo pipeline.** The Book-a-Demo form has no submit handler; it should POST somewhere (or be replaced by the marketing CTA) so submissions aren't silently dropped.
