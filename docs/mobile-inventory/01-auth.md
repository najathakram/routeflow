## 1. Authentication & App Entry (role routing)

**Role(s):** Everyone — unauthenticated visitors, staff (Operator / Tenant-Admin), Drivers, and buyers (Customer Portal). Super-admins and legacy CUSTOMER-role users are hard-blocked from the mobile UI. • **Entered via:** Cold app launch / hard refresh, the marketing landing screen (`app/index.tsx`), deep links (`routeflow://…`, buyer-protected URLs like `/invoices/<uuid>`), the Google OAuth `routeflow://auth/callback` redirect, and any 401 that drops a session back to the login gate.

This area is the app's front door and its role-routing brain. A single effect in `app/_layout.tsx` (`RootLayoutNav`) watches three Zustand stores — staff auth, tenant slug, and buyer session — and, once all three finish rehydrating from `SecureStore`/`localStorage`, decides which route-group the user belongs in: buyer `(customer)`, staff `(operator)`/`(driver)`, or an `(auth)` gate (company-code, login, forced password change, or the desktop-only block). The `(auth)` screens themselves handle the two independent login stacks — staff (company-code → username/password/Google) and buyer (email/password/Google, multi-seller picker) — plus password reset and forced rotation.

### Screens

#### Root layout / role-routing state machine — `_layout.tsx` (no visible route; wraps everything)

- **File:** `apps/mobile/app/_layout.tsx`
- **Purpose:** Bootstrap providers + fonts, rehydrate auth/tenant/buyer state, and imperatively redirect to the correct route-group based on role and session.
- **Shows:** No chrome of its own. While bootstrapping it renders a centered `ActivityIndicator` (brand color). On web it clamps the whole app inside a phone frame (`maxWidth: 480`, neutral `#E5E7EB` backdrop). Otherwise it renders `<Slot/>` (the matched child route). Also mounts a global `<ConfirmModal/>` and a notification-received listener.
- **Actions (all imperative `router.replace`, no user controls):**
  - Reads `useAuthStore` (`user`, `activeRole`, `isLoading`, `initialize`), `useTenantStore` (`slug`, `initialize`), `useBuyerSessionStore` (`buyer`, `activeSeller`, `initialize`). Calls all three `initialize()` once on mount.
  - Registers `Notifications.addNotificationReceivedListener` (no-op handler; cleaned up on unmount). Global notification handler shows banner + list + sound, no badge.
- **States:**
  - **Bootstrapping** (`isLoading || tenantLoading || buyerLoading`) → spinner instead of `<Slot/>`; deliberately blocks children from mounting so they don't fire API calls that 401 and let the interceptor wipe tokens mid-boot.
  - **Buyer session** (`buyer && activeSeller && !user`) → forces `/(customer)/(tabs)/home` if not already under `(customer)`.
  - **Unauthenticated** (`!user`, no buyer) → only landing + `(auth)` allowed. A deep link into a protected group redirects to a login screen carrying `returnTo`: `(customer)` route → `/(auth)/customer-login`; `(operator)`/`(driver)` route → `/(auth)/login`; anything else → `/` (landing).
  - **Staff, no tenant slug** → `/(auth)/company-code` (sanity guard).
  - **Force password** (`user.forcePasswordChange`) → pinned to `/(auth)/force-change-password`.
  - **Blocked roles** → `SUPER_ADMIN` and legacy `UserRole.CUSTOMER` → `/(auth)/operator-blocked`.
  - **Role routing** — `activeRole === "operator"` → `/(operator)/home`; `activeRole === "driver"` → `/(driver)/route`. Staff are NOT bounced off `/(auth)/customer-login` (RF-087) so they can also sign into the buyer portal.
- **Steps (decision order, top to bottom — first match wins):**
  1. Still loading any store → render spinner, do nothing.
  2. Buyer logged in (and not also staff) → `(customer)` home.
  3. No user → allow landing/auth only; deep-link-aware redirect with `returnTo`.
  4. Staff but no tenant slug → company-code.
  5. `forcePasswordChange` → force-change-password.
  6. `SUPER_ADMIN` or `CUSTOMER` role → operator-blocked.
  7. `activeRole` operator/driver → respective home, with `mapSharedCustomerPathToOperator()` remapping deep-linked `/(customer)/invoices/:id` and `/orders/:id` to their `(operator)/(tabs)` equivalents instead of dumping the user on `/home` (BUG-OPS1-3).

