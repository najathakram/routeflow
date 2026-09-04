# Local E2E lane

A pre-PR Playwright pass against the [local Docker stack](../../../docs/adr/0001-local-hosting-environment.md)
(`npm run local:up` — API `:3000`, web `:3001`, Postgres `:5432`). Hosted staging is deferred
(owner, 2026-09-03), so this lane is item 6's "E2E before prod" at **half** — see the ADR's
"Local E2E lane" subsection for the ruling. E2E still reports **authoritatively** only
post-deploy against prod (`ci.yml`'s `deployment_status`-triggered job); this lane exists to
catch a UI/wiring regression **before** that, not to replace it.

## Why this works without new plumbing

- `helpers/api.ts` `apiBase()` rewrites a `:3001` web origin to `:3000` for direct API calls.
- `helpers/auth.ts` `setTenantCookie`/`fillWorkspaceIfShown` already handle a bare `localhost`
  host (`tenant-host.ts` returns `null` for it, so the Workspace field renders and must be
  filled — the login helpers already do this).
- `setup/global.setup.ts` seeds `e2e-routeflow` via `apps/api/scripts/e2e-seed.js`, driven by
  `E2E_SEED_DATABASE_URL`.
- `web`'s Docker image bakes `NEXT_PUBLIC_API_URL=http://localhost:3000/api/v1` at build time,
  so the browser talks straight to the local API.

## How to run

```bash
npm run local:up          # if not already up
npm run local:seed        # seeds e2e-routeflow (idempotent)
npm run local:e2e         # the allow-list below, ≤ 10 min
npm run local:e2e:all     # every project, no --project filter (report only — see below)
```

Both scripts run through `node scripts/local-env.mjs --e2e -- "..."` (the `--e2e` flag), which
sets `PLAYWRIGHT_BASE_URL=http://localhost:3001`, `SMOKE_BASE_URL=http://localhost:3000`,
`PLAYWRIGHT_TENANT_SLUG=e2e-routeflow`, `E2E_SEED_DATABASE_URL=<the compose Postgres URL>`,
`PLAYWRIGHT_JSON_OUTPUT_FILE=<repo-root>/.campaign/runs/web-e2e-local.json` (an absolute path),
and unsets `CI`. To run a subset by hand, use the same wrapper directly:

```bash
node scripts/local-env.mjs --e2e -- "npm --prefix apps/web run test:e2e -- --project=setup --project=critical-paths"
```

## The allow-list (`local:e2e`)

`setup` plus the money/guard projects, trimmed to stay ≤ 10 min wall clock on this machine:

| Project                 | Spec                               | Why it's in the local gate                                                                                                       |
| ----------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `setup`                 | `setup/auth.setup.ts`              | Not optional — every other project below depends on it for `operator.json`.                                                      |
| `critical-paths`        | `06-critical-paths.spec.ts`        | The money-math / core-integrity regression set; the primary reason this lane exists. Read-only.                                  |
| `create-order-escape`   | `08-create-order-escape.spec.ts`   | Order-builder Escape/draft flow. Mutating but self-contained (parks then deletes its own draft).                                 |
| `boxed-order-entry`     | `13-boxed-order-entry.spec.ts`     | Cases/pieces proration read live off the order builder — a money-adjacent UI surface with no web unit test behind it. Read-only. |
| `order-edit-pricing`    | `24-order-edit-pricing.spec.ts`    | Pricing-readiness race gate (REG-B62) — money-adjacent, self-contained throwaway fixtures.                                       |
| `payment-truth`         | `22-payment-truth.spec.ts`         | Payment-status truth (REG-B11) — a money-visibility regression with no other proof surface.                                      |
| `destructive-guards`    | `21-destructive-guards.spec.ts`    | Bulk-delete confirm/guard dialogs (REG-B24/B130/B154) — safety-critical, self-contained throwaway fixtures.                      |
| `cancelled-edit-banner` | `27-cancelled-edit-banner.spec.ts` | Edit-window UX truth (REG-B10) — this spec is its only proof, no jest half.                                                      |

Projects needing `PLAYWRIGHT_SA_*` (`super-admin`, `impersonation-signout`) are excluded from
the allow-list — those secrets are not expected to be present on every contributor's machine.
`local:e2e:all` runs everything (no `--project` filter) and is a **report**, not a gate: a
failure in a project outside the allow-list above is recorded in the PR, not fixed by this lane.

If a future addition pushes `local:e2e` past 10 minutes, trim the allow-list here **and** in
root `package.json`'s `local:e2e` script, and say in the PR what was dropped and why.

## The login-rate-limit trap

`POST /auth/login` is throttled `@Throttle({ ttl: 300_000, limit: 10 })` (RF-160: 10 attempts per
5 minutes per IP, `apps/api/src/auth/auth.controller.ts:66`). Every local-stack request — the
Docker host, every Playwright worker, and a developer's own `curl` checks — shares one IP
(`localhost`), so this budget is shared across **everything** hitting `/auth/login` at once, not
per-test. Both `local:e2e` and `local:e2e:all` pass `--workers=1` for exactly this reason —
`playwright.config.ts` defaults to `workers: 2` outside CI, and two workers logging in
concurrently against the same shared throttle burns the 10-request budget twice as fast for no
parallelism benefit the local host can actually use (see the host-contention trap below). `setup`
alone spends 2 (operator + customer); each retry (this config: `retries: 2`)
spends another. A `local:e2e` run that's already retrying because of slow page loads (below) is
simultaneously burning through the same 10-request budget, and a throttled response can present
identically to a bad-credentials one ("Invalid username or password" — enumeration-safety hides
which) rather than a distinct "too many requests" message, so a rate-limited run looks like a
login regression instead of a budget problem. If a login-heavy project fails with that message
after several runs in quick succession, wait out the 5-minute window (no more `/auth/login` calls
of any kind, including manual `curl` checks) before re-running rather than retrying immediately —
retrying only re-arms the same window.

## The host-contention trap

This lane's timeouts (30s navigation, 60s per test) assume the local browser gets real CPU time.
On a machine running other concurrent work — other Claude Code sessions, other worktree builds —
page loads and post-login navigations can blow through those budgets even though the API and web
containers themselves respond in milliseconds (verified: direct `curl` to `/api/v1/health` and
`/login` both returned in under 150ms while a concurrent Playwright run was timing out on the
same page). Rule of thumb: if `curl` is fast but Playwright times out on `page.goto`/
`waitForURL`, suspect host contention before suspecting the app.

## The reporter-path trap

`apps/web/playwright.config.ts`'s `json` reporter writes to a path resolved **relative to the
config file's directory** (`apps/web/`): `../../.campaign/runs/web-e2e.json` lands at repo-root
`.campaign/runs/web-e2e.json`. `scripts/campaign-check.mjs` reads that file as the bug-register
campaign's mechanical proof of which `REG-B###` tests passed. A local run must never write
there — clobbering it with a partial local run (which never runs every project, and runs against
a different tenant/build) would silently poison the campaign gate.

**Verified against the actual reporter code, not assumed.** `playwright.config.ts` keeps
master's hardcoded `outputFile: "../../.campaign/runs/web-e2e.json"` unchanged —
`PLAYWRIGHT_JSON_OUTPUT_NAME` (an earlier, incorrect guess at the override var) is never read by
the JSON reporter at all; it only feeds an `OUTPUT_DIR`/`OUTPUT_NAME` fallback pair used when a
reporter has no `outputFile` configured. The var that actually redirects the JSON reporter's
output file is `PLAYWRIGHT_JSON_OUTPUT_FILE`, and `resolveOutputFile()` in
`node_modules/playwright/lib/runner/index.js` checks it **before** the config's `outputFile`
(line 1520 `resolveFromEnv('PLAYWRIGHT_JSON_OUTPUT_FILE')` runs first; line 1521 only falls back
to `options.outputFile` when that env var is unset) — so the config can stay literally identical
to master and `local-env.mjs --e2e` still redirects local runs to `web-e2e-local.json` by setting
that env var. `resolveFromEnv` resolves relative to `process.cwd()` (line 1515), not the config
file's directory, so `local-env.mjs` computes an **absolute** path
(`<repo-root>/.campaign/runs/web-e2e-local.json`) from its own file location rather than a
`../../`-relative one — a relative value here would depend on whatever cwd the child process
happens to run from. `scripts/campaign-check.mjs` carries a one-line pointer to this file for
exactly that reason.

## Shared auth state audit (item 6a)

Sweep of every `logout`/`password` hit in specs 01, 02, 03, 04, 05, 07 (the ones flagged by the
06a brief) — what each call actually does, and whether it reaches the server for the **shared**
seed identities (`admin`/`Admin@123`, `harbor_cafe`/`Customer1!`, `e2e_admin`/`TenantAdmin1!`).
Only `/auth/sessions` revoke calls (specs 31/32) were found to mutate shared server-side auth
state — confirmed below, not assumed.

| Spec                       | Calls found                                                                                                                              | What they actually do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Mutates shared server-side auth state?                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `01-super-admin.spec.ts`   | `logout(page)` (afterEach); SA-11 clicks the platform-admin sidebar's real "Sign out" button                                             | `logout(page)` is the test helper — clears localStorage tokens client-side only, no network call. SA-11's button calls `(platform-admin)/layout.tsx`'s `handleLogout`, which is **also** client-only (`localStorage.removeItem("superAdminToken")` + `router.push`) — verified no `/auth/logout` or any POST behind it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | No.                                                                                                                                 |
| `02-operator.spec.ts`      | `logout(page)` (afterEach + several tests); OP-22 looks for a "Sign out" button                                                          | `logout(page)` is the client-only helper. OP-22's `logoutBtn` is `page.getByRole("button", { name: /log ?out\|sign ?out/i }).or(page.getByText(/log ?out\|sign ?out/i))`. The `getByRole` half targets the avatar-menu "Sign out" `DropdownMenu.Item` (`(dashboard)/layout.tsx:970`, which calls the real `lib/auth.ts` `logout()` → `POST /auth/logout`) — that item lives inside a Radix `DropdownMenu.Content`, unmounted until the trigger is clicked, and OP-22 never opens the menu. But the sign-out locator's `getByText(/sign ?out/i)` half can match visible text (not gated behind role or menu-open state); in the current spec flow it resolves to a client-only branch (verified by reading, not executed) — `logoutBtn.first().isVisible()` is `false` and the test falls through to the safe `else` branch (`logout(page)` + `goto`). | No, as currently written (worth re-verifying by running the test if OP-22 or the page it visits ever changes what text is visible). |
| `03-customer.spec.ts`      | `logout(page)` (once)                                                                                                                    | Client-only helper, no UI button click.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | No.                                                                                                                                 |
| `04-buyer-portal.spec.ts`  | Password fields (register/login), `logout(page)`, BY-13's own "Sign out" button                                                          | The buyer identity is `uniqueBuyerEmail()` — a fresh, per-run-generated account, not a shared seed user. Even if BY-13's button reaches the real `buyer-auth.ts` server logout (`/buyer/auth/logout`), it only revokes that spec-created buyer's own session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | No — no shared identity is even in play.                                                                                            |
| `05-cross-cutting.spec.ts` | `logout(page)` ×4 (CC-04, CC-05, CC-09, CC-10)                                                                                           | All four uses are the client-only helper; CC-05's impersonation check is a read-only GET against production reads (audit-logged, non-destructive). No UI "Sign out" click anywhere in this file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | No.                                                                                                                                 |
| `07-auth-password.spec.ts` | `logout(page)` (afterEach); AP-06 fills the shared operator's correct password into the re-auth dialog; AP-07 fills mismatched passwords | `afterEach`'s `logout(page)` is client-only. AP-06's "Unlock and continue" is a **login-style** re-auth (issues a fresh token pair) — additive, not a revoke; it does not invalidate any other running test's session. AP-07 only ever reaches a client-side "Passwords do not match" validation error — the code comment ("Client-side mismatch validation — no server mutation") is corroborated by the test never filling a matching pair before submit, so no `PATCH`/`POST` password-change ever fires. The file's own header note ("no test here mutates the seeded operator's password") holds.                                                                                                                                                                                                                                                | No.                                                                                                                                 |

Conclusion: none of 01/02/03/04/05/07 needed a dedicated seeded user. Of specs 31 and 32, only
spec 32 revokes `/auth/sessions` rows server-side (L-050) against an identity it can't share —
it gets its own seeded operator (`e2e_sessions_op`; see `apps/api/scripts/e2e-seed.js`) instead
of the shared `admin` account every `storageState: operator.json` project also loads. Spec 31
mutates only its own fresh session (the impersonation token it creates and exits within the
test), so it stayed on the shared `e2e_admin` TENANT_ADMIN, as on master — no dedicated identity
needed, and `e2e-routeflow` holds exactly one `ACTIVE` `TENANT_ADMIN` again.

If your local compose Postgres still has an `e2e_impersonated_admin` row from an earlier seed
run (before this revert), it's harmless but stale — `npm run local:reset` wipes the volumes and
drops it along with the rest of the DB (not run here; do so if you want a clean slate).
