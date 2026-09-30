# RESUME — Wave B′ (API hardening) dev-pipeline run

- **runId:** `wf_92c93c4a-621`
- **scriptPath (persisted engine copy — never overwrite while this run is live/resumable):** `C:\ClaudeCode\routeflow\local-assets\tooling\pipeline-v3-c8.js` (`maxConcurrent 8`)
- **Transcript dir:** `C:\Users\nakram\.claude\projects\C--ClaudeCode-routeflow\8d7999bc-726a-4431-9ad0-445d127f0188\subagents\workflows\wf_92c93c4a-621`
- **Worktree / branch:** `C:\ClaudeCode\routeflow\.claude\worktrees\rf-imp-03` · `feat/imp-wave-b-api-hardening` (off master `e39bf9db`)
- **Launched:** 2026-09-03T19:00:29Z (`startedAt` in args)
- **Resume:** `Workflow({ scriptPath: "C:\\ClaudeCode\\routeflow\\local-assets\\tooling\\pipeline-v3-c8.js", resumeFromRunId: "wf_92c93c4a-621", args: <the exact object below> })` — identical args; stop the prior run first (TaskStop) if still running. A result with `agents_error > 0` is INCOMPLETE — resume before reading `clean`/`remainingFindings`/the tree.
- **Scope note:** 2b cron lock EXCLUDED (own PR after PR-2). Red gate covers tpB2/tpB3/tpB5 only; tpB4 pins are expected to pass pre-implementation.
- **After the run:** append to `.claude/pipeline/cost-ledger.jsonl` via `model-routing/scripts/pipeline-ledger.mjs`; close-out re-runs `npm run verify` regardless of the engine's final gate.

## Exact args

