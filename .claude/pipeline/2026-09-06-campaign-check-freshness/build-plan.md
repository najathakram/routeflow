# campaign-check freshness guard · Build plan (Fable, 2026-09-06) — small; stages by hand

Base master 597c72dc, worktree `rf-registry`, branch `fix/campaign-check-report-freshness`, ONE PR (scripts + docs +
one spec). Lessons carried: L-034 (the cache-replay trap this closes), the `GIT_DIR`/`GIT_WORK_TREE` scrub for throwaway repos (session memory note reference_git_worktreeconfig_bare_trap — NOT L-070, which is the POSIX zombie-pid lesson),
L-067 (writers read back and assert), L-063 (campaign reporter + campaign-check are the gate pair), the
`SCHEMA_DRIFT_PRISMA_CLI` test-only-hook shape (CLAUDE.md), L-082 (fixtures own their setup/cleanup).

## Packages

| id   | title                                                                | files                                                                                                                                                | dependsOn | satisfies | provenBy       | effort | model  |
| ---- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------- | -------------- | ------ | ------ |
| TP-1 | Author the spec (T1–T11) — implement nothing                         | `apps/api/src/common/campaign-check-freshness.spec.ts`                                                                                               | —         | —         | T1–T11         | high   | Sonnet |
| WP-0 | Reporter provenance stamp (`generatedAt`, `gitHead`)                 | `scripts/jest-campaign-reporter.cjs`                                                                                                                 | TP-1      | R0        | T10            | low    | Sonnet |
| WP-1 | The guard: R1 rule + R2 refusal + R3 scoping in `campaign-check.mjs` | `scripts/campaign-check.mjs`                                                                                                                         | TP-1      | R1 R2 R3  | T1 T2 T3 T4 T5 | high   | Sonnet |
| WP-2 | `--freshness-only` + turbo dry-run + test seam                       | `scripts/campaign-check.mjs`                                                                                                                         | WP-1      | R4 R6     | T6 T7 T8 T9    | high   | Sonnet |
| WP-3 | Verify wiring                                                        | root `package.json`                                                                                                                                  | WP-2      | R5        | T11            | low    | Sonnet |
| WP-4 | Docs + lesson + map                                                  | `.claude/skills/bug-registry/SKILL.md`, code map (INDEX + api.md for the spec), CHANGELOG, `_meta`, `LESSONS.md`, `ARCHIVE.md`, lessons `_meta.json` | WP-3      | R7 R8     | —              | low    | Sonnet |

## Exact shape for the tricky parts (Sonnet transcribes; a gap is a finding, not a guess)

1. **Newest-commit lookup** (one helper, called at most 3 times, all inside the existing repo-root resolution):
   `newestCommit(pathspecs)` → `git log -1 --format=%H%x1f%ct%x1f%s -- <pathspecs…>` from `REPO_ROOT`
   (spawnSync with `cwd` = the git root derived once via `git -C <statusDir> rev-parse --show-toplevel`; `:(glob)` pathspecs per spec.md R1), parse to `{ sha, ct, subject }` or `null` when no commit touches them.
2. **Report time**: `Date.parse(report.generatedAt)` when present (WP-0 stamps it), else `fs.statSync(path).mtimeMs` with `viaMtime: true` (the message appends "(file mtime — the report carries no generatedAt; regenerate once to stamp it)").
3. **Rule**: `stale = reportTime < max(newestCommit(wsTests).ct, newestCommit(ledger).ct) * 1000`; the message names
   whichever of the two is the newer cause.
4. **Where**: a new function `checkFreshness(consultedWorkspaces)` invoked right after the reports are located and
   BEFORE `tokensIn`/indexing; in full mode a stale report → `fail(...)` (exit 1) with R2's message; in
   `--freshness-only` mode → the R4 branch; then `process.exit(0)` without scanning.
