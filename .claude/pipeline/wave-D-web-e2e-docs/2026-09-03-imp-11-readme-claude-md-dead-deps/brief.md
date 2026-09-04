# Brief — PR-14 · Item 11: README rewrite, CLAUDE.md slim, dead dependencies (light loop)

Branch `chore/imp-11-readme-claude-md-dead-deps` (after PR-13). Commit type `chore:`. Scale
small–medium (lockfile change). Loop: Sonnet builds → Opus `high` review → gates.

## Facts (surveyed)

`README.md` (219 lines): `:154` "main is production-ready" (trunk is `master`; no `main`/`develop`
exist); `:40` clone URL uses remote `najathakram1` (origin is `najathakram/routeflow`);
`:213-219` CI/CD table lists `deploy-staging.yml`/`deploy-production.yml` as active GHCR→Railway
pipelines (staging deleted in PR-12; production is dispatch-only reference) and `:217` says
"Every push + PRs to main" (actual: PR-to-master only; no push trigger). `CLAUDE.md`: 288 lines /
18,734 B; after PR-13 the flip section is ~15 lines; remaining dated narrative elsewhere is
minor; `:13` lists "Zustand" in the web stack line; `:122` says "≤ 40 active entries / ~25 KB"
(the enforced cap is 40,960 B). No root `CHANGELOG.md` (`.claude/code-map/CHANGELOG.md` is the
map's own log — wrong home for operational history; PR-13's runbook is the home). Dead deps (**verified 2026-09-03**, repo-wide grep excluding lockfile; zero references in
source, config, Dockerfiles, scripts, eslint/tsconfig; `npm ls` shows a single dependent each):
`zustand` (`apps/web/package.json:52` — mobile declares and uses its own copy, unaffected),
`@nestjs/axios` (`apps/api/package.json:37`; no `HttpModule`/`HttpService`; outbound HTTP goes
through vendor SDKs), `passport-google-oauth20` (`:76`) + `@types/passport-google-oauth20` (`:57`)
(Google OAuth is `google-auth-library`'s `OAuth2Client` in `auth/google-oauth.service.ts:11`; no
`GoogleStrategy` class exists; `auth.module.ts:40-41` registers only Local + Jwt strategies).
`validate-lock-edges.mjs:437-453` prints `… missing N …` and exits 0 only at `missing 0` — the
proof line. `sharp`, `reflect-metadata` are
real imports — keep. Stop-hook gates never parse README/CLAUDE.md content (they check code-map and
lessons touches), but their messages name the "code-map routine" and "lessons-learned routine" —
those sections must remain.

## Requirements

| R#  | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Verified by |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| R1  | `README.md` rewritten to reality, ≤ 160 lines: what RouteFlow is (2 lines); stack (from CLAUDE.md's table, condensed); getting started (`npm ci`, `npm run db:up`, `npm run dev`; the local full-stack runbook pointer to ADR 0001 / CLAUDE.md); branch model (`master` trunk, PRs from `feat/*`/`fix/*`, Conventional Commits, `npm run verify` pre-push); CI/CD as it is: one `verify` job on PRs → squash-merge → Railway auto-deploy per service (`watchPatterns`) → `deployment_status`-triggered Playwright E2E; the public-window note points at `docs/runbooks/deploy-visibility-flip.md`; clone URL `najathakram/routeflow`; a "Docs" list (CLAUDE.md, ADRs, runbooks, IMPROVEMENTS.md, ARCHITECTURE_REVERSE_ENGINEERING.md). No GHCR table, no `main`/`develop`, no dormant workflow claims. | T1, review  |
| R2  | `CLAUDE.md`: `:13` drop "Zustand" (web state = TanStack Query + context); `:122` → "≤ 40 active entries / 40,960 bytes (enforced by `scripts/validate-lessons.mjs`)"; any remaining dated "UPDATE"/"CORRECTED" incident prose outside the deploy section moved to the runbook or deleted; every section the stop-hook messages name (Code map routine, Lessons learned routine) stays with its meaning intact; file ≤ 250 lines after the edit.                                                                                                                                                                                                                                                                                                                                                        | T1, review  |
| R3  | Remove all four: `zustand` from `apps/web/package.json`; `@nestjs/axios`, `passport-google-oauth20`, `@types/passport-google-oauth20` from `apps/api/package.json` (each verified zero-reference; each has a single dependent). Real `npm install` (never `--package-lock-only`); `node scripts/validate-lock-edges.mjs` → `missing 0`; `npm ls zustand` still shows mobile's copy; mobile's `react-test-renderer` pin untouched.                                                                                                                                                                                                                                                                                                                                                                      | T2, A1      |
| R4  | Bookkeeping: `docs/IMPROVEMENTS.md` row 11 `shipped (PR-14)` and item 11's zustand line updated with the two API deps; code-map `web.md`/`api.md` dependency notes if the map records deps; `_meta.json`; lessons `updatedAt` (chore).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | review      |

## Tests

- **T1** `apps/api/src/common/docs-truth.spec.ts` (static; lives in the API project because the
  repo has no root runner): `README.md` contains `najathakram/routeflow`, does not contain
  `najathakram1`, `deploy-staging.yml`, `develop`, or the phrase `main is production-ready`;
  contains `deployment_status`; `CLAUDE.md` does not contain `Zustand` and contains `40,960` (or
  `40960`) in the lessons section. Before: README contains `najathakram1` (fails on its own value).
- **T2** `apps/api/src/common/no-dead-deps.spec.ts` (static): for each removed package name, no
  `package.json` under `apps/*` lists it, and `grep` over `apps/*/src|lib|app` finds no import
  specifier for it. Before: `apps/web/package.json` lists `zustand` (fails).

## Acceptance

- A1: `npm ci` clean from a wiped `node_modules` (agent runs it in the main checkout only after
  the engine run is closed); `npm run verify` green; `npm run local:up` builds both images (no
  removed dep is needed at build); `post-deploy-check` green after deploy.
- A2: Opus review reads the new README against `ci.yml`, `railway.toml`s and CLAUDE.md for any
  claim the tree contradicts.

## Files

`README.md`; `CLAUDE.md`; `apps/web/package.json`; `apps/api/package.json`; `package-lock.json`;
two specs; `docs/IMPROVEMENTS.md`; bookkeeping.
