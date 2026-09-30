# campaign-check freshness guard · Spec + test plan (Fable, 2026-09-06) — FINAL (design approved by the lead 17:2xZ; facts from `reader.md`)

Files: `scripts/campaign-check.mjs` (the guard), `scripts/jest-campaign-reporter.cjs` (provenance stamp), root
`package.json` (`verify` pre-step), `apps/api/src/common/campaign-check-freshness.spec.ts` (the spec; harness
mirrored from `apps/api/src/common/ci-freshness-guard-script.spec.ts`'s `runScriptDirect` + `mkdtempSync` fixture
and the `scrubbedEnv` helper pattern used across that directory), `.claude/skills/bug-registry/SKILL.md`, code map,
lessons (L-083; archive L-065 and L-046 — L-072 stays active because CLAUDE.md's Conventions cite it inline).

Facts (reader, 2026-09-06): the reporter writes `{numTotalTests, numPassedTests, numFailedTests, testResults}` — no
timestamp, no sha; campaign-check consults FOUR reports (`api.json`, `mobile.json`, `pricing.json` = T1 evidence,
`web-e2e.json` = T2 post-deploy, out of scope); overrides that already exist: `--runs-dir <dir>` and
`CAMPAIGN_CHECK_STATUS_DIR` (ledger dir); turbo 2.10.12 `--dry-run=json` executes nothing (3–6 s) and yields
`tasks[].cache.status` = `HIT`/`MISS` with `tasks[].package`; packages are `@routeflow/api`, `@routeflow/mobile`,
`@routeflow/pricing`; `.campaign/runs/**` is NOT a turbo output (correct — leave it). RIGHT NOW on this tree
`mobile.json` is stale (predates #636's mobile tests and #637's ledger) AND turbo predicts a HIT for both api and mobile —
the live acceptance oracle for the final gate.

## Requirements

- **R0 (P0) Provenance stamp.** `scripts/jest-campaign-reporter.cjs` adds `generatedAt` (ISO 8601, at write time) and
  `gitHead` (`git rev-parse --short HEAD`, best-effort, `null` on failure) to the JSON it writes. Every other field is
  unchanged (campaign-check's readers must not notice). Applies to api, mobile and pricing alike (same reporter).
- **R1 (P0) Staleness rule.** For each CONSULTED T1 report `ws ∈ { api: apps/api, mobile: apps/mobile, pricing:
packages/pricing }`, its time = `generatedAt` when present, else the file mtime (then the message appends
  "(file mtime — the report carries no generatedAt; regenerate once to stamp it)"). The report is STALE when that time
  is earlier than the commit time (`%ct`) of the newest commit touching EITHER (a) that workspace's test files —
  api `:(glob)apps/api/**/*.spec.ts`; mobile `:(glob)apps/mobile/__tests__/**`, `:(glob)apps/mobile/**/*.test.ts`,
  `:(glob)apps/mobile/**/*.test.tsx`; pricing `:(glob)packages/pricing/**/*.spec.ts` — OR (b) the ledger shards
  (the status dir, i.e. `.claude/campaign/status`). Commit times, never input-file mtimes. The git root is
  `git -C <statusDir> rev-parse --show-toplevel` (so a fixture ledger in a temp repo brings its own git history; no
  new env var), and `git log` runs with `cwd` = that root. No commit touching a path set ⇒ that set imposes no bound.
- **R2 (P0) Refuse before scanning.** In the default (full) mode, campaign-check evaluates R1 for every consulted
  report BEFORE indexing any token; on a stale report it prints exactly:
  `campaign-check: <runsDir>/<ws>.json is STALE — generated <ISO> but <the ledger shards | <dir> test files> changed at <ISO> (<short sha> <subject>). Regenerate it: cd <dir> && npx jest --maxWorkers=2`
  then `  rule: a report must be newer than the newest commit touching its workspace's tests or the ledger shards`
  then `  ritual: after ANY ledger edit or master merge, run the regen command in every workspace with T1 claims, then push`
  and exits 1. Several stale reports ⇒ one block each, then exit 1. Never "no test titled with REG-B###" for a stale
  report.
- **R3 (P0) Scoping.** Reports that campaign-check does not consult (per the existing `consultsArtifacts` /
  `t1Needed` logic: no affirmative T1 claim ⇒ none of the three T1 reports is consulted; the T2 `web-e2e.json` is never
  freshness-checked) are never checked. A MISSING consulted report keeps the existing artifact-missing failure text and
  APPENDS one line `  regenerate: cd <dir> && npx jest --maxWorkers=2` per missing T1 report.
- **R4 (P0) Pre-step mode.** `node scripts/campaign-check.mjs --freshness-only` runs R1 only (no token scan). For each
  stale consulted report it asks turbo: `npx turbo run test --filter=<pkg> --dry-run=json` (`cwd` = repo root; `shell`
  on win32) and reads `tasks[]` where `package === <pkg>` and the task is `test` → `cache.status`. `HIT` ⇒ the R2 block
  plus `  turbo would replay <pkg>#test from cache, so this verify cannot refresh the report` and exit 1 (after
  evaluating every report, so all stale HITs are listed). `MISS` ⇒ print `campaign-check: <ws>.json is stale but turbo
will regenerate it (cache miss) — continuing` and treat as fresh. Dry-run failure (spawn error, non-zero exit,
  unparsable JSON, task not found) ⇒ `campaign-check: turbo dry-run unavailable for <pkg> — fail open; the end-of-verify
check still enforces freshness` and treat as fresh. Fresh reports print `campaign-check: <ws>.json fresh (generated
<ISO>)`. Exit 0 when nothing is refused. Missing consulted reports in this mode ⇒ treated like MISS (turbo will
  generate them) with a note. Wall time ≤ 10 s on a warm tree.
- **R5 (P0) Verify wiring.** Root `package.json` `scripts.verify` starts with
  `node scripts/campaign-check.mjs --freshness-only && ` (before `validate-lock-edges`) and still ends with
  `node scripts/campaign-check.mjs`.
- **R6 (P1) Test seam.** Env `CAMPAIGN_CHECK_TURBO_DRY_RUN=<path to a JSON file>` replaces the turbo spawn ONLY when
  `JEST_WORKER_ID` is set (prints `WARNING: CAMPAIGN_CHECK_TURBO_DRY_RUN honoured inside a Jest worker`); set without
  `JEST_WORKER_ID` it prints `campaign-check: CAMPAIGN_CHECK_TURBO_DRY_RUN ignored outside a Jest worker` and the real
  turbo is used — the `SCHEMA_DRIFT_PRISMA_CLI` shape (`apps/api/scripts/schema-drift.mjs`). The existing `--runs-dir`
  and `CAMPAIGN_CHECK_STATUS_DIR` are the only other seams; add none.
- **R7 (P1) Docs.** SKILL.md: "Keeping the registry honest" states the rule and the pre-step; "Closing out" gets the
  ritual line right after the `prove`/`discharge` examples. Code map: `campaign-check.mjs` entry (rule, pre-step, seam),
  the reporter's stamp, the new spec; CHANGELOG bullet; `_meta` bump.
- **R8 (P1) Lesson.** L-083 (`lesson-L-083.md`, tooling); archive L-065 and L-046 (oldest active entries whose Guard
  names an automated artifact, skipping L-072 which CLAUDE.md cites by id); `_meta.json` nextId 84, activeCount 39
  (two out, one in — the byte cap, not the count, is binding), archivedCount +2; `validate-lessons` exit 0.

## Test plan — `apps/api/src/common/campaign-check-freshness.spec.ts`

Harness: `spawnSync(process.execPath, [SCRIPT, ...args], { cwd: <fixture repo>, env: scrubbed, encoding: "utf8",
timeout: 60_000 })` with `SCRIPT = <repo>/scripts/campaign-check.mjs`; scrubbed env = `{ ...process.env }` minus
`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `CAMPAIGN_CHECK_TURBO_DRY_RUN`, plus `CAMPAIGN_CHECK_STATUS_DIR=<fixture>/.claude/campaign/status`
and `--runs-dir <fixture>/.campaign/runs`. Fixture (per test, `mkdtempSync`, removed in `finally`): `git init -q`,
`git config user.email/name`, commit 1 = `apps/api/src/fixture.spec.ts` (a file), commit 2 = `.claude/campaign/status/F01.jsonl`
with one row `{ id: "B1", batch: "F01", tier: "T1", state: "done", proof: "REG-B1 …" }`, each commit given an explicit
`GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` (epoch seconds chosen per test); reports written as
`{ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, generatedAt: <ISO chosen per test>, testResults: [{ assertionResults: [{ fullName: "REG-B1 passes", status: "passed" }] }] }`.
`mobile.json`/`pricing.json` written fresh unless the test says otherwise. Every assertion reads `{ status, stdout, stderr }`.

| T#  | R#    | Given → When → Then (oracle)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Red today (must fail on)                            |
| --- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| T1  | R1,R2 | spec commit at t0, ledger commit at t0+600 s; api `generatedAt` = t0+300 s (token present, passing) → full mode `status` 1; combined output contains `STALE`, `api.json`, `the ledger shards`, the ISO of t0+600, `cd apps/api && npx jest --maxWorkers=2`, `ritual:`; and NOT `no test titled`.                                                                                                                                                                                                                                                                        | status 0 today                                      |
| T2  | R1    | ledger at t0, spec commit at t0+600 s, api `generatedAt` = t0+300 s → status 1, output names `apps/api test files`.                                                                                                                                                                                                                                                                                                                                                                                                                                                     | status 0                                            |
| T3  | R1    | both commits ≤ t0, api `generatedAt` = t0+600 s → status 0 and output contains `api.json fresh`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | no `fresh` line                                     |
| T4  | R3    | positive control: no `done`/`proven` T1 row (row state `queued`) and a STALE api report → status 0, no `STALE` in output.                                                                                                                                                                                                                                                                                                                                                                                                                                               | green today AND after (excluded from the red claim) |
| T5  | R3    | consulted api report MISSING (no api.json) → status 1, output contains the existing artifact-missing text AND `regenerate: cd apps/api && npx jest --maxWorkers=2`.                                                                                                                                                                                                                                                                                                                                                                                                     | missing text without `regenerate:`                  |
| T6  | R4,R6 | `--freshness-only`, stale api report whose token is WRONG (`REG-B2`), `CAMPAIGN_CHECK_TURBO_DRY_RUN` → file with `tasks:[{package:"@routeflow/api",taskId:"@routeflow/api#test",cache:{status:"HIT"}}]`, `JEST_WORKER_ID` set → status 1, output contains `would replay`, `cd apps/api && npx jest --maxWorkers=2`, `WARNING: CAMPAIGN_CHECK_TURBO_DRY_RUN`; and NOT `REG-B2`/`no test titled` (no scan ran).                                                                                                                                                           | unknown flag ⇒ full scan today                      |
| T7  | R4    | same with `cache.status: "MISS"` → status 0, output contains `cache miss` and `continuing`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | status 1 today                                      |
| T8  | R4    | same with the override file holding `not json` → status 0, output contains `fail open`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | status 1 today                                      |
| T9  | R6    | same as T6 but `JEST_WORKER_ID` deleted from the child env → output contains `ignored outside a Jest worker`; and, because the fixture has no turbo, `fail open`; status 0.                                                                                                                                                                                                                                                                                                                                                                                             | no such lines today                                 |
| T10 | R0    | run the REAL reporter (`scripts/jest-campaign-reporter.cjs`) in-process with a fake `aggregatedResults` (`{ numTotalTests:1, numPassedTests:1, numFailedTests:0, testResults:[] }`) and an artifact dir override (read the reporter: it takes `{ artifact }` options and writes under the repo's `.campaign/runs` — point it at the fixture via whatever cwd/option it honours; if it has no override, run it via a child `node -e` with `cwd` = fixture) → the written JSON has `generatedAt` (valid ISO) and a `gitHead` key; the four original fields are unchanged. | no `generatedAt` today                              |
| T11 | R5    | root `package.json` `scripts.verify` starts with `node scripts/campaign-check.mjs --freshness-only && ` and ends with `node scripts/campaign-check.mjs`.                                                                                                                                                                                                                                                                                                                                                                                                                | false today                                         |

Anti-vacuity: drop the time comparison ⇒ T1/T2 red; bound by HEAD instead of the two path sets ⇒ T3 red (a later docs
commit); skip the consult scoping ⇒ T4 red; MISS treated as HIT ⇒ T7 red; override honoured without the worker id ⇒ T9
red; reporter stamp removed ⇒ T10 red; pre-step removed from `verify` ⇒ T11 red.

Red gate: `cd apps/api && npx jest src/common/campaign-check-freshness.spec.ts --runInBand` — T1–T3, T5–T11 fail on their
own expected values before the implementation; T4 is the positive control (green before and after) and is excluded from
the "0 passed" claim. If the campaign reporter cannot be pointed at a fixture dir, T10 tests the reporter module's
`onRunComplete` via a child process with `cwd` = the fixture (report the mechanism used).

## Addendum after the build (Fable, 2026-09-06 ~18:2xZ) — R9 partial reports (the L-063 twin of the trap)

The implementer's own gate showed it: running the new spec scoped inside `apps/api` made the campaign reporter
overwrite `api.json` with an 11-test report — "fresh" by time, useless as evidence. A time rule alone lets a scoped run
launder a stale report.

- **R9 (P0) Partial reports.** The reporter also stamps `partial: true|false` — true when Jest ran with a test path
  pattern or a test name pattern (read the installed Jest's `globalConfig`: `testPathPatterns` (Jest 30, an object with
  `.isSet()`/`.patterns`, or an array) / `testPathPattern` (older) / `testNamePattern`); false for a full-suite run.
  campaign-check treats `partial === true` as NOT acceptable evidence in BOTH modes: full mode refuses before scanning
  with `campaign-check: <runsDir>/<ws>.json is PARTIAL — a scoped jest run wrote it (<patterns>); regenerate with the
full suite: cd <dir> && npx jest --maxWorkers=2` (+ the `rule:`/`ritual:` lines); `--freshness-only` treats a
  partial report exactly like a stale one (HIT ⇒ refuse with the same block + the replay line; MISS ⇒ continue with
  `partial but turbo will regenerate it`). A report without the field (old reporter) is judged by time only.
- **T12 (R9)** reporter: `onRunComplete` with a `globalConfig` whose path patterns are set ⇒ written JSON has
  `partial: true` and lists the patterns; with none set ⇒ `partial: false`. **T13 (R9)** full mode: a report with
  `partial: true`, fresh by time, token present ⇒ status 1, output contains `PARTIAL`, `full suite`,
  `cd apps/api && npx jest --maxWorkers=2`, not `no test titled`. **T14 (R9)** `--freshness-only`, partial + injected
  HIT ⇒ status 1 with `would replay`; partial + MISS ⇒ status 0 with `continuing`.
  Anti-vacuity: drop the `partial` branch ⇒ T13/T14 red; reporter always writes `partial: false` ⇒ T12 red.
