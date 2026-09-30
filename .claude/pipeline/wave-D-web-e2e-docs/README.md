# Wave D — web tests, E2E, docs, dependencies (one PR)

Branch `test/imp-wave-d-web-e2e-docs` from `master` after Wave B lands (no hard dependency on B —
only the lockfile and `CLAUDE.md` are shared, so branching after B avoids a rebase). Commit type
`test:`; subject: `test(web,e2e): wave D — web Jest+RTL, local E2E lane, docs, dead deps` (69).
Loop: **light** — Sonnet builds package-by-package from the briefs; one Opus `high` refute-first
review (security lens on the E2E users; docs-truth lens on README/CLAUDE.md); gates; Fable rules.

## Items

| Item                                                        | Brief                                                      |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| 5a + 5b web Jest + RTL infra, `lib/` specs, component specs | `../2026-09-03-imp-05-web-jest/brief.md`                   |
| 6b local E2E lane                                           | `../2026-09-03-imp-06b-local-e2e-lane/brief.md`            |
| 6a dedicated E2E users; un-quarantine 31/32                 | `../2026-09-03-imp-06a-e2e-dedicated-users/brief.md`       |
| 4 + 7 ADR 0002, delete `deploy-staging.yml`, PR template    | `../2026-09-03-imp-04-07-staging-adr-local-gate/brief.md`  |
| 8 flip runbook + retirement checklist                       | `../2026-09-03-imp-08-flip-reconcile-runbook/brief.md`     |
| 11 README rewrite, CLAUDE.md slim, dead deps                | `../2026-09-03-imp-11-readme-claude-md-dead-deps/brief.md` |

## Combined ownership (build order; each package = one Sonnet agent, ≤ 2 concurrent)

1. `pD1` dependencies + lockfile (**owns root/apps `package.json` + `package-lock.json`**): add web test devDeps (5a), remove `zustand`/`@nestjs/axios`/`passport-google-oauth20`/`@types/passport-google-oauth20` (11), add root scripts `local:e2e`, `local:e2e:all` (6b) — one real `npm install`; lock-edge `missing 0`; mobile `react-test-renderer` pin untouched.
2. `pD2` web Jest infra + `lib/` specs (5a) → `pD3` component specs (5b).
3. `pD4` local E2E lane files (6b: `apps/web/e2e/LOCAL-LANE.md`, `campaign-check.mjs` comment) → `pD5` E2E users (6a: `e2e-seed.js`, `constants.ts`, specs 31/32, `playwright.config.ts`, the `logout`/`password` audit list in the PR body).
4. `pD6` docs A (4+7: ADR 0002, delete `deploy-staging.yml`, `railway-deployment.md` banner, PR template) and `pD7` docs B (8: runbook; `CLAUDE.md:182-251`; rebuild `SKILL.md` 4 sites; `ci.yml` header sentence) and `pD8` docs C (11: README; remaining `CLAUDE.md` slim incl. `:13` Zustand, `:122` cap wording) — **`CLAUDE.md` is owned by `pD7`**, which applies 11's `CLAUDE.md` edits too (pD8 hands it the list).
5. `pD9` bookkeeping: code map (`web.md`, scripts), `_meta.json`, `docs/IMPROVEMENTS.md` Status rows 4/5/6/7/8/11, lessons `updatedAt` (+ archive 3–4 aged entries if headroom < 3 KB), `validate-lessons` exit 0.

## Gates

`npm run verify` (web now contributes Jest); `npm test -w apps/web` (≥ 17 spec files); local stack:
`npm run local:e2e` ≤ 10 min green ×3 (6a acceptance on the lane), `local:e2e:all` completes with the
per-project table; `local:validate`; `npm ci` from a wiped `node_modules` (dep removals); Opus review
verdict SHIP; ship with `PLAYWRIGHT_SA_*` presence stated (`gh secret list`).

## Findings for later

Flagged during pD9a (bookkeeping) but out of this package's scope — carried forward for whoever
picks them up:

- **Two React instances in the dependency tree, not fixed here.** `apps/web/package.json` still
  pins `"react"`/`"react-dom"` at `^18`, its own `@types/react` is `~19.2.2`, and root
  `package.json` hoists `react@19.2.5` — so npm installs a nested `apps/web/node_modules/react@18.3.1`
  alongside the hoisted React 19 the rest of the tree runs, while there is only one `react-dom`
  (root's 18.3.1). `apps/web/jest.config.js`'s `moduleNameMapper` works around this for the test
  run only (forces a single `react` resolution so `@routeflow/ui`'s Radix components don't crash
  with "Cannot read properties of undefined (reading 'ReactCurrentDispatcher')"), but the
  underlying `^18` vs `~19.2.2` range drift in `apps/web/package.json` is untouched — a real
  dependency bug. `docs/IMPROVEMENTS.md` item 10 already names "the React 18 vs 19 split... is a
  hoisting hack worth revisiting"; this is routed to **Wave E's React-pin ruling** rather than
  fixed as a side effect of adding tests.
- **`NEXT_IGNORE_INCORRECT_LOCKFILE=1` opt-out in `apps/web/jest.config.js`.** `next/jest` tries to
  auto-patch `package-lock.json` when a platform `@next/swc` optionalDependency entry looks
  missing, which requires a live call to the npm registry — unavailable in this build/CI
  environment, and the call throws (`TypeError: Cannot read properties of undefined (reading
'os')`), aborting Jest's config load entirely. The env var is set only if unset
  (`process.env.NEXT_IGNORE_INCORRECT_LOCKFILE ?? "1"`) so a caller can still override it, and the
  actual lockfile is pD1's — not touched by this package. Worth revisiting if `next/jest` ever adds
  an offline-safe check, or if the lockfile's `@next/swc` entries genuinely drift.
- **ARCHITECTURE/IMPROVEMENTS docs still mentioning `deploy-staging.yml`.** A repo-wide grep
  (`grep -rl deploy-staging docs/ README.md CLAUDE.md`) found four hits: `docs/adr/0002-staging-
environment.md` (correct — deliberately describes the dead workflow's design as historical
  context) and three prose fixes, two done in THIS package —
  `docs/ARCHITECTURE_REVERSE_ENGINEERING.md:286` had a dead markdown link to the deleted file
  (`deploy-staging.yml:9`); reworded to "deleted in wave D — see ADR 0002" and dropped the link.
  `docs/IMPROVEMENTS.md` item 11's own text now reads past-tense ("was dormant" / "deleted
  outright"). **Left unfixed, out of this package's ownership:**
  `docs/railway-deployment.md:249` — a secrets table still lists `RAILWAY_TOKEN` as "Used by
  `deploy-staging.yml`" present-tense; that file isn't in pD9a's owned-files list and pD6 (wave
  README item 4+7, "railway-deployment.md banner") only added a banner note, 5 lines, not this
  table row. Whoever owns that file next should apply the same "deleted in wave D — see ADR 0002"
  treatment to that row.

## Run record

Packages pD1–pD9, all Sonnet 5 agents; effort `high` on pD3/pD5 (the two with the largest
correctness/security surface — a full component-test suite, and the shared-auth-state E2E fix),
`medium`/`low` on the rest (docs and bookkeeping packages at `low`, everything else `medium`).