#### Landing / marketing home — `/` (`index.tsx`)

- **File:** `apps/mobile/app/index.tsx`
- **Purpose:** Public marketing splash and entry funnel for unauthenticated users.
- **Shows:** Dark gradient hero with badge "Built for wholesale distributors and jobbers", brand glyph + "RouteFlow" wordmark, headline "Deliver smarter. Scale faster.", trust chips ("Built for delivery teams", "No setup fees", "Cancel anytime"); a 4-card feature grid (Order Management, Route Planning, Smart Invoicing, Delivery Tracking); a 3-step "Up and running" list (Set Up / Manage / Deliver); a 3-item stats band (Efficient / Connected / Scalable); footer CTA + copyright.
- **Actions:**
  - "Get Started" → `router.push("/(auth)/sign-in")`.
  - "I'm a Buyer" → `router.push("/(auth)/customer-login")`.
  - "Request a demo" → `Linking.openURL("mailto:hello@routeflow.info…")`.
- **States:** Static content only; no loading/empty/error. Scrollable.

#### Sign-in chooser — `/(auth)/sign-in`

- **File:** `apps/mobile/app/(auth)/sign-in.tsx`
- **Purpose:** Fork between the two login stacks.
- **Shows:** Back button, brand glyph, "Sign in" title, subtitle "Choose how you'd like to continue.", two large tap-cards.
- **Actions:**
  - "Staff & Drivers — Sign in with your company code and username." → `router.push("/(auth)/company-code")`.
  - "Customer Portal — Sign in with your buyer account email." → `router.push("/(auth)/customer-login")`.
  - Back → `router.back()`.
- **States:** Static; no loading/error.

#### Company code (tenant slug entry) — `/(auth)/company-code`

- **File:** `apps/mobile/app/(auth)/company-code.tsx`
- **Purpose:** Resolve and persist the tenant slug before staff login; slug scopes every subsequent staff API call (via `X-Tenant-Slug`) and the Google consent flow.
- **Shows:** Brand glyph, "RouteFlow" title, tagline "Enter your company code to continue.", a single `MobileInput` labeled "Company Code" (placeholder `e.g. acme-logistics`), Continue button, hint line, and a "Are you a customer? Customer Portal" link.
- **Actions:**
  - Input auto-lowercases on change. Zod validation: 3–30 chars, regex `^[a-z0-9][a-z0-9-]*$` ("lowercase letters, numbers, and hyphens").
  - "Continue" → `fetch GET {API}/public/tenants/:slug/branding` (unauthenticated). On 200, `useTenantStore.setSlug(slug, branding)` then `router.replace("/(auth)/login")`.
  - "Customer Portal" → `router.push("/(auth)/customer-login")`.
- **States:**
  - **Loading** — Continue shows spinner (`isSubmitting`).
  - **Error banner** — 404 → "Company code not found. Check with your administrator."; other non-OK → "Unable to verify company code. Please try again."; network throw → "Network error. Please check your connection and try again."
  - **Field error** — inline zod message under the input.

#### Staff login — `/(auth)/login`

- **File:** `apps/mobile/app/(auth)/login.tsx`
- **Purpose:** Username/password (and Google) sign-in for staff/drivers within the resolved tenant.
- **Shows:** Brand mark, "Welcome back", subtitle `Sign in to RouteFlow` (appends `· {businessName}` when tenant branding is loaded). Form: USERNAME (placeholder `jordan.m`), PASSWORD (masked), "Remember me" checkbox (default on), "Forgot?" link, "Sign in" button, an "or" divider, a `GoogleButton`, and a footer "New driver? Get setup code".
- **Actions:**
  - "Sign in" → `useAuthStore.login(username, password)` → `POST /auth/login`. On success the store sets `user` + `activeRole = defaultRoleForUser` (DRIVER→driver; OPERATOR/TENANT_ADMIN→operator) and the root layout routes away. Zod: both fields `min(1)`.
  - Google button → `loginWithGoogle(tenantSlug)` → `GET /auth/google?tenant=<slug>&context=staff&mobile=1`, opens `WebBrowser.openAuthSessionAsync` against `routeflow://auth/callback`, parses tokens from the redirect, stores them in the role-namespaced bucket, decodes the user from the JWT. Guarded: shows "Company code required before Google sign-in." if no slug.
  - "Forgot?" → `router.push("/(auth)/forgot-password")`.
  - "Remember me" toggles local `rememberMe` state (checkbox visual only).
  - "Get setup code" → `alertInfo` modal: "Your dispatcher can set up your account and give you your company code. Self-serve onboarding is coming soon."
