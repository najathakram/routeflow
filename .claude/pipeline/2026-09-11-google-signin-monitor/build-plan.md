# Build plan — 2026-09-11-google-signin-monitor (dev-pipeline, small)

Status: IMPLEMENTED (light-loop round 1, 2026-09-11) - see "Post-implementation corrections" below

## Preamble (small-scale discovery)

- **Problem.** OPS-23: discovered 2026-09-11 - the Google OAuth client was gone, Google returned
  `deleted_client`, and every Google sign-in (super admin, operators, buyers, mobile) was dead. How
  long it had been broken is unknown, because nothing tested it.
- **User.** The owner and every operator who signs in with Google; the on-call lead.
- **Workaround today.** None automated. `smoke`, `post-deploy-check` and the deploy E2E sign in with
  passwords only; `nightly.yml`'s schedule has been commented out since 2026-08-30.
- **Success signal.** A deleted/misconfigured Google client turns `post-deploy-check` red on the next
  deploy and a scheduled monitor red within 6 h, naming the door and Google's own error code.
- **Non-goals.** Signing in for real (no credentials, no cookies); Playwright; changing the OAuth
  flow; making apex DNS a hard failure before the owner fixes the record (DECIDE-29 item).
- **Deploy day.** Additive scripts + one new workflow. No env change. Local compose has no Google
  config → the check reports `skipped (not configured)` unless `SMOKE_GOOGLE_REQUIRED=1`.
  Against prod the check is required by default (base URL host is not localhost).

## Requirements

| R#  | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                              | Verified by                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| R1  | `checkGoogleSignIn({ baseUrl, tenant, fetchImpl, timeoutMs, expectedHost, required })` probes the platform-admin door `GET /api/v1/platform-admin/auth/google` and the tenant door `GET /api/v1/auth/google?tenant=<slug>`; each returns `{ url }`.                                                                                                                                                                                      | T1                          |
| R2  | For each door it follows the consent URL with one unauthenticated GET (`redirect: "follow"`) and passes only when the final URL host ends with `expectedHost` (default `accounts.google.com`), its pathname does not contain `/signin/oauth/error`, and the body contains none of `deleted_client`, `invalid_client`, `redirect_uri_mismatch`, `Access blocked`. Failure carries `reason` ∈ `deleted_client                              | invalid_client              | redirect_uri_mismatch | oauth_error | wrong_host | not_configured | door_http_<status> | timeout | network` and the final URL. | T1 T2 T4 |
| R3  | A door answering 503 (`isConfigured()` false) is `not_configured`: FAIL when `required`, else `skipped` with a warn line. `required` defaults to true unless the base URL host is `localhost`/`127.0.0.1`, overridable by `SMOKE_GOOGLE_REQUIRED=0/1`.                                                                                                                                                                                   | T3                          |
| R4  | The whole check for both doors completes within `timeoutMs` (default 15 000): one `AbortController` budget shared by all four fetches (L-077).                                                                                                                                                                                                                                                                                           | T5                          |
| R5  | `checkApexDns({ hostname, lookupImpl, required })` resolves `routeflow.info`; ENOTFOUND/EAI_AGAIN → `warn` when not required, FAIL when `SMOKE_APEX_REQUIRED=1`. Default not required (owner flips after fixing DNS).                                                                                                                                                                                                                    | T6                          |
| R6  | `scripts/post-deploy-check.mjs` gains section `6. Google sign-in doors` (uses its existing `TENANT`, `pass()`/`fail()`, `failures` counter) and `7. Apex DNS` (warn/fail per R5). `scripts/smoke.mjs` gains the same Google step after the checks loop (unauth only, no tenant login). Output lines are prefixed `google-signin:` / `apex-dns:`.                                                                                         | T7 (structural) + manual M1 |
| R7  | `scripts/google-signin-monitor.mjs` runs both checks against `SMOKE_BASE_URL` (default prod API) with `SMOKE_TENANT_SLUG` (default `e2e-routeflow`, via `assertTestTenant`), exit 1 on any FAIL. `.github/workflows/google-signin-monitor.yml`: `schedule: "17 */6 * * *"` + `workflow_dispatch`, one job, Node 20, `npm ci --ignore-scripts` is NOT needed — run with plain node (no deps). ≤ 2 min/run.                                | T8 (structural)             |
| R8  | The self-test runs in `npm run verify` after `plane-sync.self-test` (if present on the branch) or after `bugs.mjs self-test`, and never reaches the network (fake API + fake Google via `node:http`, injected `lookupImpl`).                                                                                                                                                                                                             | T1–T6                       |
| R9  | `docs/runbooks/mandatory-dependencies.md`: Google OAuth client (GCP project `routeflow-506615`, brand "RouteFlow", client "RouteFlow Production 2026-09", the 6 redirect URIs, env names on api+web, "secret is set by the owner only", standby-client note, break-glass = password super-admin login), the monitor (where it runs, how to read a red run), apex DNS status, and the restore steps. No secrets, no uuids, no client ids. | grounding + review          |
| R10 | Rate: the check makes ≤ 4 requests to the API per run (well under the 100/60 s global throttle, DECIDE-26).                                                                                                                                                                                                                                                                                                                              | T1 (request count asserted) |