| Package | Model / effort    | Delivered                                                                                                                                                                                                                         |
| ------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pD1     | Sonnet 5 / medium | Root scripts `local:e2e`/`local:e2e:all`; web test devDeps (jest, RTL); removed 4 dead deps (`zustand`, `@nestjs/axios`, `passport-google-oauth20`, `@types/passport-google-oauth20`); real `npm install`, lock-edge `missing 0`. |
| pD2     | Sonnet 5 / medium | Web Jest infra (`jest.config.js`, `jest.setup.ts`, Windows rootDir-glob trap documented) + 4 `lib/` unit spec files (`api-client`, `format`, `formatting`, `tenant-host`).                                                        |
| pD3     | Sonnet 5 / high   | 15 RTL component/page spec files across auth, buyer, and dashboard forms/modals.                                                                                                                                                  |
| pD4     | Sonnet 5 / medium | Local E2E lane docs (`apps/web/e2e/LOCAL-LANE.md`) and the `scripts/campaign-check.mjs` pointer comment separating campaign evidence from local-run output.                                                                       |
| pD5     | Sonnet 5 / high   | Dedicated E2E identities (`e2e-seed.js` two new users, `constants.ts` CREDENTIALS entries), un-quarantined specs 31/32 in `playwright.config.ts` (L-050), plus the shared-auth-state audit of specs 01–07.                        |
| pD6     | Sonnet 5 / medium | ADR 0002 (staging environment, design-of-record/deferred), deleted `deploy-staging.yml`, `railway-deployment.md` banner note, PR-template checklist line.                                                                         |
| pD7     | Sonnet 5 / medium | Deploy-visibility-flip runbook (`docs/runbooks/deploy-visibility-flip.md`), `CLAUDE.md:182-251` deploy-flow rewrite, `rebuild` skill (4 sites), `ci.yml` header sentence.                                                         |
| pD8     | Sonnet 5 / medium | README rewrite, remaining `CLAUDE.md` slim (Zustand mention dropped, lessons-cap wording), `docs-truth.spec.ts` + `no-dead-deps.spec.ts` static tripwires.                                                                        |
| pD9a    | Sonnet 5 / low    | Code-map bookkeeping (first half): `web.md` Jest section, `api.md` docs-truth/no-dead-deps entries, `INDEX.md`, `docs/IMPROVEMENTS.md` Status rows 4/5/7/8/11, lessons L-054.                                                     |
| pD9b    | Sonnet 5 / low    | Code-map bookkeeping (second half, this package): `web.md`/`api.md` local-lane + dedicated-user entries, `docs/IMPROVEMENTS.md` row 6, `railway-deployment.md` stale secrets-table row, this Run record, cost-ledger append.      |

**Gate status so far** (from the files): web unit tests at 19 spec files / 92 tests; API gains
the `docs-truth.spec.ts` + `no-dead-deps.spec.ts` static tripwires; dependency-removal lock-edge
validator reports `missing 0`.

**Open items (not yet done by this wave):**

- **Local-lane acceptance runs** — the `npm run local:e2e` ≤10-min-green-×3 acceptance bar named
  in this README's Gates section has not completed clean: runs so far were blocked by host CPU
  saturation (concurrent sessions/builds blowing Playwright's navigation timeouts even though the
  containers themselves respond in milliseconds — see `LOCAL-LANE.md`'s host-contention trap) and
  by `/auth/login` throttle exhaustion (`@Throttle` 10/5min shared across the whole local-stack
  IP — see `LOCAL-LANE.md`'s login-rate-limit trap). To be re-run when the host is quiet.
- **Opus `high` refute-first review** (security lens on the E2E users; docs-truth lens on
  README/CLAUDE.md) — not yet run.
- **JIT rebase + ship** — not yet done.

**Residual risk flagged by pD5** (carried into `LOCAL-LANE.md` and the `web.md` code-map entry
for spec 31, not fixed by this wave): `e2e-routeflow` now carries **two** ACTIVE
`TENANT_ADMIN`s (`e2e_admin`, `e2e_impersonated_admin`), and `platform-admin.service.ts
impersonate()` resolves the tenant's admin with an **unordered** `findFirst` (no `orderBy`) — so
spec 31 (`impersonation-signout`)'s outcome depends on which admin Postgres happens to return.
The spec carries a defensive `test.skip` for exactly this case, so a wrong resolution shows up as
a **skip, not a failure** — but it means the spec's pass/skip result isn't fully deterministic
until `impersonate()` gets an explicit ordering.