- **States:**
  - **Loading** — button label swaps to "Signing in…", disabled + dimmed; Google button has its own `loading`.
  - **Error banner (red)** — 429 throttle mapped to "Too many login attempts. Please try again in N minute(s)." (uses `retryAfter`, default 5). Otherwise server `message` or "Invalid username or password." Google errors map: `cancelled`→silent; `unauthorized`/`google_email_is_staff`→"This Google account is not authorised for this company."; `google_unavailable`→"Google sign-in is not available for this company."; else generic fallback.
  - **Field errors** — inline zod messages; input turns red-washed.

#### Customer Portal login (buyer) — `/(auth)/customer-login`

- **File:** `apps/mobile/app/(auth)/customer-login.tsx`
- **Purpose:** Buyer sign-in (email/password or Google), seller resolution, and multi-seller selection. Reachable by both buyers and staff (staff are not redirected away).
- **Shows:** Back button, brand mark, "Customer Portal" title, subtitle "Sign in with your buyer account". Form: EMAIL (keyboard `email-address`), PASSWORD (masked), "Sign in" button, "Forgot password?" link, "or" divider, `GoogleButton`, footer "Don't have an account? Ask your supplier for a portal invite." Plus an `OptionPickerSheet` titled "Select supplier".
- **Actions:**
  - "Sign in" → `buyerLogin(email.lower(), password)` → `POST /buyer/auth/login`; on success `setBuyer(res.buyer)`, then `getBuyerSellers()` → `GET /buyer/sellers`:
    - 0 sellers → error "Your account is not connected to any supplier. Ask your supplier to send you a portal invite."
    - 1 seller → `storeSetSeller(...)` then `router.replace(postLoginTarget)`.
    - > 1 → open supplier picker sheet (`onSelectSeller` matches by `linkId`, sets seller, replaces to `/(customer)/(tabs)/home`).
  - Google → `buyerLoginWithGoogle()` → `GET /auth/google?context=buyer-standalone&mobile=1` (no tenant slug; backend matches by email), parses tokens, returns `{buyer, sellerCount}`, then same seller-resolution branch.
  - "Forgot password?" → `router.push("/(auth)/forgot-password")` (BUG-B2-7 entry point).
  - Back → `router.back()`.
- **States:**
  - **Loading** — sign-in button shows spinner; Google button own `loading`.
  - **Error banner** — client validation ("Email is required." / "Password is required."), 429 friendly throttle message, or server `message`. Google: `cancelled`→silent, `google_unavailable`→"…Try email and password.", `unauthorized`→"No buyer account found for this Google address.", else generic.
  - **returnTo (deep-link)** — `postLoginTarget` = validated `returnTo` param (must start with `/` and not `//` — open-redirect guard, BUG-B2-5), else `/(customer)/(tabs)/home`. Note: the multi-seller picker path ignores `returnTo` and always lands on home.
  - **Multi-seller** — bottom-sheet picker listing `tenant.name` per linked seller.

#### Google OAuth callback — `/(auth)/google-callback`

- **File:** `apps/mobile/app/(auth)/google-callback.tsx`
- **Purpose:** Safety-net deep-link handler for `routeflow://auth/callback`. On iOS/Android the in-app browser resolves tokens inline (this route is not normally hit); on web or when the OS misses the in-app resolve, the app lands here with tokens in query params.
- **Shows:** Full-screen spinner + "Completing sign-in…".
- **Actions (all in a mount effect; no controls):**
  - Reads params `accessToken`, `refreshToken`, `type`, `error`.
  - `error` present → `router.replace` to `/(auth)/customer-login` (if `type === "BUYER"`) else `/(auth)/login`.
  - Missing tokens → `/(auth)/login`.
  - Decodes JWT payload (base64url). `type === "BUYER"` → persists tokens under `BUYER_KEYS`, `setBuyer({id,email,name})`, replaces to `/(customer)/orders`. Otherwise staff → picks `DRIVER_KEYS` vs `OP_KEYS` from JWT `role`, persists, `setUser({...})`, and lets `RootLayoutNav` route by role.
- **States:** Loading only (transient); routes onward once the effect completes.

#### Multi-role role picker — `/(auth)/role-picker` (present but not wired into current routing)