## Test packages

- **TP1** `scripts/lib/google-signin-check.self-test.mjs` — T1–T6 per test-plan.md, fake servers on 127.0.0.1, injected `fetchImpl`/`lookupImpl`, temp nothing (no disk). Exit 1 on any FAIL, prints `google-signin-check.self-test: N ok`.
- **TP2** structural pins inside the same self-test file: T7 (post-deploy-check.mjs and smoke.mjs source contain the `google-signin:` section and import the module), T8 (workflow file exists, has `schedule` + `workflow_dispatch`, runs `scripts/google-signin-monitor.mjs`).

## Work packages

- **WP1** `scripts/lib/google-signin-check.mjs` (new; ESM; exports `checkGoogleSignIn`, `checkApexDns`, `DOORS`, `ERROR_MARKERS`; pure, no process.exit, no console — returns results; caller prints). Hard lines:
  ```js
  export const ERROR_MARKERS = [
    "deleted_client",
    "invalid_client",
    "redirect_uri_mismatch",
    "Access blocked",
  ];
  export const DOORS = (tenant) => [
    { name: "platform-admin", path: "/api/v1/platform-admin/auth/google" },
    { name: "tenant", path: `/api/v1/auth/google?tenant=${encodeURIComponent(tenant)}` },
  ];
  // one AbortController for the whole call; signal passed to every fetch; on abort → reason "timeout"
  // door fetch: status 503 → not_configured; !ok → door_http_<status>; body.url missing → door_http_<status>
  // consent fetch: redirect "follow"; finalUrl = res.url; host check BEFORE body read; body read ≤ 64 KB
  ```
  `satisfies: R1 R2 R3 R4 R5 R10` · `provenBy: T1–T6` · effort medium.
- **WP2** `scripts/post-deploy-check.mjs` sections 6–7, `scripts/smoke.mjs` step; `scripts/google-signin-monitor.mjs` (new, ~40 lines, uses `assertTestTenant` from `scripts/lib/test-tenants.cjs`); `.github/workflows/google-signin-monitor.yml`; `package.json`: scripts `smoke:google` (= monitor) and the verify chain insertion. `dependsOn: WP1` · `satisfies: R6 R7 R8` · `provenBy: T7 T8` · effort low.
- **WP3** `docs/runbooks/mandatory-dependencies.md` + code map rows (INDEX.md convention on master; `.claude/code-map/api.md` untouched) + `_meta.json` updatedAt. `satisfies: R9` · effort low.

## Verify commands

- perRound: `node --check scripts/lib/google-signin-check.mjs` (+ self-test, monitor, when present); `npx prettier --check scripts/lib scripts/smoke.mjs scripts/post-deploy-check.mjs scripts/google-signin-monitor.mjs .github/workflows/google-signin-monitor.yml package.json docs/runbooks`
- final: `node scripts/lib/google-signin-check.self-test.mjs` (guarded `existsSync` → "not yet created"); `node scripts/campaign/bugs.mjs self-test`; `SMOKE_BASE_URL=http://localhost:3000 node scripts/smoke.mjs` is NOT a gate (needs the compose stack) — manual M1.

## Manual verification

| Token | What is checked by hand                                                                                                                                                                                                                                                                                                 |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1    | `npm run local:validate` against the compose stack prints `google-signin: skipped (not configured)` and stays green; `SMOKE_BASE_URL=<prod api> node scripts/google-signin-monitor.mjs` prints the two doors' final Google URLs and exits 0 once the new client is live (exit 1 with `deleted_client` while it is not). |

## Pipeline args (see pipeline-args.json)

## Post-implementation corrections (light-loop round 1, Opus review)

The Opus refute-first review found the classifier could not name the real production failure and
that `ok` was a pass-by-absence-of-evidence. Fable ruled five targeted fixes (D1-D5); all landed
with targeted edits, and the prod oracle now names `deleted_client` on both doors.

