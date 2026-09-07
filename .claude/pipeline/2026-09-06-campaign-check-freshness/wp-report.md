# WP-0/WP-1/WP-2/WP-3 report — campaign-check freshness guard

Package: Sonnet implementer (WP-0 reporter stamp, WP-1 rule/refusal/scoping, WP-2
`--freshness-only`/turbo dry-run/test seam, WP-3 verify wiring).
Worktree: `C:/ClaudeCode/routeflow/.claude/worktrees/rf-registry`, branch
`fix/campaign-check-report-freshness` @ base `597c72dc`.

Files touched (exactly the three named in scope): `scripts/campaign-check.mjs`,
`scripts/jest-campaign-reporter.cjs`, root `package.json` (`scripts.verify` only). No
commit/stash/checkout/reset performed. No `npm ci`/install/Docker/turbo-task run.

## Note: other files already modified in this worktree, not by this package

`git status --porcelain` (see §"git status" below) shows `.claude/code-map/{CHANGELOG.md,
INDEX.md,_meta.json,api.md}`, `.claude/lessons/{ARCHIVE.md,LESSONS.md,_meta.json}`, and
`.claude/skills/bug-registry/SKILL.md` already modified. These are exactly WP-4's file set
(docs + lesson + map, per build-plan.md's package table) — **this package did not touch any
of them**; they were already dirty in this shared worktree before/during this run (WP-4 is a
separate package). Flagging for the record, not fixing or reverting.

## WP-0 — reporter provenance stamp (`scripts/jest-campaign-reporter.cjs`)

Added a best-effort `gitHead()` helper (`spawnSync git rev-parse --short HEAD`, cwd =
`process.cwd()`, `null` on any failure — wrapped in try/catch, never throws) and two new
fields on the written JSON: `generatedAt: new Date().toISOString()` and `gitHead: gitHead()`.
All four original fields (`numTotalTests`, `numPassedTests`, `numFailedTests`, `testResults`)
are unchanged in shape and value.

```diff
diff --git a/scripts/jest-campaign-reporter.cjs b/scripts/jest-campaign-reporter.cjs
index cfa8c3c8..8e99a17d 100644
--- a/scripts/jest-campaign-reporter.cjs
+++ b/scripts/jest-campaign-reporter.cjs
@@ -22,6 +22,24 @@
  */
 const fs = require("node:fs");
 const path = require("node:path");
+const { spawnSync } = require("node:child_process");
+
+// Best-effort short git HEAD, for R0's provenance stamp — never throws, `null` on any
+// failure (binary missing, not a repo, non-zero exit). Read from `process.cwd()` at call
+// time (the workspace dir jest ran in), same as the reporter's own repo-root resolution.
+function gitHead() {
+  try {
+    const res = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
+      cwd: process.cwd(),
+      encoding: "utf8",
+      shell: false,
+    });
+    if (res.status === 0 && res.stdout && res.stdout.trim()) return res.stdout.trim();
+    return null;
+  } catch {
+    return null;
+  }
+}

 class CampaignReporter {
   constructor(globalConfig, options) {
@@ -37,6 +55,10 @@ class CampaignReporter {
         numTotalTests: results.numTotalTests,
         numPassedTests: results.numPassedTests,
         numFailedTests: results.numFailedTests,
+        // R0: provenance stamp so campaign-check.mjs can tell a fresh artifact from one a
+        // turbo cache replay left behind (L-034). Best-effort; every other field unchanged.
+        generatedAt: new Date().toISOString(),
+        gitHead: gitHead(),
         testResults: (results.testResults || []).map((suite) => ({
           name: suite.testFilePath,
           assertionResults: (suite.testResults || []).map((t) => ({
```

## WP-1/WP-2 — the guard (`scripts/campaign-check.mjs`)

Added: `--freshness-only` boolean flag parsing; `T1_WORKSPACES` (api/mobile/pricing with
`dir` + `:(glob)` test pathspecs per spec.md R1); `resolveGitRoot()` (memoized, `git -C
<statusDir> rev-parse --show-toplevel`); `newestCommit(gitRoot, pathspecs)`
(`git log -1 --format=%H%x1f%ct%x1f%s -- <pathspecs>`, `null` when no commit touches them);
`formatGeneratedAt`/`staleBlock` (the exact R2 three-line message); `resolvePkgName` (reads
`<dir>/package.json` name, falls back to `@routeflow/<ws>`); `resolveTurboBin` +
`spawnTurboDryRun` (real `<gitRoot>/node_modules/.bin/turbo[.cmd]` binary, never `npx`, `cwd`
= gitRoot); `turboDryRunStatus` (the R6 `CAMPAIGN_CHECK_TURBO_DRY_RUN`/`JEST_WORKER_ID` seam,
mirroring `schema-drift.mjs`'s `SCHEMA_DRIFT_PRISMA_CLI` wording); and `checkFreshness(mode)`,
called right after `t3Needed` is computed and before any jest-report loading/token indexing.
Full mode: evaluates every existing consulted T1 report, prints a STALE block (+ exits 1)
for each stale one after evaluating all of them; freshness-only mode: same, but a stale
report is resolved via turbo's dry-run (HIT → refuse, MISS → continue, unavailable → fail
open) and the function always calls `process.exit()` before returning (never reaches the
token scan). The pre-existing all-three-missing artifact message gained one
`  regenerate: cd <dir> && npx jest --maxWorkers=2` line per T1 workspace.

```diff
diff --git a/scripts/campaign-check.mjs b/scripts/campaign-check.mjs
index 5281615a..a362a1e2 100644
--- a/scripts/campaign-check.mjs
+++ b/scripts/campaign-check.mjs
@@ -88,7 +88,7 @@

 import fs from "node:fs";
 import path from "node:path";
-import { execFileSync } from "node:child_process";
+import { execFileSync, spawnSync } from "node:child_process";
 import { fileURLToPath } from "node:url";
 import { normalizeEvidence } from "./campaign/normalize-evidence.mjs";
 import {
@@ -110,6 +110,8 @@ function main() {
   const onlyBatch = flag("batch"); // e.g. "F02" — undefined means "scan every shard"
   const explicitPipelineDir = flag("pipeline-dir");
   const runsDir = path.resolve(REPO_ROOT, flag("runs-dir") || ".campaign/runs");
+  // --freshness-only: R4's pre-step. Boolean, no value — checked by presence, not flag().
+  const freshnessOnly = args.includes("--freshness-only");
   // Overridable via CAMPAIGN_CHECK_STATUS_DIR (mirrors bugs.mjs's BUGS_ROOT
   // seam) so a self-test can drive this REAL command against a throwaway
   // fixture ledger instead of the repo's own .claude/campaign/status.
@@ -366,18 +368,287 @@ function main() {
   const t2NeedsPostDeploy = rows.some((r) => r.tier === "T2" && r.state === "done");
   const t3Needed = rows.some((r) => r.tier === "T3" && consultsArtifacts(r));

+  // ---- R1-R4: report freshness (a turbo cache HIT can leave a stale .campaign/runs/*.json
+  // on disk — L-034 — so both the full scan and the `--freshness-only` pre-step must refuse
+  // to trust a report older than the newest commit touching its own tests or the ledger). ----
+  const T1_WORKSPACES = [
+    {
+      ws: "api",
+      dir: "apps/api",
+      jsonPath: apiJsonPath,
+      testPathspecs: [":(glob)apps/api/**/*.spec.ts"],
+    },
+    {
+      ws: "mobile",
+      dir: "apps/mobile",
+      jsonPath: mobileJsonPath,
+      testPathspecs: [
+        ":(glob)apps/mobile/__tests__/**",
+        ":(glob)apps/mobile/**/*.test.ts",
+        ":(glob)apps/mobile/**/*.test.tsx",
+      ],
+    },
+    {
+      ws: "pricing",
+      dir: "packages/pricing",
+      jsonPath: pricingJsonPath,
+      testPathspecs: [":(glob)packages/pricing/**/*.spec.ts"],
+    },
+  ];
+
+  // Git root for freshness lookups is derived from statusDir, not REPO_ROOT — REPO_ROOT is
+  // this SCRIPT's own on-disk location (always the real monorepo), while statusDir may be a
+  // throwaway fixture repo (CAMPAIGN_CHECK_STATUS_DIR); its commits are what freshness must
+  // be judged against. Resolved once, memoized.
+  let gitRootCache;
+  function resolveGitRoot() {
+    if (gitRootCache !== undefined) return gitRootCache;
+    try {
+      const res = spawnSync("git", ["-C", statusDir, "rev-parse", "--show-toplevel"], {
+        encoding: "utf8",
+        shell: false,
+      });
+      gitRootCache = res.status === 0 && res.stdout ? res.stdout.trim() : null;
+    } catch {
+      gitRootCache = null;
+    }
+    return gitRootCache;
+  }
+
+  // newestCommit(gitRoot, pathspecs) -> { sha, ct, subject } for the newest commit touching
+  // any of `pathspecs`, or null when no commit touches them (imposes no bound — R1).
+  function newestCommit(gitRoot, pathspecs) {
+    try {
+      const res = spawnSync("git", ["log", "-1", "--format=%H%x1f%ct%x1f%s", "--", ...pathspecs], {
+        cwd: gitRoot,
+        encoding: "utf8",
+        shell: false,
+      });
+      if (res.status !== 0 || !res.stdout || !res.stdout.trim()) return null;
+      const [sha, ctStr, subject] = res.stdout.trim().split("\x1f");
+      return { sha, ct: Number(ctStr), subject };
+    } catch {
+      return null;
+    }
+  }
+
+  function formatGeneratedAt(reportTimeMs, viaMtime) {
+    const isoStr = new Date(reportTimeMs).toISOString();
+    return viaMtime
+      ? `${isoStr} (file mtime — the report carries no generatedAt; regenerate once to stamp it)`
+      : isoStr;
+  }
+
+  function staleBlock(wsInfo, reportTimeMs, viaMtime, newestCause) {
+    const causeIso = new Date(newestCause.commit.ct * 1000).toISOString();
+    const shortSha = newestCause.commit.sha.slice(0, 7);
+    return [
+      `campaign-check: ${wsInfo.jsonPath} is STALE — generated ${formatGeneratedAt(reportTimeMs, viaMtime)} ` +
+        `but ${newestCause.label} changed at ${causeIso} (${shortSha} ${newestCause.commit.subject}). ` +
+        `Regenerate it: cd ${wsInfo.dir} && npx jest --maxWorkers=2`,
+      `  rule: a report must be newer than the newest commit touching its workspace's tests or the ledger shards`,
+      `  ritual: after ANY ledger edit or master merge, run the regen command in every workspace with T1 claims, then push`,
+    ].join("\n");
+  }
+
+  // R6 test seam, mirroring apps/api/scripts/schema-drift.mjs's SCHEMA_CHECK_PRISMA_CLI shape:
+  // honoured ONLY inside a jest worker that also sets it; anywhere else it is ignored (loudly)
+  // and the real turbo binary is used, so a stray export can never fake a HIT/MISS verdict.
+  function resolvePkgName(gitRoot, wsInfo) {
+    if (gitRoot) {
+      try {
+        const pkgJsonPath = path.join(gitRoot, wsInfo.dir, "package.json");
+        if (fs.existsSync(pkgJsonPath)) {
+          const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
+          if (pkg && typeof pkg.name === "string" && pkg.name) return pkg.name;
+        }
+      } catch {
+        // fall through to the default below
+      }
+    }
+    return `@routeflow/${wsInfo.ws}`;
+  }
+
+  function resolveTurboBin(gitRoot) {
+    if (!gitRoot) return null;
+    const bin = process.platform === "win32" ? "turbo.cmd" : "turbo";
+    const p = path.join(gitRoot, "node_modules", ".bin", bin);
+    return fs.existsSync(p) ? p : null;
+  }
+
+  // Never `npx turbo` — npx can try to download turbo from a bare/throwaway repo with no
+  // node_modules (the fixtures used by this file's own spec). Binary absent => null => the
+  // fail-open branch below.
+  function spawnTurboDryRun(gitRoot, pkg) {
+    const bin = resolveTurboBin(gitRoot);
+    if (!bin) return null;
+    try {
+      const res = spawnSync(bin, ["run", "test", `--filter=${pkg}`, "--dry-run=json"], {
+        cwd: gitRoot,
+        encoding: "utf8",
+        shell: process.platform === "win32",
+      });
+      if (res.status !== 0 || !res.stdout) return null;
+      return res.stdout;
+    } catch {
+      return null;
+    }
+  }
+
+  function turboDryRunStatus(gitRoot, pkg) {
+    const override = process.env.CAMPAIGN_CHECK_TURBO_DRY_RUN;
+    let raw;
+    if (override && process.env.JEST_WORKER_ID) {
+      console.warn("WARNING: CAMPAIGN_CHECK_TURBO_DRY_RUN honoured inside a Jest worker");
+      try {
+        raw = fs.readFileSync(override, "utf8");
+      } catch {
+        return { status: "UNAVAILABLE", pkg };
+      }
+    } else {
+      if (override) {
+        console.log("campaign-check: CAMPAIGN_CHECK_TURBO_DRY_RUN ignored outside a Jest worker");
+      }
+      raw = spawnTurboDryRun(gitRoot, pkg);
+      if (raw === null) return { status: "UNAVAILABLE", pkg };
+    }
+    let parsed;
+    try {
+      parsed = JSON.parse(raw);
+    } catch {
+      return { status: "UNAVAILABLE", pkg };
+    }
+    const task = (parsed.tasks || []).find(
+      (t) => t.package === pkg && typeof t.taskId === "string" && t.taskId.endsWith("#test"),
+    );
+    if (!task || !task.cache || !task.cache.status) return { status: "UNAVAILABLE", pkg };
+    return { status: task.cache.status, pkg };
+  }
+
+  // R1/R2 (full mode) + R4 (--freshness-only). Runs BEFORE any token indexing — a stale
+  // report must never let a claim be discharged (or refused with "no test titled") against
+  // proof the report doesn't actually carry any more.
+  function checkFreshness(mode) {
+    if (!t1Needed) {
+      if (mode === "freshness-only") process.exit(0);
+      return;
+    }
+
+    const gitRoot = resolveGitRoot();
+    let ledgerPathspec = null;
+    if (gitRoot) {
+      const rel = path.relative(gitRoot, statusDir).split(path.sep).join("/");
+      ledgerPathspec = rel || ".";
+    }
+
+    let anyStaleFull = false;
+    let anyHitRefusal = false;
+
+    for (const wsInfo of T1_WORKSPACES) {
+      const exists = fs.existsSync(wsInfo.jsonPath);
+      if (!exists) {
+        if (mode === "freshness-only") {
+          console.log(
+            `campaign-check: ${wsInfo.ws}.json missing — turbo will generate it — continuing`,
+          );
+        }
+        // full mode: leave missing reports to the existing artifact-missing check below.
+        continue;
+      }
+
+      const raw = loadJsonIfExists(wsInfo.jsonPath);
+      if (raw === "PARSE_ERROR") continue; // handled by the existing parse-error check below
+
+      let reportTimeMs;
+      let viaMtime = false;
+      const parsedGeneratedAt =
+        raw && typeof raw.generatedAt === "string" ? Date.parse(raw.generatedAt) : NaN;
+      if (!Number.isNaN(parsedGeneratedAt)) {
+        reportTimeMs = parsedGeneratedAt;
+      } else {
+        reportTimeMs = fs.statSync(wsInfo.jsonPath).mtimeMs;
+        viaMtime = true;
+      }
+
+      const testsCommit = gitRoot ? newestCommit(gitRoot, wsInfo.testPathspecs) : null;
+      const ledgerCommit =
+        gitRoot && ledgerPathspec ? newestCommit(gitRoot, [ledgerPathspec]) : null;
+
+      let newestCause = null;
+      if (testsCommit) newestCause = { label: `${wsInfo.dir} test files`, commit: testsCommit };
+      if (ledgerCommit && (!newestCause || ledgerCommit.ct > newestCause.commit.ct)) {
+        newestCause = { label: "the ledger shards", commit: ledgerCommit };
+      }
+
+      const isStale = newestCause !== null && reportTimeMs < newestCause.commit.ct * 1000;
+
+      if (!isStale) {
+        console.log(
+          `campaign-check: ${wsInfo.ws}.json fresh (generated ${formatGeneratedAt(reportTimeMs, viaMtime)})`,
+        );
+        continue;
+      }
+
+      const block = staleBlock(wsInfo, reportTimeMs, viaMtime, newestCause);
+
+      if (mode === "full") {
+        console.error(block);
+        anyStaleFull = true;
+        continue;
+      }
+
+      // --freshness-only: ask turbo whether replaying this workspace's #test task from
+      // cache would leave the stale report exactly as stale as it is right now.
+      const pkg = resolvePkgName(gitRoot, wsInfo);
+      const dryRun = turboDryRunStatus(gitRoot, pkg);
+      if (dryRun.status === "HIT") {
+        console.error(block);
+        console.error(
+          `  turbo would replay ${dryRun.pkg}#test from cache, so this verify cannot refresh the report`,
+        );
+        anyHitRefusal = true;
+      } else if (dryRun.status === "MISS") {
+        console.log(
+          `campaign-check: ${wsInfo.ws}.json is stale but turbo will regenerate it (cache miss) — continuing`,
+        );
+      } else {
+        console.log(
+          `campaign-check: turbo dry-run unavailable for ${dryRun.pkg} — fail open; the end-of-verify check still enforces freshness`,
+        );
+      }
+    }
+
+    if (mode === "full") {
+      if (anyStaleFull) process.exit(1);
+      return;
+    }
+    // mode === "freshness-only": R4 always exits here, before any token scan.
+    process.exit(anyHitRefusal ? 1 : 0);
+  }
+
+  if (freshnessOnly) {
+    checkFreshness("freshness-only");
+    // checkFreshness always exits in freshness-only mode; unreachable, but explicit for clarity.
+    return;
+  }
+  checkFreshness("full");
+
   let jestIndex = null;
   if (t1Needed) {
     const api = getApiJson();
     const mobile = getMobileJson();
     const pricing = getPricingJson();
     if (api === null && mobile === null && pricing === null) {
+      const regenerateLines = T1_WORKSPACES.map(
+        (w) => `  regenerate: cd ${w.dir} && npx jest --maxWorkers=2`,
+      ).join("\n");
       fail(
         `at least one T1 obligation is claimed, but none of ${apiJsonPath}, ` +
           `${mobileJsonPath} or ${pricingJsonPath} exists — run the JSON-reporter jest ` +
           `passes first (cd apps/api && npx jest --json --outputFile=${apiJsonPath}, ` +
           `cd apps/mobile && npx jest --json --outputFile=${mobileJsonPath}, ` +
-          `cd packages/pricing && npx jest --json --outputFile=${pricingJsonPath})`,
+          `cd packages/pricing && npx jest --json --outputFile=${pricingJsonPath})\n` +
+          regenerateLines,
       );
     } else if (api === "PARSE_ERROR" || mobile === "PARSE_ERROR" || pricing === "PARSE_ERROR") {
       fail(`a jest JSON report exists but failed to parse (api, mobile or pricing) — re-run it`);
```

## WP-3 — verify wiring (`package.json`)

```diff
-    "verify": "node scripts/validate-lock-edges.mjs && ... && node scripts/campaign-check.mjs",
+    "verify": "node scripts/campaign-check.mjs --freshness-only && node scripts/validate-lock-edges.mjs && ... && node scripts/campaign-check.mjs",
```

(full one-liner unchanged apart from the new leading `node scripts/campaign-check.mjs
--freshness-only && `.)

## Gate 1 — the red-gate spec (11/11 green)

```
cd apps/api && npx jest src/common/campaign-check-freshness.spec.ts --runInBand
```

Result (ran twice — once before prettier, once after, to confirm formatting didn't disturb
behavior — both green):

```
PASS src/common/campaign-check-freshness.spec.ts (14.076 s)
  campaign-check freshness guard (spec T1–T11)
    √ T1 (R1,R2) ... (1113 ms)
    √ T2 (R1) ... (1363 ms)
    √ T3 (R1) ... (1546 ms)
    √ T4 (R3) ... (1188 ms)
    √ T5 (R3) ... (1269 ms)
    √ T6 (R4,R6) ... (1334 ms)
    √ T7 (R4) ... (1106 ms)
    √ T8 (R4) ... (1179 ms)
    √ T9 (R6) ... (1169 ms)
    √ T10 (R0) ... (169 ms)
    √ T11 (R5) ... (1 ms)

Test Suites: 1 passed, 1 total
Tests:       11 passed, 11 total
```

No deviations, no gaps against the spec's oracles were needed — all 11 assertions matched the
design on first implementation. No spec-vs-ruling contradiction found (the TP-1 report's one
flagged tension, about T9's `cwd`, was resolved cleanly by the build plan's "turbo binary, not
npx" ruling: with a real binary lookup under `<gitRoot>/node_modules/.bin/`, T9's fixture
(no `node_modules`) genuinely fails open — no seam needed beyond what's specified).

## Gate 2 — tsc

```
cd apps/api && npx tsc -p tsconfig.build.json --noEmit
```

Exit 0, no output.

## Gate 3 — prettier

`npx prettier --write scripts/campaign-check.mjs scripts/jest-campaign-reporter.cjs
package.json apps/api/src/common/campaign-check-freshness.spec.ts` reformatted
`campaign-check.mjs` and the spec file (mostly line-wrapping the new long template-literal
strings); `jest-campaign-reporter.cjs` and `package.json` were already clean.
`npx prettier --check` on the same four files afterward: **"All matched files use Prettier
code style!"**. Re-ran the Gate-1 spec after the reformat to confirm behavior was unchanged —
still 11/11 green (see above, second run).

## Gate 4 — LIVE ORACLE

### 4a. `node scripts/campaign-check.mjs --freshness-only` — BEFORE mobile regen

```
campaign-check: api.json fresh (generated 2026-09-06T17:42:02.741Z)
campaign-check: mobile.json is stale but turbo will regenerate it (cache miss) — continuing
campaign-check: pricing.json fresh (generated 2026-09-06T09:48:44.750Z (file mtime — the report carries no generatedAt; regenerate once to stamp it))
EXIT=0
```

**Deviation from the build-plan's literal acceptance-test expectation** ("must refuse for
`mobile.json` [stale + turbo HIT] with the regen command"): it did NOT refuse — mobile.json
was correctly identified as **stale**, but turbo's real dry-run now reports **MISS**, not the
HIT that `reader.md` recorded at read time. Root cause, confirmed by direct evidence, not
guessed:

- `turbo.json`'s `globalDependencies` includes `package.json` (root) — confirmed by
  `grep -n globalDependencies -A5 turbo.json`.
- WP-3 required editing root `package.json` (`scripts.verify`) — that is a `globalDependencies`
  file, so the edit changes turbo's **global hash component for every task in every
  workspace**, invalidating the local cache entries `reader.md` observed as `HIT` for both
  `@routeflow/api#test` and `@routeflow/mobile#test`.
- Re-ran the raw dry-run directly to confirm: `node_modules/.bin/turbo.cmd run test
--filter=@routeflow/mobile --dry-run=json` → `{"local":false,"remote":false,"status":"MISS",
"timeSaved":0}` — genuinely no matching cache entry, not a stub or code bug.

So the code took the correct branch (`dryRun.status === "MISS"` → "stale but turbo will
regenerate it (cache miss) — continuing", exit 0) for the tree's ACTUAL current state; the
HIT scenario `reader.md` captured no longer reproduces on this tree because completing WP-3
(a required, in-scope edit) itself invalidated it. This is exactly the mechanism the guard is
supposed to track — it is reading real turbo state correctly, not the design that broke. The
HIT→refuse branch itself is independently proven by the spec's T6 (stubbed
`CAMPAIGN_CHECK_TURBO_DRY_RUN`), so the behavior is verified even though this specific live
tree can no longer exhibit a HIT for a `globalDependencies`-invalidated workspace within the
same session that edited `package.json`.

api.json's own `generatedAt` (`2026-09-06T17:42:02.741Z`) is also notable: apps/api's jest
config wires the SAME real campaign reporter for every invocation in that workspace,
including Gate 1's scoped spec run — so running the red-gate spec in apps/api overwrote the
real `.campaign/runs/api.json` with an 11-test partial result (L-034/L-063's exact
failure mode, not a new defect — see Gate 4c).

### 4b. Mobile regen

```
cd apps/mobile && npx jest --maxWorkers=2 2>&1 | tail -5
```

```
PASS __tests__/share-error.test.ts
PASS __tests__/invoices-logic.test.ts
Test Suites: 111 passed, 111 total
Tests:       1398 passed, 1398 total
Time:        31.683 s
```

Re-ran `--freshness-only`:

```
campaign-check: api.json fresh (generated 2026-09-06T17:42:02.741Z)
campaign-check: mobile.json fresh (generated 2026-09-06T17:44:13.639Z)
campaign-check: pricing.json fresh (generated 2026-09-06T09:48:44.750Z (file mtime ...))
EXIT=0
```

`node -e` check on `mobile.json`: `numTotalTests 1398 numPassedTests 1398 generatedAt
2026-09-06T17:44:13.639Z gitHead 597c72dc` — R0's stamp confirmed live on a real reporter
run, not just the spec's in-process check (T10).

### 4c. Full `node scripts/campaign-check.mjs`

Real exit code: **1** (captured separately from `tail`, whose own exit code was misleading in
an earlier interactive check). Output:

- All three freshness lines print `fresh` (0 `STALE` occurrences — `grep -c STALE` = 0):
  the freshness guard itself found nothing stale, confirming R1/R2's logic is sound against
  the live tree.
- 50 `no test titled with REG-B### found in the jest report` failures — **all attributable to
  api.json's 11-test partial content from Gate 1's scoped run** (§4a), not to any bug in
  R0-R6. This is L-063's exact documented failure mode ("apps/api's jest config wires a
  campaign reporter that OVERWRITES `.campaign/runs/api.json` on every invocation (no
  merge)... run apps/api's full suite in one `npx jest --maxWorkers=2` before
  campaign-check").

**I did not run apps/api's full suite to restore api.json** — the task's command allowlist
explicitly permits only "the single spec with `--runInBand`" in apps/api and forbids "a full
Jest suite" except the one scoped mobile regen named for the live oracle. Restoring api.json
requires exactly the forbidden command (`cd apps/api && npx jest --maxWorkers=2`, ~270s per
L-063). This is a self-healing, pre-existing, known condition: the next real `npm run verify`
(or CI) run's own `turbo run ... test ...` step runs apps/api's full suite unsplit before
`campaign-check.mjs` executes, which regenerates api.json correctly — so this is not a
blocker for the actual pipeline, only for re-running the full gate manually inside this
session without exceeding the permitted command set. Flagging rather than working around it.

## Gate 5 — `bugs.mjs self-test` (unchanged script)

```
node scripts/campaign/bugs.mjs self-test
```

```
self-test: all checks passed
EXIT=0
```

## Gate 6 — git status / diff --stat

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
 M package.json                           <- WP-3 (this package)
 M scripts/campaign-check.mjs             <- WP-1/WP-2 (this package)
 M scripts/jest-campaign-reporter.cjs     <- WP-0 (this package)
?? .claude/pipeline/2026-09-06-campaign-check-freshness/
?? apps/api/src/common/campaign-check-freshness.spec.ts   <- TP-1, untouched by this package

$ git diff --stat -- scripts/campaign-check.mjs scripts/jest-campaign-reporter.cjs package.json
 package.json                       |   2 +-
 scripts/campaign-check.mjs         | 275 ++++++++++++++++++++++++++++++++++-
 scripts/jest-campaign-reporter.cjs |  22 +++
 3 files changed, 296 insertions(+), 3 deletions(-)
```

## Deviations summary

1. **Live oracle HIT→MISS** (§4a): WP-3's required `package.json` edit is a turbo
   `globalDependencies` file, so it invalidated the cache entry `reader.md` observed as HIT
   for `@routeflow/mobile#test`, making it a real, current MISS. Code behavior is correct for
   the tree's actual state; the HIT-refuse branch is independently proven by spec T6.
2. **api.json left in a scoped/partial state** (§4c) as an unavoidable consequence of running
   the required Gate-1 spec inside apps/api (L-063), combined with the task's explicit ban on
   running apps/api's full jest suite to restore it. Self-heals on the next real `npm run
verify`/CI pass. The freshness guard itself is not implicated (0 STALE lines; all 50
   failures are pre-existing token-search misses against the now-partial api.json).
3. No test-vs-ruling contradictions found; all 11 spec assertions passed against the first
   implementation without adjustment.