- **File:** `apps/mobile/app/(auth)/role-picker.tsx`
- **Purpose:** For dual-role users (operator who can also drive), choose which surface to enter. NOTE: nothing currently navigates to this route — the live app switches roles inline via `setActiveRole` in the operator home mode-switcher and the driver "Switch role" menu item; the root layout routes straight to `activeRole`. Treat this screen as the designed-but-dormant role-choice pattern.
- **Shows:** Identity row (gradient avatar with 2-letter initials derived from `user.username`, username, `{tenantName} · multi-role`), prompt "How are you working today?", subtitle "You can switch anytime from the side menu." Two cards: a gradient **Driver** hero card (eyebrow "Recommended" when a run exists, else "Driver"; description from the next scheduled run — `{route.name} is ready · N stop(s)` or "No scheduled route for today — you can still log in as driver."; hero stats Stops + Date when a run exists), and a plain **Operator** card ("Warehouse dispatch, live fleet & exceptions").
- **Actions:**
  - Driver card → `setActiveRole("driver")` + `router.replace("/(driver)/route")`.
  - Operator card → `setActiveRole("operator")` + `router.replace("/(operator)/home")`.
  - Data: `useScheduledRouteRuns()` for the next-run preview.
- **States:** Reads next run from query hook; driver card copy adapts to run presence. No explicit loading/error UI (falls back to the no-run copy when `scheduledData` is undefined).

#### Forgot password — `/(auth)/forgot-password`

- **File:** `apps/mobile/app/(auth)/forgot-password.tsx`
- **Purpose:** Request a password-reset email (shared by staff and buyer stacks).
- **Shows:** Back button, "Reset password" title, subtitle "Enter the email address for your account and we'll send a reset link.", EMAIL field, "Send reset link" button. Success state swaps to a green check card "Check your email" + "If that address is registered, you'll receive a password reset link shortly." + "Back to sign in".
- **Actions:**
  - "Send reset link" → `axios POST {API}/auth/request-password-reset { email }` (email trimmed+lowercased).
  - "Back to sign in" / Back → `router.back()`.
- **States:**
  - **Loading** — button spinner; input `editable={false}`.
  - **Error** — only client-side "Please enter your email address." (empty).
  - **Enumeration-safe success** — always shows the success card regardless of server outcome (`catch` still sets `done = true`).

#### Reset password (token) — `/(auth)/reset-password`

- **File:** `apps/mobile/app/(auth)/reset-password.tsx`
- **Purpose:** Set a new password from an emailed reset link carrying a `token` param.
- **Shows:** Back button, "New password" title, subtitle "Choose a strong password — at least 8 characters with uppercase, lowercase, and a number or symbol.", NEW PASSWORD + CONFIRM PASSWORD fields, "Reset password" button. Success state: green check, "Password reset", "Your password has been updated. Please log in with your new password.", "Go to sign in".
- **Actions:**
  - "Reset password" → `axios POST {API}/auth/reset-password { token, newPassword }`.
  - "Go to sign in" → `router.replace("/(auth)/login")`.
  - Back → `router.back()`.
- **States:**
  - **Loading** — button spinner; inputs non-editable.
  - **Client validation errors** — missing token ("Reset link is missing or invalid. Please request a new one."), `< 8` chars, mismatch ("Passwords do not match.").
  - **Server error** — server `message` or "Reset failed. The link may have expired — please request a new one."
  - **Success** — full-screen done card.

#### Force change password — `/(auth)/force-change-password`

- **File:** `apps/mobile/app/(auth)/force-change-password.tsx`
- **Purpose:** Mandatory password rotation gate for staff whose JWT has `forcePasswordChange: true`; the root layout pins them here until it clears.
- **Shows:** "Set New Password" title, subtitle "You must change your password before continuing.", three `MobileInput`s (Current / New / Confirm New Password), "Set New Password" button. (Uses an older `#1B3A5C`/`#fff` palette, not the iOS token set.)
- **Actions:**
  - Submit → `changePassword(current, new)` → `POST /auth/change-password`, then `refreshTokens()` (`POST /auth/refresh`) to obtain a JWT with `forcePasswordChange: false`, then `setUser(refreshed.user)` — which re-triggers `_layout.tsx` to route into the correct tab group.
  - Zod: current `min(1)`; new `min(8)` + must contain an uppercase letter + a number; confirm must match.
- **States:**
  - **Loading** — button `loading` while submitting.
  - **Field errors** — inline zod messages per field.
  - **Error banner** — server `message` or "Failed to change password."
  - **Gated** — reached only via redirect; the user cannot leave until rotation succeeds and tokens refresh.

