# R9 report — partial-report guard (T12–T14)

Package: Sonnet implementer, R9 follow-on round (the spec's "Addendum after the build").
Worktree: `C:/ClaudeCode/routeflow/.claude/worktrees/rf-registry`, branch
`fix/campaign-check-report-freshness` @ `597c72dc` (unchanged from WP-0..3 — no commit made).

Files touched (exactly the three permitted): `scripts/jest-campaign-reporter.cjs`,
`scripts/campaign-check.mjs`, `apps/api/src/common/campaign-check-freshness.spec.ts`
(appended T12–T14 only; T1–T11 untouched). No commit/stash/checkout/reset performed. No
`npm ci`/install/Docker/turbo-task/full Jest suite run.

## Jest version + `globalConfig` field used

`apps/api`'s installed Jest is **30.2.0** (`node -e "console.log(require('jest/package.json').version)"`
from `apps/api`). Read `node_modules/@jest/types/build/index.d.ts`: the `GlobalConfig` type
(the object a custom reporter's constructor receives as its first argument) declares
`testPathPatterns: TestPathPatterns` and `testNamePattern?: string`. `TestPathPatterns` is
imported from `@jest/pattern`; its real source (`node_modules/@jest/pattern/src/TestPathPatterns.ts`)
is a class with `readonly patterns: Array<string>` and `isSet(): boolean { return this.patterns.length > 0; }`
— confirming the spec's guidance ("Jest 30, an object with `.isSet()`/`.patterns`"). The reporter's
`computePartial()` reads `globalConfig.testPathPatterns` defensively: if it exposes `.isSet` (Jest
30's shape) it calls that; else if it's a plain array (older Jest) it checks `.length`; it also
reads `globalConfig.testPathPattern` (older Jest's string field) and `globalConfig.testNamePattern`
(a plain string in every version) for the `-t`/name-filter case. No behavior depends on an
unverified guess — every branch is backed by the type/source read above.

## Hunks

### `scripts/jest-campaign-reporter.cjs`

Added a `computePartial(globalConfig)` helper (placed above the `CampaignReporter` class) and
wired its result into the written JSON. The constructor now stores `globalConfig` on the
instance so `onRunComplete` can read it.

```diff
+// R9: partial-report detection — true when jest ran scoped to a test path or name pattern
+// (a positional file arg, `-t`, `--testPathPattern`, …), which leaves this artifact covering
+// only the tests that ran, not the full workspace suite (a scoped run can "launder" a stale
+// report by making it fresh-by-time while still not being real full-suite evidence — the L-063
+// twin R9 exists to close). Reads the installed Jest's `globalConfig` defensively across
+// versions: Jest 30 wraps path patterns in a `TestPathPatterns` object from `@jest/pattern`
+// (`.isSet()` / `.patterns`); older Jest exposes a plain `testPathPattern` string.
+// `testNamePattern` (a `-t` filter) is a plain string in every version.
+function computePartial(globalConfig) {
+  const patterns = [];
+  const gc = globalConfig || {};
+
+  const tpp = gc.testPathPatterns;
+  if (tpp && typeof tpp.isSet === "function") {
+    if (tpp.isSet() && Array.isArray(tpp.patterns)) patterns.push(...tpp.patterns);
+  } else if (Array.isArray(tpp) && tpp.length > 0) {
+    patterns.push(...tpp);
+  }
+
+  if (typeof gc.testPathPattern === "string" && gc.testPathPattern) {
+    patterns.push(gc.testPathPattern);
+  }
+  if (typeof gc.testNamePattern === "string" && gc.testNamePattern) {
+    patterns.push(gc.testNamePattern);
+  }
+
+  return { partial: patterns.length > 0, partialPatterns: patterns };
+}
+
 class CampaignReporter {
   constructor(globalConfig, options) {
     this._name = (options && options.artifact) || "api";
+    this._globalConfig = globalConfig;
   }
   onRunComplete(_contexts, results) {
     try {
       const root = path.resolve(process.cwd(), "..", "..");
       const dir = path.join(root, ".campaign", "runs");
       fs.mkdirSync(dir, { recursive: true });
+      const { partial, partialPatterns } = computePartial(this._globalConfig);
       const out = {
         numTotalTests: results.numTotalTests,
         numPassedTests: results.numPassedTests,
         numFailedTests: results.numFailedTests,
         generatedAt: new Date().toISOString(),
         gitHead: gitHead(),
+        // R9: true when this run was scoped (a test path or name pattern), so campaign-check
+        // must not accept it as full-suite evidence even when it is fresh by time.
+        partial,
+        partialPatterns,
         testResults: (results.testResults || []).map((suite) => ({
```

### `scripts/campaign-check.mjs`

Added `partialBlock(wsInfo, patterns)` (mirrors `staleBlock`'s three-line shape, same
`rule:`/`ritual:` lines per R9's instruction). Rewired the per-workspace loop inside
`checkFreshness(mode)`: a report with `raw.partial === true` is refused unconditionally
(computed _before_ the staleness check, independent of report age); a report without the
field, or with `partial: false`, falls through unchanged to the existing time-based
staleness logic. Both branches now converge on one `block`/`reason` pair so the
full-mode/`--freshness-only` branching below (refuse / ask turbo / HIT-refuse /
MISS-continue / fail-open) is shared code, not duplicated per reason.

```diff
   function staleBlock(wsInfo, reportTimeMs, viaMtime, newestCause) {
     ... (unchanged)
   }
+
+  // R9: a scoped jest run (a test path or name pattern) can leave a report that is FRESH by
+  // time but still not real full-suite evidence — the reporter stamps `partial: true` for
+  // exactly this case (L-063's twin: the gate's own scoped spec run overwrote api.json with an
+  // 11-test partial result — see wp-report.md §Gate 4a/4c). Same rule/ritual lines as staleBlock
+  // by design (R9: "plus the rule:/ritual: lines").
+  function partialBlock(wsInfo, patterns) {
+    const patternsStr =
+      patterns && patterns.length ? patterns.join(", ") : "(no patterns recorded)";
+    return [
+      `campaign-check: ${wsInfo.jsonPath} is PARTIAL — a scoped jest run wrote it (${patternsStr}); ` +
+        `regenerate with the full suite: cd ${wsInfo.dir} && npx jest --maxWorkers=2`,
+      `  rule: a report must be newer than the newest commit touching its workspace's tests or the ledger shards`,
+      `  ritual: after ANY ledger edit or master merge, run the regen command in every workspace with T1 claims, then push`,
+    ].join("\n");
+  }
```

Inside the per-workspace loop (`for (const wsInfo of T1_WORKSPACES)`), the old
"compute testsCommit/ledgerCommit → isStale → block-or-continue" block was replaced with:

```diff
+      const isPartial = raw && raw.partial === true;
+      const partialPatterns =
+        isPartial && Array.isArray(raw.partialPatterns) ? raw.partialPatterns : [];
+
+      let block = null;
+      let reason = null; // "stale" | "partial" — only used in the freshness-only MISS message
+
+      if (isPartial) {
+        block = partialBlock(wsInfo, partialPatterns);
+        reason = "partial";
+      } else {
-      const testsCommit = ...
-      const ledgerCommit = ...
-      let newestCause = null;
-      ...
-      const isStale = ...
-      if (!isStale) { console.log(...fresh...); continue; }
-      const block = staleBlock(wsInfo, reportTimeMs, viaMtime, newestCause);
+        const testsCommit = gitRoot ? newestCommit(gitRoot, wsInfo.testPathspecs) : null;
+        const ledgerCommit =
+          gitRoot && ledgerPathspec ? newestCommit(gitRoot, [ledgerPathspec]) : null;
+        let newestCause = null;
+        if (testsCommit) newestCause = { label: `${wsInfo.dir} test files`, commit: testsCommit };
+        if (ledgerCommit && (!newestCause || ledgerCommit.ct > newestCause.commit.ct)) {
+          newestCause = { label: "the ledger shards", commit: ledgerCommit };
+        }
+        const isStale = newestCause !== null && reportTimeMs < newestCause.commit.ct * 1000;
+        if (isStale) {
+          block = staleBlock(wsInfo, reportTimeMs, viaMtime, newestCause);
+          reason = "stale";
+        }
+      }
+
+      if (!block) {
+        console.log(`campaign-check: ${wsInfo.ws}.json fresh (generated ...)`);
+        continue;
+      }

       if (mode === "full") { console.error(block); anyStaleFull = true; continue; }

       const pkg = resolvePkgName(gitRoot, wsInfo);
       const dryRun = turboDryRunStatus(gitRoot, pkg);
       if (dryRun.status === "HIT") {
         console.error(block);
         console.error(`  turbo would replay ${dryRun.pkg}#test from cache, so this verify cannot refresh the report`);
         anyHitRefusal = true;
       } else if (dryRun.status === "MISS") {
-        console.log(`campaign-check: ${wsInfo.ws}.json is stale but turbo will regenerate it (cache miss) — continuing`);
+        console.log(`campaign-check: ${wsInfo.ws}.json is ${reason} but turbo will regenerate it (cache miss) — continuing`);
       } else {
         console.log(`campaign-check: turbo dry-run unavailable for ${dryRun.pkg} — fail open; ...`);
       }
```

The only behavioral change to the pre-existing STALE path is the `${reason}` substitution in
the MISS-continue line — `reason` is `"stale"` on that path, so the printed text is
byte-identical to before (`"is stale but turbo will regenerate it..."`); T6/T7/T8/T9 (which
pin that exact wording) stayed green throughout, confirming no regression.

### `apps/api/src/common/campaign-check-freshness.spec.ts`

Appended three tests after T11, before the `describe`'s closing brace — no existing line
touched. `git diff --stat` on this file isn't listed by `git diff` (it's untracked, not yet
committed — same as after WP-0..3); its presence is `??` in `git status --porcelain`.

- **T12 (R9)** — two sub-cases in one `it`, each spawning a child `node -e` that
  `require()`s the real reporter and calls `onRunComplete` directly (mirrors T10's mechanism
  exactly, extended with an explicit `globalConfig` object literal instead of `null`).
  Case A: `globalConfig.testPathPatterns = { patterns: ["campaign-check-freshness"], isSet() {...} }`
  → asserts `written.partial === true` and `written.partialPatterns` contains the pattern.
  Case B: `globalConfig.testPathPatterns = { patterns: [], isSet() {...} }` → asserts
  `written.partial === false`.
- **T13 (R9)** — full mode: a hand-written `api.json` (not via the shared `writeReport()`
  helper, to avoid touching it) with `generatedAt` after both the spec-commit and
  ledger-commit (i.e. fresh by time) and the exact claimed token (`REG-B1 passes`,
  matching), but `partial: true` — asserts the run refuses (`status 1`) with `PARTIAL`,
  `full suite`, `cd apps/api && npx jest --maxWorkers=2` all present and `no test titled`
  absent (proving the token scan never ran).
- **T14 (R9)** — `--freshness-only`, two sub-cases (HIT / MISS) in one `it`, each with a
  hand-written `partial: true` `api.json` and a stubbed `CAMPAIGN_CHECK_TURBO_DRY_RUN` file
  (via the existing `writeTurboDryRunFile` helper): HIT → `would replay`, status 1; MISS →
  `continuing`, status 0.

## Gate 1 — the spec, 14/14 green

```
cd apps/api && npx jest src/common/campaign-check-freshness.spec.ts --runInBand
```

```
PASS src/common/campaign-check-freshness.spec.ts (22.143 s)
  campaign-check freshness guard (spec T1–T11)
    √ T1 (R1,R2) ... (1600 ms)
    √ T2 (R1) ... (2094 ms)
    √ T3 (R1) ... (2332 ms)
    √ T4 (R3) ... (1145 ms)
    √ T5 (R3) ... (1598 ms)
    √ T6 (R4,R6) ... (2062 ms)
    √ T7 (R4) ... (2095 ms)
    √ T8 (R4) ... (1901 ms)
    √ T9 (R6) ... (1594 ms)
    √ T10 (R0) ... (286 ms)
    √ T11 (R5) ... (31 ms)
    √ T12 (R9) ... (515 ms)
    √ T13 (R9) ... (1862 ms)
    √ T14 (R9) ... (2641 ms)

Test Suites: 1 passed, 1 total
Tests:       14 passed, 14 total
```

Ran twice (once cold, once after the prettier pass below) — both 14/14 green, no drift in
behavior from formatting.

### Anti-vacuity probes (actually run, not asserted)

Per the task's "ground every claim in command output" instruction, ran three isolated probes
(backed up the two source files to the scratchpad dir first, restored immediately after each
probe, confirmed restoration with `grep -c "ANTI-VACUITY PROBE"` = 0 both times):

1. **`isPartial` forced to `false`** in `campaign-check.mjs` (the partial branch effectively
   removed) → `npx jest ... -t "R9"` → **T12 still passed** (it only exercises the reporter,
   not campaign-check.mjs) but **T13 and T14 both failed** exactly as the spec's anti-vacuity
   note predicts ("drop the `partial` branch ⇒ T13/T14 red"). T13's failure: expected
   `"PARTIAL"` in output, got a clean `fresh`/`✔ every affirmative claim...` pass-through.
   T14's failure: expected `"would replay"`, got `fresh`/`missing — turbo will generate it`
   (mobile/pricing.json didn't exist in that fixture, an orthogonal artifact of the probe's
   minimal fixture, not a defect).
2. **`computePartial()` forced to always return `partial: false`** in
   `jest-campaign-reporter.cjs` → `npx jest ... -t "T12"` → **T12 failed** exactly as
   predicted ("reporter always writes `partial: false` ⇒ T12 red"): `expect(writtenA.partial).toBe(true)`
   received `false`.
3. Restored both files from the scratchpad backups, re-ran the full 14-test file → **14/14
   green again**, confirming the restore was clean and the anti-vacuity probes left no
   residue.

This directly confirms the spec's addendum anti-vacuity claims ("drop the `partial` branch ⇒
T13/T14 red; reporter always writes `partial: false` ⇒ T12 red") against the actual
implementation, not by inspection alone.

## Gate 2 — tsc

```
cd apps/api && npx tsc -p tsconfig.build.json --noEmit
```

Exit 0, no output.

## Gate 3 — prettier

```
npx prettier --write scripts/campaign-check.mjs scripts/jest-campaign-reporter.cjs apps/api/src/common/campaign-check-freshness.spec.ts
```

All three reported `(unchanged)` — the WP-0..3 formatting conventions (and my additions
following them by hand) were already Prettier-clean.

```
npx prettier --check scripts/campaign-check.mjs scripts/jest-campaign-reporter.cjs apps/api/src/common/campaign-check-freshness.spec.ts
```

`All matched files use Prettier code style!`

## Gate 4 — `bugs.mjs self-test`

```
node scripts/campaign/bugs.mjs self-test
```

```
self-test: all checks passed
```

Exit 0. (This run took >60s and moved to a background shell; output confirmed via the
background task's captured stdout — same result, `self-test: all checks passed`, exit 0.)

## Gate 5 — git status / diff --stat

```
$ git status --porcelain
 M .claude/code-map/CHANGELOG.md          <- WP-4, not this package
 M .claude/code-map/INDEX.md              <- WP-4, not this package
 M .claude/code-map/_meta.json            <- WP-4, not this package
 M .claude/code-map/api.md                <- WP-4, not this package
 M .claude/lessons/ARCHIVE.md             <- WP-4, not this package
 M .claude/lessons/LESSONS.md             <- WP-4, not this package
 M .claude/lessons/_meta.json             <- WP-4, not this package
 M .claude/skills/bug-registry/SKILL.md   <- WP-4, not this package
 M package.json                           <- WP-3, not this package (R9 didn't touch it)
 M scripts/campaign-check.mjs             <- WP-1/WP-2 + R9 (this package)
 M scripts/jest-campaign-reporter.cjs     <- WP-0 + R9 (this package)
?? .claude/pipeline/2026-09-06-campaign-check-freshness/
?? apps/api/src/common/campaign-check-freshness.spec.ts   <- TP-1 + R9's T12-T14 append

$ git diff --stat -- scripts/campaign-check.mjs scripts/jest-campaign-reporter.cjs
 scripts/campaign-check.mjs         | 311 ++++++++++++++++++++++++++++++++++++-
 scripts/jest-campaign-reporter.cjs |  57 +++++++
 2 files changed, 366 insertions(+), 2 deletions(-)
```

(cumulative diff against base `597c72dc` across WP-0/1/2 + this R9 round; the untracked spec
file has no `diff --stat` line since git has never seen a prior version of it to diff
against — its total line count after T12-T14 is 690 lines, up from 465 before this round.)

## Note: `.campaign/runs/api.json` overwritten (expected, per the task brief)

Running the Gate 1 spec inside `apps/api` re-triggers the real campaign reporter for that
workspace (it is wired as a second Jest reporter in `apps/api`'s own `package.json`), so
`.campaign/runs/api.json` on disk is now a 14-test **partial** report (this scoped run's own
`generatedAt`/`partial: true`/`partialPatterns` reflecting `["src/common/campaign-check-freshness.spec.ts"]`)
— exactly the defect class R9 exists to catch, and exactly what the task brief flagged as
"acceptable here and self-heals on the next full verify" (the next real `npm run verify` or
CI run's own unsplit `apps/api` test pass regenerates it with `partial: false`). Not a
regression; not fixed in this round (fixing it would require the forbidden full
`apps/api` jest run).

## Deviations from the literal task text

1. **`apps/api/src/common/campaign-check-freshness.spec.ts`'s `describe(...)` title** still
   reads `"campaign-check freshness guard (spec T1–T11)"` — left unchanged. The task scoped
   this file to "append T12–T14 only"; updating the title string would be a edit to
   pre-existing content, not an append, so it was deliberately left as-is rather than
   silently touched. Flagging as a cosmetic staleness the next round (or a maintainer) may
   want to fix — it does not affect test behavior or naming (each `it()`'s own title still
   correctly says "T12 (R9)"/"T13 (R9)"/"T14 (R9)").
2. No other deviations. All three T12–T14 oracles matched the spec's literal message-shape
   requirements on first implementation (no adjustment needed after the initial write); the
   anti-vacuity probes (see Gate 1) independently confirmed the red-without-implementation
   claims for all three new tests.
