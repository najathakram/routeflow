# api — Bootstrap & cross-cutting — CI/CD gates & DB-spec test lane

> Split from [`../bootstrap-cross-cutting.md`](../bootstrap-cross-cutting.md) (verbatim, lines 207-335 of the pre-split file) on 2026-09-15. See [`../../INDEX.md`](../../INDEX.md).

## Bootstrap & cross-cutting

- **`scripts/ci-audit-critical.mjs` (2026-09-04)** — CI advisory gate: wraps `npm audit
--omit=dev --audit-level=<level> --json` in `spawnSync` (`shell:false`, up to 3 attempts,
  15s/45s backoff, 120s per-attempt timeout, 64 MiB `maxBuffer`) so an `npm` registry
  outage (the `/-/npm/v1/security/audits/quick` endpoint's ongoing 500s, "being retired")
  cannot wedge CI the way it twice blew the job's 20-min `timeout-minutes`. Decision table:
  parsed JSON with `metadata.vulnerabilities.critical>0` → prints each advisory + `::error::`
  - exit 1; parsed JSON with critical=0 → exit 0; a registry/transport error (500, `ECONNRESET`,
    `ETIMEDOUT`, `ENOTFOUND`, "being retired", "audit endpoint returned an error", or the spawn
    itself timing out) → retries, then `::warning::…SKIPPED…` + exit 0 (Dependabot is the standing
    net); any other non-zero exit fails closed (exit 1). `--level <lvl> --report-only` (the second
    ci.yml step) always exits 0. Test-only env: `CI_AUDIT_CMD` (JSON argv array, swaps in a fake
    driver — no network) and `CI_AUDIT_BACKOFF_MS` (collapses the backoff for fast specs). On
    win32 without a `CI_AUDIT_CMD` override, resolves and invokes `npm-cli.js` next to
    `process.execPath` via `node` instead of `npm.cmd` directly — `spawnSync` cannot launch a
    `.cmd` shim with `shell:false` since Node's CVE-2024-27980 hardening (EINVAL); the real CI
    codepath (ubuntu-latest, plain `npm`) is untouched. Called from `.github/workflows/ci.yml`'s
    `Fail on critical production advisories` / `Report high-severity advisories` steps. Contract
    spec: `src/common/ci-audit-script.spec.ts` (spawn-level, fake npm-audit driver written to an
    mkdtemp'd dir, `FAKE_MODE` critical/clean/outage/unknown, counter file proves retry count).
- **`security/audit-allowlist.json` (emptied 2026-09-10, `chore/next-15` #5b3b3c4e)** — carried
  two owner-acked, expiring (2026-09-30) entries for `GHSA-p293-qw3h-jr36` and
  `GHSA-2xp9-vwfh-vxw4` (both `next`), both fixed in Next 15.5.24+; the upgrade retires both
  entries, leaving `entries: []`. `src/common/ci-audit-script.spec.ts`'s "policy guard" describe
  no longer pins the allowlist to exactly those two ids (that pinned the CONTENTS, which would
  make the very next legitimate entry someone adds fail the spec) — it now accepts any valid
  entries array, empty included, and only asserts the per-entry expiry-window shape. Which
  advisories are RETIRED (must be absent, and must now fail the gate rather than be suppressed)
  is `audit-allowlist-retired.spec.ts`'s job (see below) — a policy-guard spec and a
  retirement-tripwire spec, not one spec doing both.
- **`scripts/ci-freshness-guard.mjs` (2026-09-04, REG-E2EGUARD-403)** — replaces the e2e job's
  old inline bash freshness guard (`gh api … --jq … 2>/dev/null || true`), which treated a 4xx/5xx
  error body as a non-empty "sha" and silently emitted `run=false` on every call once the run
  token lost `deployments:read` — every `deployment_status` E2E run reported green with zero
  test steps for days. `spawnSync("gh", ["api", "repos/<repo>/deployments?per_page=1"],
{shell:false})`, decision table: (A) exit 0 + JSON array with `[0].sha` → compare to
  `DEPLOY_SHA`, match=`run=true`/`::notice::`, mismatch=`run=false`/`::notice::` (genuinely
  superseded); (B) exit 0 + empty array → `run=true`; (C) anything else — non-zero exit,
  unparseable/non-array body, timeout, missing `DEPLOY_SHA`/`GITHUB_REPOSITORY` — **fails open**
  (`run=true`, `::warning::`, ≤200 chars of the body/stderr, never the token). Always exits 0 — a
  red guard step would hide the suite exactly like a wrongful skip does. Test-only
  `CI_FRESHNESS_GH_CMD` (JSON argv array, swaps in a fake `gh`) and `CI_FRESHNESS_GH_TIMEOUT_MS`
  (default 30000ms). Called from `.github/workflows/ci.yml`'s `e2e` job `freshness` step, which
  now also declares job-level `permissions: {contents: read, deployments: read}` (the job was
  previously on the restricted org default with no `deployments:read`). Contract spec:
  `src/common/ci-freshness-guard-script.spec.ts` (spawn-level fake `gh` on PATH, plus a T1 that
  runs the workflow's own step command via `js-yaml`).
- **`scripts/visibility-watchdog.mjs` (2026-09-04, killed-session incident)** — a detached
  safety net for the public-repo CI window in the canonical deploy flow (`CLAUDE.md`,
  `docs/runbooks/deploy-visibility-flip.md`): launched BEFORE `gh repo edit … public`, it
  `setTimeout`-sleeps `--minutes` (default 45, never a busy-wait, so signals still work),
  then retries the flip itself: **up to 6 attempts**, each one `gh repo edit … --visibility
private …` immediately followed by a `gh repo view --json visibility` read-back, stopping at
  the first `PRIVATE`. **Bounded end to end (close-out re-check, 2026-09-05, L-077):** every
  `gh` call carries `timeout: 60_000, killSignal: "SIGKILL"` (a hung call is otherwise an
  unbounded public window), and the backoff list is FIVE long — `[5s,15s,30s,60s,120s]`, since
  attempt 6 is never followed by a sleep — so the worst case is ≈3.8 min of sleeps plus
  6 × 2 × 60 s of call timeouts. Appends one `<ISO> start|attempt|verified|error <detail>`
  line per event to `local-assets/visibility-watchdog.log` (gitignored) and mirrors it to stdout;
  `start` reports `root=` and `delays=`, an `attempt` reports `edit_exit=` (`spawn-error` for a
  call that never returned) and `edit_stderr=` (prefixed with the spawn error's own `code`, e.g.
  `ETIMEDOUT`). Exits 0 once verified (clearing any stale marker), 1 after 6 unconfirmed
  attempts — then writing `local-assets/visibility-watchdog.FAILED`. ⚠️ **`local-assets/`
  resolves against the MAIN checkout**, via `git rev-parse --path-format=absolute
--git-common-dir` (10 s timeout, falling back to the `__dirname` repo root): a watchdog armed
  from `.claude/worktrees/*` must not hide its marker there, and
  `docs/runbooks/deploy-visibility-flip.md` names the path to check before and after every
  window. A flip landing mid-CI/mid-deploy is by design — a private-repo Action just fails on
  billing and gets rerun. **Four test-only env overrides, all routed through `testOverride()`
  and honoured ONLY inside a jest worker** (`JEST_WORKER_ID` set), with one
  `WARNING: test override <NAME> active` stderr line when honoured and one naming line when
  ignored — the `SCHEMA_DRIFT_PRISMA_CLI` pattern from `scripts/schema-drift.mjs`:
  `VISIBILITY_WATCHDOG_GH_CMD` (JSON argv, swaps in a fake `gh` — no network),
  `…_LOG_FILE` / `…_MARKER_FILE` (scratch paths), `…_ATTEMPT_DELAYS_MS` (JSON array; malformed
  input falls back to the default list). Contract spec:
  `src/common/visibility-watchdog-script.spec.ts` (spawn-level, fake `gh` driver, 12 cases:
  success, retry-then-success (40 ms delays, elapsed ≥ 80 ms for two real sleeps),
  malformed-delays fallback, override WARNING lines, source pin that every override is read
  through the `JEST_WORKER_ID` gate, jest-worker inheritance, `root=` line, never-verifies,
  edit-fails, stdout mirrors log (guarded non-empty), arg defaults, slow-boot repro,
  awaitStartLine cap-rejection + kill pin, awaitStartLine prompt-reject (exit code + stderr)
  when the child dies before the start line). The "arg
  defaults" and slow-boot cases share
  `awaitStartLine({ argv = [SCRIPT], env, logFile, capMs = 30_000, intervalMs = 50, onSpawn })`
  (`logFile` required — the poll reads it; `onSpawn` is a test-only hook handing back the child
  handle on the reject path) (2026-09-04,
  `watchdog-spec-host-speed` fix, L-061): spawns the child and polls `readLog(logFile)` every
  `intervalMs` for the script's own `" start "` log line instead of a fixed 500 ms wait —
  resolves `{ child, log }` on match, rejects with a cap-exceeded message at `capMs`, and
  always kills the child + awaits its exit in a `finally`. All four async tests carry an explicit
  `35_000` ms third-arg Jest timeout so the poll cap fires first. New fixture
  `src/common/testing/slow-boot.cjs` — a synchronous `Atomics.wait(..., 1500)` preload used via
  `NODE_OPTIONS=--require` to deterministically prove the poll survives a slow child boot
  (`REG-WATCHDOG-SLOWBOOT`), independent of host speed.
- **`scripts/lint-migrations.mjs` + `apps/api/.squawk.toml` (wave B′, 2026-09-03)** — destructive-
  migration lint gate. `lint-migrations.mjs` (node, no deps beyond `squawk-cli`): `--base <ref>`
  (default `origin/master`, diffs `apps/api/prisma/migrations` for changed `migration.sql`),
  `--files <paths…>`, `--all` (informational, always exit 0 unless `--strict`); before invoking
  `squawk --config apps/api/.squawk.toml --reporter gcc <files>` via `spawnSync`, scans each file
  for `-- squawk-ignore <rule>` lines lacking an immediately-preceding `-- reason:` line (fails
  loud if found); passes squawk's exit code through. **Fails closed**: all paths resolve against
  the repo root (and both `spawnSync` calls run with `cwd: REPO_ROOT`), and a failing `git diff`
  prints git's stderr + `could not resolve range <base>...HEAD` and exits **2** — only a
  successful diff that matched nothing prints `no migrations in range` / exit 0.
  `.squawk.toml` excludes every rule except the
  destructive gate set (`ban-drop-table`/`-column`/`-database`, `changing-column-type`,
  `adding-required-field`, `renaming-column`/`-table`, `ban-truncate-cascade`, `syntax-error`) —
  Prisma's own migration shapes trip the lock-hygiene rules by design, so those stay advisory.
  Root script `lint:migrations`; wired into `db-migrations.yml` as the
  "Destructive-migration lint (squawk)" step before the replay. Spec:
  `src/common/lint-migrations-script.spec.ts` (spawn-level, fixture files in a temp dir).
- **`scripts/skip-verify-audit.mjs` (wave B′, 2026-09-03)** — the `SKIP_VERIFY` audit gate called
  from `.husky/pre-push`. Reads `SKIP_VERIFY_REASON`/`RF_BRANCH`/`RF_HEAD`/`RF_CHANGED_FILES`/
  `RF_AUDIT_LOG`; classifies the push docs-only when every changed path matches
  `^(docs/|\.claude/|.*\.md$|CHANGELOG|README)`. Non-docs push with an empty reason → stderr +
  exit 1; otherwise appends one `ISO | branch | head | docs-only=yes/no | reason` line to
  `RF_AUDIT_LOG` (`.git/skip-verify.log`) and exits 0. Spec:
  `src/common/skip-verify-audit-script.spec.ts`. Root `verify` script gained
  `--continue=dependencies-successful` on the `turbo run check-types lint test` invocation (same
  token in `ci.yml`'s "Verify" step) so one failing task no longer hides the others.
- **`src/common/testing/db-spec.ts` + `db-lane.db.spec.ts`, `jest.db.config.js` (PR-1, `imp-03a`,
  2026-09-03)** — the new `*.db.spec.ts` lane for specs that need a real Postgres. `db-spec.ts`:
  `requireLocalDatabaseUrl(env)` throws unless `DATABASE_URL`'s host is local
  (`localhost`/`127.0.0.1`/`::1`/`postgres`/`db`); `describeDb` throws when `RUN_DB_SPECS` is
  unset (the lane is never silently green).
  `db-lane.db.spec.ts` builds a `PrismaClient` the same way `prisma.service.ts` does
  (`PrismaPg` adapter over a `pg` `Pool`) and pins `SELECT 1`. `jest.db.config.js` extends the
  `package.json` `"jest"` config with `testRegex: ".*\\.db\\.spec\\.ts$"`; API script `test:db`
  runs it; root script `local:test:db` sets `RUN_DB_SPECS=local` and runs it against the compose
  DB. The default `*.spec.ts` regex now excludes `.db.spec.ts` so `npm test` never touches Postgres.
