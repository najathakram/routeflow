# Brief — PR-11 · Item 9 + P4-a: `SKIP_VERIFY` audit, failures together, API health SHA gate

Branch `feat/imp-09-verify-bypass-audit-and-health-sha` (after PR-10). Commit type `feat:`.
Scale small (production files: `app.service.ts`, `.husky/pre-push`, `ci.yml`, one script). Light
loop: Sonnet builds → Opus `high` review → gates.

## Why

- `.husky/pre-push:47-52`: `SKIP_VERIFY=1` prints two warnings and `exit 0` — no reason, no
  record. The file's own header keeps the hatch ("Emergency escape hatch… loud… deliberately does
  NOT record a verification marker"). Ruling: keep the hatch for code pushes (it is the only exit
  when `verify` itself is broken), require a reason, write an audit line; docs-only pushes need no
  reason. CI (`npm run verify` in the one job) remains the authority.
- Root `verify` runs `turbo run check-types lint test --concurrency=2` (turbo 2.10.12) with no
  `--continue`, so the first failing task hides the rest. Ruling: **no CI job split** (contradicts
  `ci.yml:1-63`'s measured one-job decision while private minutes are constrained);
  `--continue=dependencies-successful` in the one invocation, byte-identical in hook and CI.
- P4-a: `apps/api/src/app.service.ts` `healthCheck()` returns `{ status, timestamp }`; no commit-sha
  env is read anywhere in `apps/api`. `apps/web/app/api/health/route.ts` already returns
  `sha: process.env.RAILWAY_GIT_COMMIT_SHA ?? null` at request time (Railway injects it into the
  running container; no Dockerfile change). `ci.yml`'s readiness gate (e2e job, ~~:468-622) checks
  the web sha against `EXPECTED_SHA = ${{ github.event.deployment.sha || github.sha }}` with a
  tolerance branch (`git diff --name-only <deployed> <expected> -- apps/web packages` empty ⇒
  pass) and probes the API for reachability only — its own "KNOWN LIMITATION" comment (~~:463-467).

## Requirements

| R#  | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Verified by |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| R1  | `scripts/skip-verify-audit.mjs` (new, node, no deps): reads env `SKIP_VERIFY_REASON`, `RF_BRANCH`, `RF_HEAD`, `RF_CHANGED_FILES` (newline-separated), `RF_AUDIT_LOG` (path). Classifies `docsOnly` = every path matches `^(docs/                                                                                                                                                                                                                                                                                                                                                                                                                                                              | \.claude/   | .*\.md$                                                                              | CHANGELOG | README)`. If not docs-only and `SKIP_VERIFY_REASON`is empty/whitespace → prints`SKIP_VERIFY needs SKIP_VERIFY_REASON="<why>" for a push that touches code (apps/, packages/, scripts/, .github/)`to stderr, exit 1. Otherwise appends one line`ISO | <branch> | <head>                                                                                                                                                                                                                                                     | docs-only=<yes/no> | <reason or "docs-only">`to`RF_AUDIT_LOG`(creating it), prints the same line prefixed`⚠ verify bypassed:`, exit 0. | T1  |
| R2  | `.husky/pre-push`: the bypass block becomes: compute `upstream=$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |             | echo origin/master)`; `changed=$(git diff --name-only "$upstream"...HEAD 2>/dev/null |           | git diff --name-only origin/master...HEAD)`; export `RF_BRANCH`, `RF_HEAD=$(git rev-parse --short HEAD)`, `RF_CHANGED_FILES="$changed"`, `RF_AUDIT_LOG="$(git rev-parse --git-dir)/skip-verify.log"`; `node scripts/skip-verify-audit.mjs          |          | exit 1`; then the existing two warnings; `exit 0`. The header comment's "Emergency escape hatch" paragraph is updated to name `SKIP_VERIFY_REASON`and the log path. Nothing else in the hook changes (trunk block, verified-tree marker,`npm run verify`). | T1, review         |
| R3  | Root `package.json` `verify`: `turbo run check-types lint test --concurrency=2 --continue=dependencies-successful` (only this token added). `ci.yml` step "Verify (…)" still runs `npm run verify` (byte-identical rule preserved); its comment gains one line on `--continue`.                                                                                                                                                                                                                                                                                                                                                                                                               | review, A2  |
| R4  | `AppService.healthCheck()` returns `{ status: "ok", timestamp, commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? null, branch: process.env.RAILWAY_GIT_BRANCH ?? null }` (mirrors the web route; `null`, never `"unknown"`). Swagger summary unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                           | T2          |
| R5  | `ci.yml` readiness gate: after the web-sha check, an **API-sha check with the identical structure**: fetch `$API_BASE/api/v1/health` → `api_sha=.commit`; pass when `api_sha == EXPECTED_SHA`, or when `api_sha` is non-null and `git diff --name-only "$api_sha" "$EXPECTED_SHA" -- apps/api packages` is empty (api untouched since its deployed commit — Railway's `watchPatterns` skip), else keep polling within the same `WAIT_SECONDS` budget; a `null` `commit` (pre-PR API) is logged and treated as reachability-only for that run (so this PR's own first deploy cannot false-red). The "KNOWN LIMITATION" comment is rewritten to describe the new check. No new job; steps only. | A3          |
| R6  | `scripts/post-deploy-check.mjs`: after the health pass, print `commit`/`branch` from the payload (informational, one line). `docs/IMPROVEMENTS.md` item 9: reword to the ruling (audit + reason + `--continue`; no split, with the one-line reason and a pointer to `ci.yml:1-63`); Status column row 9 `shipped (PR-11)`. Code-map `api.md` (`app.service.ts`), root scripts entry, `_meta.json`; `CLAUDE.md` Session Startup / verify note: one line on `SKIP_VERIFY_REASON`. Lessons: `updatedAt`.                                                                                                                                                                                         | review      |

## Tests

- **T1** `apps/api/src/common/skip-verify-audit-script.spec.ts` (spawn, PR-1's pattern): temp log
  path; (a) code push (`RF_CHANGED_FILES="apps/api/src/x.ts"`), no reason → exit 1, stderr contains
  `SKIP_VERIFY_REASON`, log file absent; (b) code push with reason `"hotfix: verify broken by dep bump"`
  → exit 0, stdout contains `⚠ verify bypassed:`, log has one line containing the branch, head,
  `docs-only=no`, the reason; (c) docs-only (`docs/a.md\nREADME.md`), no reason → exit 0, log line
  `docs-only=yes | docs-only`; (d) mixed (`docs/a.md\npackages/x/y.ts`) no reason → exit 1; (e)
  two runs append two lines. Oracles concrete; before implementation `spawnSync` status is `null`.
- **T2** `apps/api/src/app.service.spec.ts` (new): with `RAILWAY_GIT_COMMIT_SHA=abc123` and
  `RAILWAY_GIT_BRANCH=master` set → `healthCheck()` equals `{ status: "ok", timestamp: expect.any(String), commit: "abc123", branch: "master" }`;
  with both unset → `commit: null, branch: null`. Before: `commit` is `undefined` (≠ `"abc123"`).

## Acceptance

- A1: `npm test -w apps/api` green (T1, T2); `SKIP_VERIFY=1 git push --dry-run` on a scratch
  branch with a code change and no reason → hook refuses (exit 1) — the agent runs it with
  `--dry-run` against a throwaway branch and pastes the output; with a reason → proceeds, and
  `.git/skip-verify.log` gains a line.
- A2: `npm run verify` with an injected lint error in a scratch file shows the test and typecheck
  results too (`--continue` proof), then the scratch file is removed.
- A3: after merge, the deploy-triggered E2E run's readiness step log shows `api commit <sha> ==
expected` (or the tolerance branch) and the run is green; `curl $API/api/v1/health` returns
  `commit` equal to master's sha.

## Files

`scripts/skip-verify-audit.mjs` (new); `.husky/pre-push`; root `package.json`;
`.github/workflows/ci.yml`; `apps/api/src/app.service.ts`; `scripts/post-deploy-check.mjs`
(one line); two new specs; `docs/IMPROVEMENTS.md`; `CLAUDE.md`; bookkeeping.