```json
{
  "planPath": "C:/ClaudeCode/routeflow/.claude/worktrees/rf-imp-03/.claude/pipeline/wave-B-api-hardening/README.md",
  "lessonsPath": "C:/ClaudeCode/routeflow/.claude/worktrees/rf-imp-03/.claude/lessons/LESSONS.md",
  "workdir": "C:/ClaudeCode/routeflow/.claude/worktrees/rf-imp-03",
  "startedAt": "2026-09-03T19:00:29Z",
  "scale": "major",
  "context": "Wave B′ (API hardening) of the improvements program in worktree C:/ClaudeCode/routeflow/.claude/worktrees/rf-imp-03 on branch feat/imp-wave-b-api-hardening (off master e39bf9db). The plan is the wave README plus the three item briefs beside it (2026-09-03-imp-03b-migration-lint-squawk/brief.md, 2026-09-03-imp-09-verify-bypass-audit-health-sha/brief.md, 2026-09-03-imp-p4-guard-order-findunique-pins/brief.md) and the README's 'Added scope … pB10' + 'pB10 facts' sections. 2b cron lock is EXCLUDED (own PR after PR-2). Items: 3B destructive-migration lint with squawk-cli (destructive-only rule set, reason-gated ignores, CI step in db-migrations.yml); 9 + P4-a: SKIP_VERIFY audit line + required reason, verify --continue=dependencies-successful, API /api/v1/health returns commit/branch from RAILWAY_GIT_COMMIT_SHA/BRANCH and ci.yml readiness gate checks the API sha with the same tolerance shape as the web check (EXPECTED_SHA = deployment.sha || github.sha); P4-b/c: guard-chain and findUnique tenancy pins (test-only); pB10: AUTH_LOGIN_THROTTLE_LIMIT/AUTH_LOGIN_THROTTLE_TTL_MS env knob with prod defaults unchanged (10 / 300000) and a generous local value in docker-compose. Work ONLY in this worktree; never touch the main checkout, other worktrees or apps/api/prisma/**; test tenants only. CI has no Postgres in the verify job; *.db.spec.ts run via npm run local:test:db (shared stack — do not run local:* from the engine).",
  "formatCommand": "npx prettier --write",
  "testPackages": [
    {
      "id": "tpB2",
      "title": "3B lint-migrations script contract spec",
      "files": ["apps/api/src/common/lint-migrations-script.spec.ts"],
      "brief": "Implement T1 (a)–(e) from 2026-09-03-imp-03b-migration-lint-squawk/brief.md exactly (spawnSync of scripts/lint-migrations.mjs with --files on temp fixture SQL files; asserts on exit codes and on rule names present/absent in stdout; the reason-line rule). Before implementation the script does not exist → status null → fails on its own value. Titles contain 'lint-migrations'."
    },
    {
      "id": "tpB3",
      "title": "9 + P4-a: skip-verify audit script spec + app.service health spec",
      "files": [
        "apps/api/src/common/skip-verify-audit-script.spec.ts",
        "apps/api/src/app.service.spec.ts"
      ],
      "brief": "Implement T1 (a)–(e) and T2 from 2026-09-03-imp-09-verify-bypass-audit-health-sha/brief.md exactly: spawn scripts/skip-verify-audit.mjs with a temp RF_AUDIT_LOG and the env cases (code push without reason → 1; with reason → 0 + log line; docs-only → 0; mixed → 1; two runs append two lines); app.service.spec.ts: healthCheck() equals { status:'ok', timestamp: expect.any(String), commit:'abc123', branch:'master' } with the env set and commit/branch null when unset (construct AppService directly). Before implementation: script absent → null status; commit undefined ≠ 'abc123'."
    },
    {
      "id": "tpB4",
      "title": "P4-b/c pins: guard chain, guard order, findUnique lane",
      "files": [
        "apps/api/src/auth/guards/guard-chain.security.spec.ts",
        "apps/api/src/app.module.guards.spec.ts",
        "apps/api/src/prisma/tenant-findunique.db.spec.ts"
      ],
      "effort": "high",
      "brief": "Implement T1, T2, T3 from 2026-09-03-imp-p4-guard-order-findunique-pins/brief.md. READ first: apps/api/src/app.module.ts:170-190 (APP_GUARD order), apps/api/src/tenant/tenant-status.guard.ts, apps/api/src/auth/guards/impersonation.guard.ts, apps/api/src/auth/guards/jwt-auth.guard.ts, apps/api/src/auth/strategies/jwt.strategy.ts, apps/api/src/prisma/prisma.service.ts:120-200, and the existing impersonation.guard.spec.ts (fake ExecutionContext pattern) and prisma-isolation.spec.ts (extend, don't duplicate). These are REGRESSION PINS: they are expected to PASS before implementation (the guards are already safe) — they are deliberately excluded from the red gate. T1: build tokens with base64url header/payload + 's' (unsigned), JwtService.sign with another secret (wrong secret), and expiresIn:-10 (expired); drive the three global guards in registered order then JwtAuthGuard; assert 401 for all forged shapes, 403 from TenantStatusGuard for a forged SUSPENDED tenant before JwtAuthGuard is reached (spy), ImpersonationGuard returns true for every shape, a correctly signed token resolves. T2: static read of app.module.ts → APP_GUARD order equals ['ThrottlerGuard','TenantStatusGuard','ImpersonationGuard'] and JwtAuthGuard is not global. T3 (lane-only, describeDb): two throwaway tenants with slugs qa-pin-<random> (allowed by scripts/lib/test-tenants.cjs) + one row per model for Customer, Product, Order, Invoice via the raw client; cross-tenant findUnique → null and findUniqueOrThrow throws under prisma.forTenant() AND inside tenantTransaction; same-tenant returns the row; current_setting('app.current_tenant_id', true) equals the tenant inside tenantTransaction; afterAll deletes what it created. If any guard is found to authorize on an unverified claim, STOP and report it as a blocker finding (it becomes a fix)."
    },
    {
      "id": "tpB5",
      "title": "pB10 login-throttle env knob spec",
      "files": ["apps/api/src/auth/login-throttle-config.spec.ts"],
      "brief": "The README's pB10 section defines the knob. Spec: a pure function `loginThrottleConfig(env)` (to be exported from a small module the implementation adds, e.g. apps/api/src/auth/login-throttle.config.ts — guarded require) returns { limit: 10, ttl: 300000 } when AUTH_LOGIN_THROTTLE_LIMIT / AUTH_LOGIN_THROTTLE_TTL_MS are unset; { limit: 1000, ttl: 60000 } when set to '1000'/'60000'; falls back to the defaults (and does not throw) for non-numeric or ≤ 0 values; and a static assertion that apps/api/src/auth/auth.controller.ts's login @Throttle decorator references that function (grep the file text for 'loginThrottleConfig'). Before implementation: module absent → typeof 'undefined'; controller text lacks the reference. Titles contain 'login throttle'."
    }
  ],
  "redGate": {
    "commands": [
      "cd apps/api && npx jest src/common/lint-migrations-script.spec.ts src/common/skip-verify-audit-script.spec.ts src/app.service.spec.ts src/auth/login-throttle-config.spec.ts"
    ],
    "expect": "fail"
  },
  "packages": [
    {
      "id": "pB4",
      "title": "Squawk: config, lint script, devDependency, verify --continue",
      "files": [
        "apps/api/.squawk.toml",
        "scripts/lint-migrations.mjs",
        "package.json",
        "package-lock.json"
      ],
      "satisfies": ["3B-R1", "3B-R2", "3B-R3", "3B-R4-scripts", "9-R3"],
      "provenBy": ["tpB2"],
      "brief": "Per 2026-09-03-imp-03b-migration-lint-squawk/brief.md R1–R4 (root scripts part) and the item-9 brief R3: root devDependency \"squawk-cli\": \"2.64.0\" exact; a REAL `npm install` (never --package-lock-only) then `node scripts/validate-lock-edges.mjs` must print `missing 0` (paste); apps/api/.squawk.toml with pg_version \"17.0\" and excluded_rules = every rule EXCEPT the destructive gate set (ban-drop-table, ban-drop-column, ban-drop-database, changing-column-type, adding-required-field, renaming-column, renaming-table, ban-truncate-cascade, syntax-error) — get the full rule list from `npx squawk --help`/docs and write the 31 exclusions explicitly with a header comment; scripts/lint-migrations.mjs per R3 (--base/--files/--all, reason-line rule, spawnSync argv shell:false, --reporter gcc); root scripts: \"lint:migrations\": \"node scripts/lint-migrations.mjs\"; and in the root `verify` script change `turbo run check-types lint test --concurrency=2` to `turbo run check-types lint test --concurrency=2 --continue=dependencies-successful` (only that token). Run `node scripts/lint-migrations.mjs --all` and paste the count over the existing migrations (informational)."
    },
    {
      "id": "pB5",
      "title": "SKIP_VERIFY audit script + pre-push hook",
      "files": ["scripts/skip-verify-audit.mjs", ".husky/pre-push"],
      "satisfies": ["9-R1", "9-R2"],
      "provenBy": ["tpB3"],
      "brief": "Per 2026-09-03-imp-09-verify-bypass-audit-health-sha/brief.md R1 and R2 exactly (the audit script's env contract and exit codes; the hook's bypass block computing upstream/changed files, exporting RF_BRANCH/RF_HEAD/RF_CHANGED_FILES/RF_AUDIT_LOG, `node scripts/skip-verify-audit.mjs || exit 1`, then the existing warnings and exit 0; header paragraph updated). Nothing else in the hook changes. Prove with a `--dry-run`-style local check: run the audit script directly with the five env cases and paste outputs."
    },
    {
      "id": "pB6",
      "title": "API health commit/branch + post-deploy-check line",
      "files": ["apps/api/src/app.service.ts", "scripts/post-deploy-check.mjs"],
      "satisfies": ["9-R4", "9-R6-post-deploy"],
      "provenBy": ["tpB3"],
      "brief": "Per the item-9 brief R4: AppService.healthCheck() returns { status:'ok', timestamp, commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? null, branch: process.env.RAILWAY_GIT_BRANCH ?? null } (mirrors apps/web/app/api/health/route.ts; null never 'unknown'). scripts/post-deploy-check.mjs: after the health pass, print one informational line with commit/branch from the payload."
    },
    {
      "id": "pB7",
      "title": "CI: readiness-gate API sha check; db-migrations Squawk step",
      "files": [".github/workflows/ci.yml", ".github/workflows/db-migrations.yml"],
      "model": "claude-opus-5",
      "effort": "high",
      "dependsOn": ["pB4", "pB6"],
      "satisfies": ["9-R5", "3B-R4-ci"],
      "provenBy": [],
      "brief": "READ ci.yml fully first (header rules: steps not jobs; the e2e job's readiness gate ~:468-622 with the web sha check and its tolerance branch `git diff --name-only <deployed> <expected> -- apps/web packages`). Per the item-9 brief R5: add an API-sha check with the IDENTICAL structure right after the web check: fetch $API_BASE/api/v1/health → api_sha=.commit; pass when api_sha == EXPECTED_SHA (EXPECTED_SHA = ${{ github.event.deployment.sha || github.sha }} — never bare github.sha), or when api_sha is non-null and `git diff --name-only \"$api_sha\" \"$EXPECTED_SHA\" -- apps/api packages` is empty; a null commit (pre-change API) is logged and treated as reachability-only for that run; keep polling within the same WAIT_SECONDS budget; rewrite the KNOWN LIMITATION comment; add one header sentence on --continue. db-migrations.yml per the Squawk brief R4: step 'Destructive-migration lint (squawk)' before the replay, `run: node scripts/lint-migrations.mjs --base \"${{ github.event.pull_request.base.sha || 'origin/master' }}\"`, checkout fetch-depth 0 (or an explicit fetch of the base), paths += scripts/lint-migrations.mjs, apps/api/.squawk.toml, the workflow file. Steps only, never a new job. Validate both YAML files parse (node -e with js-yaml) and paste."
    },
    {
      "id": "pB8",
      "title": "Guard-order load-bearing comment",
      "files": ["apps/api/src/app.module.ts"],
      "effort": "low",
      "satisfies": ["P4-R3"],
      "provenBy": ["tpB4"],
      "brief": "Per the P4 brief R3: a comment above the APP_GUARD providers block stating the invariant (global guards run before JwtAuthGuard and may read unverified claims only to throttle/lookup, never to authorize; JwtAuthGuard is route-level by design; changing the order or adding a global authorizing guard is a security change). Comment only."
    },
    {
      "id": "pB10",
      "title": "Login-throttle env knob (prod defaults unchanged)",
      "files": [
        "apps/api/src/auth/login-throttle.config.ts",
        "apps/api/src/auth/auth.controller.ts",
        "docker-compose.yml",
        "apps/api/.env.example",
        "docs/audit/security-findings-index.md"
      ],
      "satisfies": ["pB10"],
      "provenBy": ["tpB5"],
      "brief": "Per the README's pB10 sections. New apps/api/src/auth/login-throttle.config.ts exporting `loginThrottleConfig(env = process.env): { limit: number; ttl: number }` — defaults { limit: 10, ttl: 300_000 }; env AUTH_LOGIN_THROTTLE_LIMIT / AUTH_LOGIN_THROTTLE_TTL_MS parsed as positive integers, invalid → default (never throw). auth.controller.ts:66: `@Throttle({ default: loginThrottleConfig() })` (evaluated once at module init) with the RF-160 comment kept and extended ('env override for local stacks only; prod defaults unchanged'). docker-compose.yml api environment: AUTH_LOGIN_THROTTLE_LIMIT: \"1000\", AUTH_LOGIN_THROTTLE_TTL_MS: \"60000\" with a one-line comment (local throwaway; the Playwright lane + retries share 127.0.0.1). apps/api/.env.example: the two names with a comment (no values beyond the defaults). docs/audit/security-findings-index.md: the RF-160 row/line notes 'prod default unchanged; local override documented (wave B′)'. Do not change any other throttle."
    },
    {
      "id": "pB9",
      "title": "Docs, code map, IMPROVEMENTS status, lesson",
      "files": [
        "CLAUDE.md",
        ".claude/code-map/api.md",
        ".claude/code-map/INDEX.md",
        ".claude/code-map/_meta.json",
        "docs/IMPROVEMENTS.md",
        ".claude/lessons/LESSONS.md",
        ".claude/lessons/_meta.json",
        ".claude/skills/db-migration/SKILL.md"
      ],
      "effort": "low",
      "dependsOn": ["pB4", "pB5", "pB6", "pB7", "pB8", "pB10"],
      "satisfies": ["3B-R5", "9-R6-docs", "P4-R5"],
      "provenBy": [],
      "brief": "Per the three briefs' bookkeeping rows. CLAUDE.md: Deployment & DB safety — one line: destructive migrations are blocked in CI by Squawk (`npm run lint:migrations`; whitelist with `-- reason:` + `-- squawk-ignore <rule>`); Session Startup/verify note: `SKIP_VERIFY=1` needs `SKIP_VERIFY_REASON`, docs-only pushes exempt; Local hosting: the login-throttle env knob is set in compose. .claude/skills/db-migration/SKILL.md (if present in this worktree): the same two Squawk lines. Code map api.md: entries for app.service health fields, login-throttle.config.ts, the new specs, scripts (lint-migrations, skip-verify-audit), .squawk.toml; INDEX.md root-scripts row; _meta.json mappedSha = `git rev-parse --short HEAD`, generatedAt now, notes = one dated bullet (replace). docs/IMPROVEMENTS.md: item 3 text — replace the Atlas recommendation with Squawk + 'Atlas migrate lint is Pro-only since v0.38 and its --dir-format never supported Prisma' (2 sentences); Status rows: 3 → `shipped (#608 + wave B′)`, 9 → `shipped (wave B′)`; a P4 note line (guard-order + findUnique pins shipped; health SHA gate shipped). Lessons: read _meta.json nextId and two neighbours' format; append ONE entry (category tooling, ≤ 1,000 bytes): 'a tool recommendation in a review is a claim — verify licensing and format support against current docs before planning around it (Atlas lint went Pro-only; its dir formats never included Prisma)'; update _meta.json; `node scripts/validate-lessons.mjs` exit 0 (paste)."
    }
  ],
  "verifyCommands": {
    "perRound": ["npx tsc -p apps/api/tsconfig.build.json --noEmit", "npm run lint -w apps/api"],
    "final": [
      "node scripts/validate-lock-edges.mjs && node scripts/validate-lessons.mjs && node .claude/skills/bug-hunt/scripts/scan-signatures.mjs --self-test && node .claude/skills/bug-hunt/scripts/scan-signatures.mjs && npx turbo run check-types lint test --concurrency=2 --force && node scripts/campaign-check.mjs"
    ]
  },
  "mutationProbe": {
    "targets": [
      {
        "file": "scripts/lint-migrations.mjs",
        "behavior": "destructive rules fire and the reason-line rule holds — emptying the exclusion handling or dropping the reason check must be caught",
        "test": "apps/api/src/common/lint-migrations-script.spec.ts"
      },
      {
        "file": "scripts/skip-verify-audit.mjs",
        "behavior": "a code push without SKIP_VERIFY_REASON exits 1 — dropping the check must be caught",
        "test": "apps/api/src/common/skip-verify-audit-script.spec.ts"
      },
      {
        "file": "apps/api/src/app.service.ts",
        "behavior": "health returns commit/branch from env — removing the field must be caught",
        "test": "apps/api/src/app.service.spec.ts"
      },
      {
        "file": "apps/api/src/auth/login-throttle.config.ts",
        "behavior": "env override with safe defaults — ignoring the env or throwing on bad input must be caught",
        "test": "apps/api/src/auth/login-throttle-config.spec.ts"
      }
    ]
  }
}
```
