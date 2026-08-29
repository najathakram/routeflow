# Impersonation identity follows the impersonated tenant + admins stop resurrecting as drivers

Status: PLANNED
Branch: feat/dispatch-addon-enforcement (second commit — stacked after the devmode-narrowing batch)
Date: 2026-08-28

## Context

Two owner-reported bugs (2026-08-28):

**Bug A — impersonation branding/identity leak.** When SUPER_ADMIN impersonates a tenant, the
red banner and all DATA are correct, but the sidebar logo/business name and the top-right
username chip keep showing the PREVIOUS tenant. Root cause: `AuthProvider` (user chip) and
`TenantProvider` (branding) snapshot identity ONCE at mount; `setImpersonation()` fires a
`rf-impersonation-change` event but the ONLY subscriber is the banner. The tenants-LIST page's
Impersonate button additionally uses `router.push` (soft nav, no remount) and never writes the
tenant-slug cookie — unlike the tenant-DETAIL page which does `setTenantCookie` + hard reload.
Exit impersonation is also a soft nav that restores nothing (reverse-stale bug).

**Bug B — deleted admin keeps reappearing in Drivers.** Platform-admin `createTenant` AND
`createTenantAdmin` auto-create a Driver row for the admin and hardcode `canActAsDriver: true`.
`DELETE /drivers/:id` hard-deletes the driver AND the linked User in one transaction: for an
admin with restrict-FK children (messages, stock counts, device tokens) the user-delete fails →
whole tx rolls back → driver row "comes back"; when it succeeds it would delete the tenant's
ADMIN LOGIN. Either way `canActAsDriver` is never cleared, so the Settings toggle re-creates the
row (`users.service.toggleDriverPermit`). Owner wants: admins are NOT drivers by default; the
Settings "Act as driver" toggle stays the explicit opt-in; deleting a dual-role user's driver
row must stick and must never delete their login; a non-driver admin gets no "My Routes".

Also fixing in passing: the JWT strategy never copies `canActAsDriver`/`isAdmin` into
`req.user`, so RolesGuard's dual-role branch (operators-as-drivers) is dead server-side.

## Non-negotiable project rules

- API code NEVER imports `@routeflow/types` at runtime.
- Prettier: semicolons, double quotes, printWidth 100, trailing commas.
- Jest for api; NO web unit tests (web is Playwright-only). NestJS specs mock at module boundary.
- Match surrounding comment style; update stale comments you touch.

## Work packages

### WPA — API: stop minting admin drivers

Files:

- `apps/api/src/platform-admin/platform-admin.service.ts`

1. In `createTenant` (tx starting ~L234): DELETE the auto-create driver block at ~L276-284
   (comment "Auto-create a driver profile so the admin can use driver features immediately")
   and change `canActAsDriver: true` at ~L271 to `canActAsDriver: false`, with a comment:
   "Owner decision 2026-08-28: admins are NOT drivers by default — driver capability is an
   explicit opt-in via Settings → Act as driver (users.service.toggleDriverPermit), which
   creates the Driver row on first enable."
2. In `createTenantAdmin` (~L1296): same — delete the driver block at ~L1343-1355 and flip
   `canActAsDriver: true` → `false` at ~L1337, same comment (or a short "see createTenant").

No spec changes needed (verified: platform-admin.service.spec.ts never exercises these blocks).

Acceptance criteria:

- [ ] No `driver.create` remains in platform-admin.service.ts
- [ ] Both `canActAsDriver` writes are `false` with the owner-decision comment
- [ ] API typechecks; existing platform-admin specs pass

### WPB — API: driver deletion keeps dual-role logins and clears the capability

Files:

- `apps/api/src/drivers/drivers.service.ts`
- `apps/api/src/drivers/drivers.service.spec.ts`

In `remove()` (~L257-281): the current tx hard-deletes the Driver row and then
`tx.user.delete({ where: { id: driver.userId } })` unconditionally. Change to:

