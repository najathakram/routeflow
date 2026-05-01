# F10-SECURITY

## RFs addressed

| RF | Sev | Status | Files | Commit | Test added | Migration? |
|----|-----|--------|-------|--------|------------|------------|
| RF-081 | P1 | ✅ | `returns.controller.ts`, `returns.service.ts` | fix(security): RF-081/093/160/228 security hardening | ✅ 4 tests | No |
| RF-093 | P1 | ✅ (confirmed) | `auth/guards/jwt-auth.guard.ts` | — (already implemented) | ✅ 3 tests | No |
| RF-160 | P1 | ✅ | `common/throttler-exception.filter.ts`, `main.ts` | same | ✅ 3 tests | No |
| RF-228 | P2 | ✅ server-side (sessions API already present); client-side documented below | `auth.controller.ts` (existing) | — | — | No |

## Notes / blockers

### RF-081 — IDOR fix
- `GET /returns/:id` now requires role `OPERATOR | TENANT_ADMIN | CUSTOMER`. `DRIVER` is no longer allowed.
- A new `findOneForUser(id, user)` service method wraps `findOne()` and, for the `CUSTOMER` role, resolves the caller's `customerId` from the JWT `sub` (same pattern introduced by F1) and compares it to `return.customerId`. A mismatch throws `ForbiddenException`.

### RF-093 — forcePasswordChange enforcement
- Already correctly implemented in `jwt-auth.guard.ts` (`handleRequest` hook). The guard throws `ForbiddenException` for any route except `POST /auth/change-password` when `user.forcePasswordChange === true`.
- Confirmed with 3 unit tests covering: block on arbitrary route, pass-through on change-password, and normal token.

### RF-160 — Retry-After header
- New `ThrottlerExceptionFilter` (`src/common/throttler-exception.filter.ts`) catches `ThrottlerException` and emits `Retry-After` header.
- Login path (`/auth/login`) gets `Retry-After: 300` (matches the 5-min throttle window). All other paths get `Retry-After: 60`.
- Registered globally via `app.useGlobalFilters()` in `main.ts`.
- Response body also includes `retryAfter` field for programmatic clients.

### RF-228 — Concurrent session detection
- **Server side**: `GET /auth/sessions` and `DELETE /auth/sessions/:id` are already implemented (session management exists). No per-session cap was added — the existing model (one refresh token per device login, revocable per-session) is sufficient; forced session cap is invasive and deferred.
- **Client side (mobile/web)**: Out of scope for this API worker. The storage-event listener approach (F5) should show a "Signed in elsewhere" toast when `localStorage` token changes in another tab. The server session-list endpoint supports explicit cross-device management.
- **Decision documented**: No server-side concurrent session cap implemented. Rationale: existing session model already allows fine-grained revocation; hard cap (N sessions) adds complexity and would break legitimate multi-device usage without a business requirement specifying N.

## User-visible proof of fix

- **RF-081**: `curl -H "Authorization: Bearer <driver_token>" GET /api/v1/returns/<any-id>` → HTTP 403 Forbidden.
- **RF-093**: Any request with a `forcePasswordChange: true` JWT to a non-change-password endpoint → HTTP 403 "Password change required."
- **RF-160**: Exceed login rate limit → HTTP 429 with `Retry-After: 300` header in response.
- **RF-228 server**: `GET /api/v1/auth/sessions` lists active sessions; `DELETE /api/v1/auth/sessions/:id` revokes a specific session.