5. **Turbo dry-run**: `spawnSync("npx", ["turbo", "run", "test", "--filter=<pkg>", "--dry-run=json"], { cwd: REPO_ROOT,
shell: process.platform === "win32" })` → parse stdout JSON → `tasks[]` entry with `package === <pkg>` and `taskId` ending `#test` → `cache.status` (`HIT`/`MISS`). Any error → fail open with `campaign-check: turbo dry-run unavailable —
fail open, the end-of-verify check still enforces freshness`.
6. **Test seam** (R6): `const dryRunOverride = process.env.CAMPAIGN_CHECK_TURBO_DRY_RUN; if (dryRunOverride &&
!process.env.JEST_WORKER_ID) console.warn("… ignored outside a Jest worker") else if (dryRunOverride) { warn +
read the file instead of spawning }` — copy the exact wording pattern from `apps/api/scripts/schema-drift.mjs`.
7. **Workspace ↔ package map**: `{ api: { dir: "apps/api" }, mobile: { dir: "apps/mobile" }, pricing: { dir: "packages/pricing" } }` with `pkg` read from each `<dir>/package.json` `name` at runtime (`@routeflow/api|mobile|pricing` today); a missing package.json (fixture) ⇒ `pkg` falls back to `@routeflow/<ws>`.

## Red gate

`cd apps/api && npx jest src/common/campaign-check-freshness.spec.ts --runInBand` — `expect: fail`; T4 is the one
positive control (green before and after) and is excluded from the "0 passed" claim.

## Verify commands

perRound: the red-gate spec (green after WP-1/2), `cd apps/api && npx tsc -p tsconfig.build.json --noEmit`,
`npx prettier --check scripts/campaign-check.mjs apps/api/src/common/campaign-check-freshness.spec.ts package.json`.
final: perRound + `node scripts/campaign-check.mjs --freshness-only` on the real tree (must exit 0 or refuse with the
regen command — report which) + `node scripts/campaign-check.mjs` + `node scripts/campaign/bugs.mjs self-test` +
`node scripts/validate-lessons.mjs`; LIVE ORACLE: `node scripts/campaign-check.mjs --freshness-only` on this tree must refuse for `mobile.json` (stale + turbo HIT) with the regen command, then after `cd apps/mobile && npx jest --maxWorkers=2` it must exit 0.

## What must NOT change

Ledger semantics; `bugs.mjs`; the existing campaign-check messages for missing artifacts and T2 discharge
acknowledgments (T5 only APPENDS the regen command); turbo.json (no `.campaign/runs` output declaration); the
pre-push hook script itself (the pre-step lives in `package.json` `verify`).

## Close-out (after the Opus review + fixes)

result.json + ledger row + RUN-LOG entry (≤ 10 lines); "ready to push" to the lead; DRAFT PR; W-next window.

## Rulings after the red gate (Fable, TP-1 report)

- **Turbo binary, not `npx`.** The dry-run runs `<gitRoot>/node_modules/.bin/turbo` (`turbo.cmd` on win32; resolve
  both) with `cwd` = the git root derived from the status dir — the repository whose ledger is being checked. Binary
  absent (a fixture repo) ⇒ the fail-open branch. `npx turbo` is forbidden (it can try to download turbo from a bare
  temp dir). This resolves T9's tension: the fixture has no turbo binary ⇒ fail open ⇒ exit 0, exactly as T9 asserts.
- **"Consulted" = every T1 report that EXISTS when `t1Needed`** (campaign-check cannot map a claim to a workspace, so
  all existing T1 reports must be fresh). In full mode with NONE existing, the existing "none of … exists" failure
  stands and gains one `  regenerate: cd <dir> && npx jest --maxWorkers=2` line per T1 workspace (api, mobile, pricing).
  In `--freshness-only` mode a missing T1 report is "turbo will generate it" (a note, never a refusal).
- **Live oracle is part of WP-2's gate:** on this tree `node scripts/campaign-check.mjs --freshness-only` must refuse
  naming `mobile.json` (stale + turbo HIT) with the regen command; then `cd apps/mobile && npx jest --maxWorkers=2`
  (scoped, ~3 min); then the pre-step exits 0 and the full `node scripts/campaign-check.mjs` passes.