#### Operator blocked (desktop-only) — `/(auth)/operator-blocked`

- **File:** `apps/mobile/app/(auth)/operator-blocked.tsx`
- **Purpose:** Terminal dead-end for roles with no mobile UI (`SUPER_ADMIN`, legacy `CUSTOMER`).
- **Shows:** Desktop icon, "Desktop Only", message "Operator access is not available on mobile. Please sign in on the web dashboard to manage routes and deliveries.", "Sign Out" button.
- **Actions:** "Sign Out" → `useAuthStore.logout()` → `POST /auth/logout` + clears every role bucket → root layout falls back to landing/login.
- **States:** Static; the only exit is sign-out.

### Key flows (end-to-end journeys through this area)

- **Staff first-time / normal login:** Landing → Sign-in chooser → Company code (`GET /public/tenants/:slug/branding`, `setSlug`) → Staff login (`POST /auth/login`) → store sets `user` + `activeRole` → `_layout.tsx` redirects to `/(operator)/home` or `/(driver)/route`. Commit point: `login()` persisting role-namespaced tokens + `CURRENT_ROLE_KEY`.
- **Staff Google login:** Company code first (slug required) → Staff login → Google button → `GET /auth/google?tenant&context=staff&mobile=1` → in-app browser → `routeflow://auth/callback?accessToken…` → tokens parsed in `loginWithGoogle` (or, as fallback, on the `google-callback` screen) → `setUser` → role routing.
- **Forced rotation on login:** Any staff login whose JWT has `forcePasswordChange` → `_layout.tsx` pins to force-change-password → `POST /auth/change-password` + `POST /auth/refresh` → `setUser(refreshed)` → normal role routing. Commit point: the refresh returning a JWT with the flag cleared.
- **Buyer login (single vs multi-seller):** Landing "I'm a Buyer" (or Sign-in chooser → Customer Portal) → `POST /buyer/auth/login` → `GET /buyer/sellers` → 1 seller auto-selects and `router.replace` to buyer home; 2+ opens the supplier `OptionPickerSheet`, selection commits the active seller (which becomes the `X-Tenant-Slug` for buyer API calls). Commit point: `storeSetSeller`.
- **Deep-link into a protected route while logged out:** e.g. `/(customer)/invoices/<uuid>` → `_layout.tsx` sees `!user`, computes `returnTo`, redirects to `/(auth)/customer-login?returnTo=…` → after login the validated `returnTo` sends the buyer back to the intended page. Staff equivalent redirects to `/(auth)/login`; shared operator/customer paths are remapped rather than dropped on `/home`.
- **Password reset:** Login/Customer-login → "Forgot?"/"Forgot password?" → Forgot-password (`POST /auth/request-password-reset`, always shows success) → email link opens `reset-password?token=…` → `POST /auth/reset-password` → "Go to sign in".
- **Cross-tab logout (web):** Tab A logs out and clears `rf:op:accessToken`/`rf:driver:accessToken`/`rf:currentRole` → Tab B's `storage` event listener drops in-memory `user` → `_layout.tsx` redirects Tab B to login.

### Use cases

- As a **driver**, I want to enter my company code once and sign in with my username so that I land directly on today's route. (path: sign-in → company-code → login → `/(driver)/route`)
- As an **operator**, I want to sign in with Google after entering my company code so that I skip typing a password. (path: company-code → login → Google → callback → `/(operator)/home`)
- As a **new staff member forced to rotate my password**, I want a mandatory change screen before I can use the app so that my seeded temporary password can't persist. (path: login → force-change-password → role home)
- As a **buyer linked to several suppliers**, I want to pick which supplier's portal to open after logging in so that I see the right catalog and prices. (path: customer-login → supplier picker → `/(customer)/(tabs)/home`)
- As a **buyer who deep-linked to an invoice from an email**, I want to be returned to that invoice after logging in so that I don't lose my place. (path: `/(customer)/invoices/:id` → customer-login?returnTo → invoice)
- As a **super-admin who opened the mobile app**, I want a clear "use the web dashboard" message and a sign-out so that I'm not stuck on a broken surface. (path: any → operator-blocked)
- As a **user who forgot my password**, I want to request a reset link and set a new password so that I can regain access. (path: forgot-password → email → reset-password → login)

### Business rules & edge cases

