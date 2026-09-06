# TP-1 report — campaign-check freshness guard spec

Package: TP-1 (Sonnet test author). Branch `fix/campaign-check-report-freshness` @ `597c72dc`.
Wrote exactly one new file: `apps/api/src/common/campaign-check-freshness.spec.ts` (467 lines).
No other file touched. No commit/stash/checkout/reset performed. No `npm ci`/install/Docker/turbo
run. Only the single spec file was run, with `--runInBand`.

## Command run

```
cd apps/api && npx jest src/common/campaign-check-freshness.spec.ts --runInBand
```

Result: `Test Suites: 1 failed, 1 total` / `Tests: 10 failed, 1 passed, 11 total` (15.9 s).

## Per-test result (PASS/FAIL) and first failing assertion

| T#  | R#    | Result   | First failing assertion (expected → received)                                                                                                                                                                                                                                                                                                                          |
| --- | ----- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | R1,R2 | FAIL     | `toContain("STALE")` → not found; today's output is `✔ every affirmative claim in scope is backed by a real proof (1 checked).` (status **0**, not the expected 1) — matches spec's "Red today: status 0 today".                                                                                                                                                       |
| T2  | R1    | FAIL     | `toContain("apps/api test files")` → not found; same all-green output, status 0 today — matches "Red today: status 0".                                                                                                                                                                                                                                                 |
| T3  | R1    | FAIL     | `toContain("api.json fresh")` → not found; output is the same all-green line (status 0 today, matching the expected 0) — matches "Red today: no `fresh` line" (only the fresh-line assertion is red; status already agrees).                                                                                                                                           |
| T4  | R3    | **PASS** | Positive control — green today and (expected) after. `not.toContain("STALE")` and `status===0` both hold today, since a `queued` row never triggers `t1Needed` and `api.json` is never even read.                                                                                                                                                                      |
| T5  | R3    | FAIL     | `toContain("regenerate: cd apps/api && npx jest --maxWorkers=2")` → not found. Today's output already contains the existing artifact-missing text verbatim (`at least one T1 obligation is claimed, but none of ...`) and status is already 1 — only the new `regenerate:` line is missing, matching "Red today: missing text without `regenerate:`" exactly.          |
| T6  | R4,R6 | FAIL     | `toContain("would replay")` → not found. Today's `--freshness-only` is an unrecognized flag, so a full scan runs and reports `B1: no test titled with REG-B1 found in the jest report` (status 1, coincidentally matching the expected status) — matches "Red today: unknown flag ⇒ full scan today".                                                                  |
| T7  | R4    | FAIL     | `toContain("cache miss")` → not found. Same full-scan-today output as T6; status is 1 today vs expected 0 — matches "Red today: status 1 today".                                                                                                                                                                                                                       |
| T8  | R4    | FAIL     | `toContain("fail open")` → not found. Same full-scan-today output; status 1 vs expected 0 — matches "Red today: status 1 today".                                                                                                                                                                                                                                       |
| T9  | R6    | FAIL     | `toContain("ignored outside a Jest worker")` → not found. Same full-scan-today output; status 1 vs expected 0.                                                                                                                                                                                                                                                         |
| T10 | R0    | FAIL     | `typeof written.generatedAt` → `"undefined"`, expected `"string"`. The real reporter writes only the four original fields today; `generatedAt`/`gitHead` don't exist yet. Child process itself exits 0 (no crash) and the file IS written correctly otherwise (`numTotalTests`/`numPassedTests`/`numFailedTests`/`testResults` all assert correctly before this line). |
| T11 | R5    | FAIL     | `verify.startsWith("node scripts/campaign-check.mjs --freshness-only && ")` → `false`. Root `package.json`'s current `verify` script has no freshness pre-step.                                                                                                                                                                                                        |

Every FAIL is a real assertion mismatch against a concrete received value (a missing substring or
a status/type mismatch) — none is a thrown fixture error, a TypeScript compile error, or a spawn
`ENOENT`. All `git`/`node` child processes involved (fixture `git init`/`commit`, the real
`campaign-check.mjs` spawn, and the real `jest-campaign-reporter.cjs` child for T10) exited
cleanly; only their _content_ differs from the post-implementation expectation.

## T10 mechanism

`jest-campaign-reporter.cjs` (56 lines, read in full) takes no artifact-directory override — its
constructor only reads `options.artifact` (the filename stem). It resolves its output directory as
`path.resolve(process.cwd(), "..", "..")` + `.campaign/runs`, i.e. two levels up from wherever the
reporter runs. Per the task's documented fallback, T10 drives the REAL module via a child process:
it creates `<fixture>/apps/api` (mirroring the real two-levels-deep workspace layout), then spawns
`node -e "<script>"` with `cwd: <fixture>/apps/api`. The inline script does
`require(<absolute path to scripts/jest-campaign-reporter.cjs>)`, constructs
`new Reporter(null, { artifact: "api" })`, and calls
`.onRunComplete(null, { numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, testResults: [] })`
synchronously (the reporter's write is `fs.writeFileSync`, so no wait is needed after the child
exits). The test then reads `<fixture>/.campaign/runs/api.json` and asserts on its parsed content.