1. Load the linked user's role first (extend the existing lookup — `findOneOrThrow` ~L283-287
   or an explicit `tx.user.findUnique({ where: { id: driver.userId }, select: { role: true } })`
   inside `remove`).
2. Keep the run-guard and the route/routeRun/deliveryMutation unlink updates unchanged.
3. After `tx.driver.delete(...)`:

```ts
if (linkedRole === UserRole.DRIVER) {
  // Pure driver accounts exist only to drive — remove the login with the profile.
  await tx.user.delete({ where: { id: driver.userId } });
} else {
  // Dual-role staff (OPERATOR / TENANT_ADMIN acting as driver): NEVER delete the
  // login (owner decision 2026-08-28 — deleting the admin's driver profile must not
  // nuke the tenant's admin account, and restrict-FKs on User made the whole tx roll
  // back silently, which is why deleted admin drivers "kept coming back"). Clear the
  // capability flag so Settings/nav stop offering driver surfaces and
  // toggleDriverPermit cannot silently resurrect the row.
  await tx.user.update({ where: { id: driver.userId }, data: { canActAsDriver: false } });
}
```

4. `users.service.toggleDriverPermit` (users.service.ts ~L238-253) is INTENTIONALLY unchanged —
   it is the explicit opt-in that recreates a Driver row when the operator flips it back on.
5. Add a `describe("remove")` block to drivers.service.spec.ts (match the file's existing
   mocking style): (a) DRIVER-role linked user → driver + user both deleted; (b) TENANT_ADMIN
   linked user → driver deleted, user NOT deleted, `canActAsDriver` set false; (c) scheduled/in-
   progress run still throws (existing guard preserved).

Acceptance criteria:

- [ ] Deleting a dual-role user's driver row never touches `user.delete` and sets canActAsDriver=false in the same tx
- [ ] Pure DRIVER deletion behavior unchanged
- [ ] New spec block passes; existing drivers specs pass

### WPC — API: propagate capability claims into req.user

Files:

- `apps/api/src/auth/strategies/jwt.strategy.ts`

`validate()` builds `req.user` from the JWT payload but omits `canActAsDriver` and `isAdmin`,
so `RolesGuard`'s dual-role branch (`apps/api/src/auth/guards/roles.guard.ts` ~L42-48:
operators/tenant-admins with canActAsDriver also satisfy DRIVER) can never fire. Add both
fields, mirroring how the payload carries them (`apps/api/src/auth/jwt-payload.interface.ts`):

```ts
canActAsDriver: (payload.canActAsDriver as boolean | undefined) ?? false,
isAdmin: (payload.isAdmin as boolean | undefined) ?? false,
```

(Adapt to the file's existing style — read the current `validate()` return object and extend
it; do not restructure.) This only WIDENS access for intended dual-role users; nobody who
passes today starts failing. Note: the flag is minted at login, so a driver-permit change still
needs re-login — matching the existing Settings toast copy.

Acceptance criteria:

- [ ] req.user carries canActAsDriver + isAdmin after validate()
- [ ] Existing auth/roles specs pass (extend a jwt.strategy/roles.guard spec if one exists and
      it is cheap; do not build new infrastructure)

### WPD — Web: impersonation identity becomes reactive + consistent entry/exit

Files:

- `apps/web/lib/impersonation.ts`
- `apps/web/lib/auth-context.tsx`
- `apps/web/components/tenant-provider.tsx`
- `apps/web/app/(platform-admin)/admin/tenants/page.tsx`
- `apps/web/app/(platform-admin)/admin/tenants/[id]/page.tsx`
- `apps/web/app/(dashboard)/layout.tsx` (ONLY the ImpersonationBanner component region,
  ~L947-990 — do not touch nav/RouteGuard/shortcut code)