- **Three independent sessions, per-role token namespacing:** Staff-operator, staff-driver, and buyer tokens live under separate keys (`rf:op:*`, `rf:driver:*`, `rf:buyer:*`) plus a `rf:currentRole` marker so concurrent web tabs / app contexts can't clobber each other (NEW-m2-1 / RF-077). `getStoredUser`/`refreshTokens` prefer the marker's bucket, falling back to op→driver iteration; the marker prevents a stale driver token from hijacking a re-logged-in operator (BUG-XR1-4).
- **Bootstrapping gate:** Children never mount until auth+tenant+buyer stores finish rehydrating; without this, a hard refresh mounts routes with no auth context, fires 401s, and the interceptor can wipe tokens mid-boot.
- **Tenant slug is mandatory for staff:** No staff login (password or Google) is possible before a valid slug is resolved and persisted; the slug becomes the `X-Tenant-Slug` header and scopes the Google consent flow. `company-code` validates format client-side and existence via the public branding endpoint.
- **Role → surface mapping:** DRIVER → driver tabs; OPERATOR/TENANT_ADMIN → operator tabs; `SUPER_ADMIN` and legacy `CUSTOMER` → operator-blocked (no mobile UI). `activeRole` defaults from the JWT role but is overridable; dual-role switching (operator↔driver) happens inline via `setActiveRole` from the operator home mode-switcher (gated on `user.canActAsDriver`) and the driver "Switch role" menu — NOT via the (orphaned) role-picker screen.
- **Forced password change is a hard gate:** `forcePasswordChange` pins the user to `force-change-password`; only a successful change + token refresh (clearing the flag) releases them. New-password policy differs by screen — force-change requires 8+ chars with an uppercase and a number; reset-password requires 8+ chars and matching confirm (copy also mentions lowercase + number/symbol).
- **Open-redirect protection on `returnTo`:** Only same-origin paths starting with a single `/` are honored; `//`-prefixed or non-`/` values are dropped and default to buyer home (BUG-B2-5). The multi-seller picker branch does not honor `returnTo` (always lands on home).
- **Enumeration-safe forgot-password:** The request-reset call always surfaces the "check your email" success state even on server error, so an attacker can't probe which emails exist.
- **Rate-limit UX:** 429 responses on staff and buyer login are mapped from NestJS's raw "Too Many Requests" to "Too many login attempts. Please try again in N minute(s)." using `retryAfter` (default 5) (BUG-OPS1-5).
- **Google OAuth is deep-link based:** `GET /auth/google` returns a consent URL (contexts `staff` vs `buyer-standalone`; buyer needs no slug and matches by email); tokens come back on `routeflow://auth/callback`. Native resolves inline; `google-callback.tsx` is the web / missed-resolve fallback that persists tokens to the correct role bucket by decoding the JWT `role`/`type`.
- **Buyer must be linked to a seller:** Zero linked sellers blocks portal entry with an "ask your supplier for a portal invite" message; the active seller's `tenant.slug` is injected as `X-Tenant-Slug` on all buyer API calls, and the buyer axios client transparently refreshes on 401 via `POST /buyer/auth/refresh`, invoking a session-expired handler on failure so the layout redirects instead of leaving the buyer on silently-failing screens (BUG-B1-1).
- **Logout is total for staff:** `logout()` clears every role bucket including buyer slots and the active-seller pointer, preventing an orphan buyer WebSocket from opening under the next operator's session (BUG-XR1-2).
- **Web phone-frame clamp:** On web the entire app is centered inside a `maxWidth: 480` phone frame on a neutral backdrop; native ignores this. Fonts (Inter family) load best-effort and never block render (a prior gate left an empty root div when the font promise hung).

Files covered (all absolute):

- `C:\ClaudeCode\routeflow\apps\mobile\app\_layout.tsx`
- `C:\ClaudeCode\routeflow\apps\mobile\app\index.tsx`
- `C:\ClaudeCode\routeflow\apps\mobile\app\(auth)\sign-in.tsx`, `login.tsx`, `customer-login.tsx`, `role-picker.tsx`, `company-code.tsx`, `google-callback.tsx`, `forgot-password.tsx`, `reset-password.tsx`, `force-change-password.tsx`, `operator-blocked.tsx`
- Supporting libs read for endpoints/rules: `apps\mobile\lib\auth-store.ts`, `auth.ts`, `buyer-auth.ts`, `auth-keys.ts`, `tenant-store.ts`