## tsc result

- `cd apps/api && npx tsc -p tsconfig.build.json --noEmit` → **exit 0**, no output.
- Both `tsconfig.build.json` (`exclude: [..., "**/*spec.ts", ...]`) and the base `tsconfig.json`
  itself (`exclude: ["**/*.spec.ts", "**/*.test.ts", ...]`) exclude spec files from their own file
  enumeration, so **neither bare `tsc -p` run type-checks this file at all** — confirmed by also
  running `npx tsc -p tsconfig.json --noEmit` (exit 0, no output, same as the build config). Ran
  both per the task's contingency instruction; both exclude specs, so this is reported rather than
  treated as a pass on the new file's own types.
- The real type-check signal for this file is `ts-jest`, which compiles+type-checks each spec it
  runs regardless of the tsconfig's own `exclude` list (Jest hands it the exact file to transform).
  The Jest run above completed all 11 tests with clean assertion failures and no
  "Test suite failed to run" / TS-diagnostic error, which is the evidence the file type-checks
  correctly under the real toolchain.

## `git status --porcelain`

```
?? .claude/pipeline/2026-09-06-campaign-check-freshness/
?? apps/api/src/common/campaign-check-freshness.spec.ts
```

(The pipeline run directory, including this report, was already untracked at task start; the spec
file is the only code change. Nothing staged, nothing committed.)

## Design decisions made where the spec table's fixture description was ambiguous

The task told me to stop at a genuine gap rather than guess; the two places below were resolvable
with reasonable confidence from the table's own "Red today" column (an explicit, checkable
constraint), so I resolved them and record the reasoning here rather than blocking:

1. **T5's mobile.json/pricing.json.** The harness section's default ("mobile.json/pricing.json
   written fresh unless the test says otherwise") would, if applied literally to T5 (only
   `api.json` absent, mobile/pricing present with the default passing `REG-B1` hit), make TODAY's
   full scan actually **succeed** (mobile/pricing already prove `B1`) — contradicting T5's own
   "Red today: missing text without `regenerate:`" annotation, which presupposes the existing
   artifact-missing message already fires today. I made mobile.json and pricing.json absent too
   (all three T1 reports missing), which reproduces today's real all-three-null code path
   verbatim and makes only the `regenerate:` line the red assertion — exactly matching the
   annotated reason. Confirmed empirically: this is exactly what the test run above shows.
2. **T6–T9's mobile.json/pricing.json.** Same reasoning: leaving them at the "fresh, default
   REG-B1" content would let TODAY's full scan (which ignores the unrecognized `--freshness-only`
   flag) succeed via cross-workspace token matching, contradicting each row's stated "Red today"
   (status 1 today via `no test titled`, or T6's explicit "unknown flag ⇒ full scan today"). I
   omitted mobile.json/pricing.json for T6–T9 (irrelevant post-implementation too, since
   `--freshness-only` mode treats a missing consulted report as MISS-equivalent per R4, so their
   absence doesn't affect the intended future behavior of these api-focused cases either).
   Confirmed empirically against the actual "Red today" text for all four tests.

## Flagged (not blocking) discrepancy for the build/review phase

**R4 says the turbo dry-run child runs with `cwd = repo root`, but T9's own oracle says "because
the fixture has no turbo, fail open."** Since `campaign-check.mjs`'s `REPO_ROOT` constant is
derived from `import.meta.url` (the script's own on-disk location), a future implementation
following R4 literally would spawn `npx turbo run test --filter=@routeflow/api --dry-run=json`
against the **real** monorepo root (which has turbo installed and, per `reader.md` §4, currently
reports a real cache HIT for `@routeflow/api#test`) — not a spawn failure. That would make T9's
real-turbo path hit the R4 "HIT ⇒ refuse" branch instead of "dry-run unavailable ⇒ fail open,"
contradicting T9's literal expected text. I implemented T9 exactly as specified in the test table
(asserting `"ignored outside a Jest worker"`, `"fail open"`, `status === 0`) since that is the
explicit, approved oracle I was told to encode — but flagging this tension for whoever builds R4/R6
so it isn't rediscovered the hard way at build time. Possible resolutions: (a) `cwd` for the dry-run
child is actually meant to be the fixture-relative REPO_ROOT is fine but turbo genuinely fails
there because the fixture has no `turbo.json`/`node_modules` (my original literal reading — but I
could not reconcile this with R4's explicit "cwd = repo root" wording), or (b) T9's oracle needs a
`CAMPAIGN_CHECK_TURBO_BIN`-style seam (not yet specified) so a test can force a spawn failure
without depending on the ambient monorepo's real turbo state.