1. `lib/impersonation.ts`:
   - Fix `parseExp` base64url decoding (currently `atob` on a raw segment throws on `-`/`_`,
     leaving `expired: false` forever):
     ```ts
     const seg = (token.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
     const payload = JSON.parse(atob(seg));
     ```
   - Carry the acting identity: add `USERNAME_KEY = "impersonationUsername"`; extend
     `ImpersonationState` with `username: string | null`; `setImpersonation(token, slug,
username?: string)` stores/removes it; `getImpersonation()` returns it;
     `clearImpersonation()` removes it. Keep the module's "single reader/writer" contract
     comment accurate.
2. `lib/auth-context.tsx`: add a mount effect so the decoded user follows impersonation
   set/clear in THIS tab and across tabs:
   ```tsx
   // Impersonation set/clear swaps the active token without a route change — re-read
   // the decoded identity so the header chip and role gates follow the acting session.
   React.useEffect(() => {
     return subscribeImpersonation(() => setUser(getStoredUser()));
   }, []);
   ```
   (`import { subscribeImpersonation } from "./impersonation";`). Do NOT fall back to
   `refreshTokens()` here — a null read during the transition must not re-pin the old session.
3. `components/tenant-provider.tsx`: in the mount effect (~L152-169), also subscribe the
   existing `recheck` to impersonation changes:
   ```tsx
   const unsubImp = subscribeImpersonation(recheck);
   ```
   (+ cleanup). Update the comment: focus/visibility covers cross-tab; the subscription covers
   same-tab soft navs.
4. `admin/tenants/page.tsx` (list Impersonate handler ~L191-206): match the detail page —
   after `setImpersonation(...)` also `setTenantCookie(tenant.slug)` (same helper the [id]
   page imports) and navigate with `window.location.href = "/dashboard"` instead of
   `router.push`. Pass the acting username: `setImpersonation(res.data.accessToken,
tenant.slug, res.data.impersonatedUser?.username)`.
5. `[id]/page.tsx` impersonate handler (~L1491-1515): pass the username third arg too.
6. `(dashboard)/layout.tsx` ImpersonationBanner:
   - Render the acting identity when known: replace the hardcoded "acting as Tenant Admin"
     with `acting as {imp.username ?? "Tenant Admin"}`.
   - Exit handler (~L963-967): after `clearTenantCookie(); clearImpersonation();`, re-pin the
     cookie from the super-admin's own session slug if one exists (the [id] page / lib/auth
     expose a helper that reads the operator token's tenantSlug — reuse it; if none exists,
     skip re-pin), then `window.location.href = "/admin/tenants"` (hard load) instead of
     `router.push`, so every provider remounts on the operator session.

Acceptance criteria:

- [ ] Impersonating from the tenants LIST updates logo, business name, and user chip (no stale demo branding) — via cookie write + hard reload
- [ ] Same-tab soft impersonation change updates AuthProvider user and TenantProvider branding via the subscription (belt and braces)
- [ ] Exit impersonation hard-reloads onto /admin/tenants with impersonation state fully cleared
- [ ] Banner shows the acting username when the API provides it
- [ ] parseExp handles base64url; expired impersonation now actually reports expired
- [ ] Web typechecks + lints; no changes outside the banner region of layout.tsx

## Explicitly OUT of scope

- `rf_notifications` localStorage key is tenant-global (notification bleed across tenants) — separate task.
- `refreshTokens()` re-pinning the cookie from the operator token — unreachable once WPD lands; leave.
- No queryClient.clear() work — entry/exit are hard reloads after WPD.
- No mobile changes (impersonation is web-only; driver capability changes are server-side).
- No data cleanup scripts — existing ghost driver rows are deleted once via the UI after deploy and now stay gone.

## Verification

- Per round: `npm run check-types`
- Final: `npm run verify` (= turbo run check-types lint test)
- Post-deploy (main session): impersonate bb-distro from the tenants LIST in the owner's browser —
  logo/name/chip must show bb-distro's branding and the acting username; delete the bb-distro
  ghost "admin" driver → verify it stays gone and Settings "Act as driver" reads OFF; verify a
  non-driver admin no longer sees "My Routes" after re-login.