| D#  | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | New pins                                                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `scripts/lib/google-signin-check.mjs`: classify from the FINAL URL first - new exported `decodeAuthError(url)` base64url-decodes every `authError`/`error` value and the markers are scanned against decoded-union-raw query string, before any body read. Verified against prod 2026-09-11: the `/signin/oauth/error` document is ~773 KB and carries the literal only ~700 KB in, so the 64 KB body scan (kept, as a documented fallback) could never see it.                                                                                                                                                                                                                                                                                                                                                                                                                               | T2/D1 x4 URL-marker cases (prod `authError` blob verbatim, encoded `invalid_client`, encoded `redirect_uri_mismatch`, plain `error=access_denied`) each over a >70 KB marker-free body; three `decodeAuthError` unit cases. |
| D2  | `ok` now requires a POSITIVE signal: final pathname starts with `/o/oauth2/`, `/signin/oauth/` (non-error), `/v3/signin/`, `/AccountChooser`, `/ServiceLogin`, OR the first 64 KB of body contains `Choose an account` / `identifier`. Otherwise `unexpected_page`. New markers `access_denied` and `restricted to the test users` (both -> reason `access_denied`), scanned in URL and body.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | T4b: 200 on `/some/interstitial` with body "Something went wrong" -> `unexpected_page`. T1's fake now serves a positive path (`/o/oauth2/v2/auth`).                                                                         |
| D3  | `scripts/post-deploy-check.mjs`: the Google-doors and Apex-DNS sections were below the login gate, which `process.exit(1)`s on a missing token - a broken test-tenant password hid a dead Google door. Both hoisted above it and renumbered (2, 3); Login/Protected/Invoice-math/Divergence became 4-7. Pass/fail counting unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | T7/D3 structural: "Google sign-in doors" and "Apex DNS" both appear BEFORE "Cannot continue without auth token"; the section-number pins moved to `2.`/`3.`.                                                                |
| D4  | Door results now carry `finalPage` (origin + pathname) beside the full `finalUrl`; every caller (`google-signin-monitor.mjs`, `smoke.mjs`, `post-deploy-check.mjs`) logs `finalPage` only - the consent query string carries the OAuth client id and state and must never reach a CI log.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | T1/D4: every door's `finalPage` is non-empty and contains no `?`; T2/D1 repeats it per case; T7/D4 + T8/D4 structural: each entry point mentions `door.finalPage` and never `door.finalUrl`.                                |
| D5  | `docs/runbooks/mandatory-dependencies.md`: OPS-23 is dated by its **discovery** (2026-09-11) with no claim about when or why the client was deleted; a "Restoring the client" section records what the outage actually required (new brand -> new Web client -> redirect URIs from the api env incl. the alternate Railway host + `localhost:3000` -> `GOOGLE_CLIENT_ID` on api+web with `--skip-deploys` -> OWNER pastes `GOOGLE_CLIENT_SECRET` -> Audience/Publish -> `npm run smoke:google`); a **Limits** paragraph states the probe is unauthenticated so a Testing-audience or per-user block is NOT detectable; "Reading a red run" is now a table including `unexpected_page` and `access_denied`. `.github/workflows/google-signin-monitor.yml` drops the `setup-node` step (ubuntu-latest ships Node 20) and notes that `schedule:` auto-disables after 60 days of repo inactivity. | T8/D5 structural: the workflow contains no `actions/setup-node`.                                                                                                                                                            |

**Gate results after D1-D5**: `node scripts/lib/google-signin-check.self-test.mjs` -> 117 checks, 0
failures, exit 0. `node scripts/campaign/bugs.mjs self-test` -> all checks passed, exit 0.
`node --check` clean on all five touched `.mjs` files. Prettier `--check` clean.
M1 local: `smoke.mjs` exit 0 with both doors `skipped (not_configured)`; `post-deploy-check.mjs`
against the `test` tenant exit 0 (Google/Apex sections now run before login). **Prod oracle**:
`node scripts/google-signin-monitor.mjs` against the prod API exits 1 with BOTH doors
`deleted_client (https://accounts.google.com/signin/oauth/error)` - no query string printed.

Lessons applied: **L-077** ("a retry loop is only as bounded as its slowest call") - the probe's
budget is still ONE shared `AbortController` across all four fetches, and D1's URL-first
classification removes the temptation to raise the 64 KB body cap and make the slowest call slower
still; the failure reason lands in one fixed place a reader is told to check (the runbook's
"Reading a red run" table). **L-086** ("asserted so the row cannot pass vacuously", oracle read at
test time rather than computed from fixtures) - D2 replaces "not an error page" with a positive
signal so `ok` can no longer pass on absence of evidence, the D1 pins are written to FAIL against a
body-only classifier, and the `deleted_client` fixture is the production `authError` value read off
the real response rather than an invented blob.
