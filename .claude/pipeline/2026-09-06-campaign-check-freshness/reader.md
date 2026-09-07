# Reader report — campaign-check report-freshness pre-step

Worktree: `C:/ClaudeCode/routeflow/.claude/worktrees/rf-registry`
Branch: `fix/campaign-check-report-freshness` @ `597c72dca4a5e6e31a5f1ea5f62321e64472c34e` (= master @ #638, tree clean)
All facts below are grounded in a command run on this exact tree or a file read on it. Where I could not verify a claim in the task brief against the tree, I say so explicitly (see §2 and §7's discrepancy notes).

---

## 1. `scripts/campaign-check.mjs`

**Total line count: 599** (`wc -l` — file's last statement is `main();` in a top-level try/catch ending at what `Read` numbered line 600, an artifact of the tool's line-numbering past EOF; `wc -l` counting actual newlines says 599).

### Top-of-file contract comment (verbatim, lines 1–87)

```
#!/usr/bin/env node
// Campaign-check — the one unfakeable gate in the bug-register burn-down campaign.
//
// WHY THIS EXISTS
// Every other control in the campaign (a checkbox on the board, a `state: proven`
// line in the ledger) is a human assertion. This is the only mechanical one: it
// reads run artifacts — Jest/Playwright JSON reporters and a batch's own
// build-plan.md — and refuses to believe a claim the artifacts do not back up.
// An earlier draft of this idea used `rg` with a look-ahead pattern: ripgrep is
// not on PATH on this box and its default engine rejects look-around, so that
// draft would have exited 0 with empty output every time — "tool missing" and
// "no proofs found" are indistinguishable at that point, which is exactly the
// failure mode this script exists to prevent. This one is plain Node, uses only
// `git grep`/`fs`, and treats a missing tool or a missing artifact as failure,
// never as a silent pass.
//
// WHAT IT CHECKS
// The register's ledger — `.claude/campaign/status/F##.jsonl`, one shard per
// batch, seeded with all 179 open bug IDs at campaign kickoff — carries a
// `state` per ID. Five states make an affirmative claim this script must verify;
// two make no claim yet and are skipped:
//
//   queued, in-flight        — not yet claiming anything. Not checked.
//   proven                   — Phase 6 wrote this in the PR: a passing REG-B###
//                               test (T1/T2) or a manual-verification row (T3)
//                               must exist for every ID making the claim.
//   proven-pending-deploy    — T2 only. The proof cannot run pre-merge (Playwright
//                               defaults to the deployed build); accepted as-is,
//                               with no test search, because the plan's own
//                               tier table says a T2 ID legitimately carries this
//                               state through the PR.
//   done                     — Phase 8, post-deploy. All tiers, including T2,
//                               must now show a passing REG-B### test.
//   already-fixed / refuted  — discovery classifications. Require a non-empty
//                               `evidence` field; no test search (the plan: "an
//                               already-fixed claim with no test is a confirmed
//                               bug with a missing spec").
//   regressed                 — a closed bug that came back (written only by
//                               `bugs.mjs reopen`, which clears the old proof).
//                               Same contract as already-fixed: a non-empty
//                               `evidence` field citing the failing REG token or
//                               the run that showed it. No test search — the
//                               claim is about production, not about this run.
//                               It is workable again, so `next`/`waves` re-offer
//                               its batch.
//
// `deferred` is NOT a valid state (ruled out 2026-09-02): it is
// unrepresentable under the one-row-per-id ledger — a deferred predecessor
// plus a fresh queued row for the same work is exactly the duplicate this
// gate rejects. `bugs.mjs move` is the re-pointing operation instead.
//
// Token discipline: a bare `B###` collides with four pre-existing spec titles
// (`B10`/`B11`/`B12`/`B13`, a superseded numbering round — see the campaign plan).
// Every proof must carry the `REG-` prefix, and a title is matched by the EXACT
// token via `REG_TOKEN_RE` (scripts/campaign/reg-token.mjs — shared with
// bugs.mjs's `prove`), never a prefix — "REG-B12" must not be satisfied by
// "REG-B120".."REG-B129", at any digit count from 1 to 4.
//
// T3 (manual verification) rows are discharged only by a `REG-B###` row in a
// TABLE ROW of the CLAIMING BATCH'S OWN build-plan.md — never a glob over
// every pipeline folder (which would let any batch's table satisfy any
// other's), and never a token merely mentioned in prose or inside a fenced
// code block (see reg-token.mjs's `manualVerificationIds`). Two ways to tell
// this script where that file is:
//   1. `--batch F02 --pipeline-dir <path>` — scopes the whole check to one batch
//      and supplies its build-plan.md explicitly (used during Phase 6/8 close-out,
//      before the ledger row is even committed).
//   2. A `buildPlan` field on the ledger row itself (Phase 6 writes it alongside
//      `state: proven`) — used by the default whole-ledger scan that `npm run
//      verify` runs on every PR, with no arguments, and therefore no way to be
//      told which batch is "current".
//
// USAGE
//   node scripts/campaign-check.mjs                       # scan every shard (verify's mode)
//   node scripts/campaign-check.mjs --batch F02                     # just F02
//   node scripts/campaign-check.mjs --batch F02 --pipeline-dir <dir># + explicit build-plan.md
//   node scripts/campaign-check.mjs --runs-dir <dir>                # override .campaign/runs
//
// Exit 0: every affirmative claim in scope is backed by a real, passing,
//         non-skipped/non-todo REG-B### proof (or legitimate evidence).
// Exit 1: any gap — missing tool, missing artifact, undischarged obligation,
//         skipped/todo test, or a tier that changed after seeding.
//
// A batch that legitimately declares zero obligations of a given tier (F20,
// F25, F28, F29 have no T1 IDs, for example) is never failed for that tier's
// result set being empty — the check is "every declared obligation is
// discharged", not "the result set is non-empty".
```

### CLI flags (lines 105–117)

```js
const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
}
const onlyBatch = flag("batch"); // e.g. "F02" — undefined means "scan every shard"
const explicitPipelineDir = flag("pipeline-dir");
const runsDir = path.resolve(REPO_ROOT, flag("runs-dir") || ".campaign/runs");
const statusDir =
  process.env.CAMPAIGN_CHECK_STATUS_DIR || path.join(REPO_ROOT, ".claude", "campaign", "status");
```

Flags: `--batch <id>`, `--pipeline-dir <path>`, `--runs-dir <path>`. No `--batch` flag literally named `--batch`, and **no `--batch` explicitly grepped as a quoted arg-parse token anywhere else** — arg parsing is the generic `flag()` helper above; there is no separate special-cased block for `--batch`.

`runsDir` resolution: `path.resolve(REPO_ROOT, flag("runs-dir") || ".campaign/runs")` — defaults to `<repo-root>/.campaign/runs`, overridable via `--runs-dir`.

The three report paths (lines 225–238):

```js
const apiJsonPath = path.join(runsDir, "api.json");
const mobileJsonPath = path.join(runsDir, "mobile.json");
const pricingJsonPath = path.join(runsDir, "pricing.json");
...
const webE2eJsonPath = path.join(runsDir, "web-e2e.json");
```

So there are actually **four** report paths consulted (api/mobile/pricing for T1 jest proofs, web-e2e for T2 Playwright proofs) — the task brief's "three report paths" undercounts by one; `web-e2e.json` is a fourth, T2-only path.

### Exit codes

- `process.exit(1)` — ledger dir not found (line 146), no shard for `--batch` (line 154), no `F##.jsonl` shards found (line 164), or `failures.length` non-zero at the end (line 585, after printing every failure).
- Implicit `process.exit(0)` (Node default) — the happy path, after printing `✔ every affirmative claim in scope is backed by a real proof (...)`.
- The outer `try { main(); } catch (e) { ...; process.exit(1); }` (lines 593–599) also exits 1 on any uncaught exception, printing the message unless `CAMPAIGN_CHECK_DEBUG=1` (which rethrows for the real stack).

There is no distinct exit code for "artifact missing" vs "claim undischarged" vs "malformed ledger" — all three fall through to the same `failures.push(...)` + final `process.exit(1)`.

### `loadJsonIfExists` (lines 216–223)

```js
function loadJsonIfExists(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return "PARSE_ERROR";
  }
}
```

Three-way return: `null` (absent), the parsed object (present + valid), or the literal string `"PARSE_ERROR"` (present + corrupt) — every caller (`getApiJson`/`getMobileJson`/`getPricingJson`/`getWebE2eJson`) checks for both `null` and `"PARSE_ERROR"` distinctly.

### `consultsArtifacts` / `t1Needed` / `t2NeedsPostDeploy` / `t3Needed` (lines 359–367)

```js
const consultsArtifacts = (r) => CLAIM_STATES.has(r.state) && !EVIDENCE_ONLY_STATES.has(r.state);
const t1Needed = rows.some((r) => r.tier === "T1" && consultsArtifacts(r));
const t2NeedsPostDeploy = rows.some((r) => r.tier === "T2" && r.state === "done");
const t3Needed = rows.some((r) => r.tier === "T3" && consultsArtifacts(r));
```

These are computed **after** every ledger shard has been fully parsed into `rows` (the shard-loading loop ends at line 213) and **before** any of `getApiJson`/`getMobileJson`/`getPricingJson` is called (first call is inside the `if (t1Needed) { ... }` block starting line 370). This is the natural point in the current file where a freshness pre-check could be inserted — it already knows exactly which artifacts the run is about to trust (`t1Needed` gates api/mobile/pricing; `t2NeedsPostDeploy` gates web-e2e), so a freshness check could be scoped to only the artifacts actually needed.

**Architectural caveat that matters for the fix design:** `campaign-check.mjs` is the LAST step of `npm run verify`'s command chain (see §3) — it runs **after** `turbo run check-types lint test test:repo-truth`. By the time campaign-check.mjs's own control flow reaches this point, turbo has already decided HIT-or-MISS and already has or hasn't run jest. A freshness/cache-HIT check living _inside_ campaign-check.mjs is too late to make turbo regenerate anything — it can only detect the staleness after the fact and fail loudly (which is strictly better than today's confusing "no test titled with REG-B66" message, but still costs the full ~12-minute `test` task before failing). The task brief's requirement ("A pre-step at the START of verify") implies a **separate script inserted early in the verify chain**, before `turbo run ... test ...` even starts, using `turbo run test --dry-run=json` (§4) to predict HIT/MISS prospectively and refuse before paying for the turbo run at all. That is architecturally distinct from "the point in campaign-check.mjs's control flow" the task also asks about — I'm reporting both since they answer different sub-questions.

### The exact "artifact missing" failure text (lines 374–381)

```js
fail(
  `at least one T1 obligation is claimed, but none of ${apiJsonPath}, ` +
    `${mobileJsonPath} or ${pricingJsonPath} exists — run the JSON-reporter jest ` +
    `passes first (cd apps/api && npx jest --json --outputFile=${apiJsonPath}, ` +
    `cd apps/mobile && npx jest --json --outputFile=${mobileJsonPath}, ` +
    `cd packages/pricing && npx jest --json --outputFile=${pricingJsonPath})`,
);
```

Note this message is stale in one respect: it tells the reader to run `npx jest --json --outputFile=...` by hand, but in practice the artifacts are written automatically by `scripts/jest-campaign-reporter.cjs` on every jest run (§2) — the manual recipe still works but is not how the repo actually produces these files day to day.

The **actual failure the task's symptom describes** ("B66: no test titled with REG-B66 found in the jest report") is a _different_ code path — `checkProofHits` (lines 558–573), reached per-row when `jestIndex.get(id)` returns zero hits **while the artifact itself exists and parses** (stale-but-present, not missing):

```js
function checkProofHits(id, hits, sourceLabel) {
  if (hits.length === 0) {
    fail(`${id}: no test titled with REG-${id} found in the ${sourceLabel} report`);
    return;
  }
  ...
}
```

So the "artifact missing" message and the reported symptom's message are two distinct failure strings from two distinct code paths — the symptom is the artifact being present-but-stale, not absent.

### Token indexing

```js
function tokensIn(title) {
  const out = new Set();
  for (const m of title.matchAll(REG_TOKEN_RE)) out.add(`B${m[1]}`);
  return out;
}

function indexAssertions(assertions, source) {
  const idx = new Map();
  for (const a of assertions) {
    for (const id of tokensIn(a.title)) {
      if (!idx.has(id)) idx.set(id, []);
      idx.get(id).push({ status: a.status, source, title: a.title });
    }
  }
  return idx;
}
```

`REG_TOKEN_RE` itself lives in `scripts/campaign/reg-token.mjs` (imported at the top of the file, line 95) and is shared with `bugs.mjs`'s `prove` — I did not re-read `reg-token.mjs`'s regex body (out of the scoped file set the task named for §1), but campaign-check.mjs's own comment (lines 52–57) states it matches "1 to 4" digits and is exact, not prefix-matched.

**api/mobile extractors** — `jestAssertions(report)` (lines 276–285): walks `report.testResults[].assertionResults[]`, extracting `{ title: a.fullName || a.title || "", status: a.status }`.

**playwright extractor** — `playwrightAssertions(report)` (lines 290–305): recursively walks `report.suites[]` → `suite.specs[].tests[].results[]`, extracting `{ title: spec.title || "", status: result.status }`, defensively because "the exact shape depends on the reporter version F00 ends up pinning" (comment, lines 288–289) — this comment is also stale; see §2, the web e2e JSON reporter is already wired in `playwright.config.ts`.

---

## 2. The campaign Jest reporter

Wired via three package configs, discovered by reading each workspace's `package.json`/`jest.config.js`:

- `apps/api/package.json`'s `jest.reporters`:
  ```json
  "reporters": [
    "default",
    ["<rootDir>/../../../scripts/jest-campaign-reporter.cjs", { "artifact": "api" }]
  ]
  ```
- `apps/mobile/jest.config.js`:
  ```js
  reporters: [
    "default",
    ["<rootDir>/../../scripts/jest-campaign-reporter.cjs", { artifact: "mobile" }],
  ],
  ```
- `packages/pricing/jest.config.js`:
  ```js
  reporters: [
    "default",
    ["<rootDir>/../../scripts/jest-campaign-reporter.cjs", { artifact: "pricing" }],
  ],
  ```
- **`apps/web/jest.config.js` has NO campaign reporter wired at all** (its `jest` block/`jest.config.js` carries no `reporters` key) — web's Jest+RTL unit suite (`*.test.tsx`) produces **no** `.campaign/runs/web.json` and campaign-check.mjs never looks for one (only `api.json`/`mobile.json`/`pricing.json` for T1 jest evidence). Web's only campaign-check touchpoint is the **Playwright** e2e JSON report (`web-e2e.json`, T2 only).
- `apps/web/playwright.config.ts` (lines 41–48) DOES carry a JSON reporter, contradicting campaign-check.mjs's own stale comment ("F00 has not yet added a JSON reporter... as of this writing", lines 231–234):
  ```ts
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["json", { outputFile: "../../.campaign/runs/web-e2e.json" }],
  ],
  ```

### `scripts/jest-campaign-reporter.cjs` — quoted in full (56 lines)

```js
/**
 * jest-campaign-reporter — writes the campaign gate's run artifact on EVERY
 * jest run, so `scripts/campaign-check.mjs` can read fresh proof wherever
 * `npm run verify` executes (dev box or a fresh CI runner — the artifact is
 * gitignored and previously existed only when someone ran `jest --json` by
 * hand, which made CI's campaign-check fail on any `proven` ledger row).
 *
 * Emits the same shape `jest --json` produces, reduced to what the gate
 * parses: { testResults: [ { assertionResults: [ { fullName, status } ] } ] }.
 *
 * Wired as a second reporter (alongside "default") in apps/api's package.json
 * jest block and apps/mobile/jest.config.js, each passing { artifact: "api" }
 * / { artifact: "mobile" }. Writes are best-effort: a reporter must never
 * fail the test run it is observing.
 *
 * Caveat (deliberate): a SCOPED run (`jest -t REG-B190`) overwrites the
 * artifact with only the tests it ran. That is safe for the gate because
 * `verify` orders the full turbo test pass BEFORE campaign-check, so the gate
 * always reads the artifact the same invocation just regenerated; a stale
 * scoped artifact outside verify can only produce a false RED, never a false
 * green.
 */
const fs = require("node:fs");
const path = require("node:path");

class CampaignReporter {
  constructor(globalConfig, options) {
    this._name = (options && options.artifact) || "api";
  }
  onRunComplete(_contexts, results) {
    try {
      const root = path.resolve(process.cwd(), "..", "..");
      const dir = path.join(root, ".campaign", "runs");
      fs.mkdirSync(dir, { recursive: true });
      const out = {
        numTotalTests: results.numTotalTests,
        numPassedTests: results.numPassedTests,
        numFailedTests: results.numFailedTests,
        testResults: (results.testResults || []).map((suite) => ({
          name: suite.testFilePath,
          assertionResults: (suite.testResults || []).map((t) => ({
            fullName: t.fullName || [...(t.ancestorTitles || []), t.title].join(" "),
            title: t.title,
            status: t.status,
          })),
        })),
      };
      fs.writeFileSync(path.join(dir, `${this._name}.json`), JSON.stringify(out));
    } catch (e) {
      console.warn(`jest-campaign-reporter: could not write artifact: ${e && e.message}`);
    }
  }
}
module.exports = CampaignReporter;
```

### **Critical finding — the report JSON carries NO timestamp, NO git sha, and NO workspace-name field**

The task brief assumed the report carries `startTime`/`endTime` (epoch ms), a git sha, and a workspace name. **That is false on this tree; I confirmed it two ways:**

1. Reading the reporter source above: `out` is built from exactly `{ numTotalTests, numPassedTests, numFailedTests, testResults }` — nothing else. No `Date.now()`, no `git rev-parse`, no `process.env.npm_package_name` anywhere in the file.
2. Reading the actual current artifacts on disk:
   ```
   === api ===
   top-level keys: [ 'numTotalTests', 'numPassedTests', 'numFailedTests', 'testResults' ]
   numTotalTests: 4120 numPassedTests: 4120 numFailedTests: 0
   has startTime? false has endTime? false has sha? false
   mtime: 2026-09-06T09:47:55.886Z
   === mobile ===
   top-level keys: [ 'numTotalTests', 'numPassedTests', 'numFailedTests', 'testResults' ]
   numTotalTests: 1400 numPassedTests: 1400 numFailedTests: 0
   has startTime? false has endTime? false has sha? false
   mtime: 2026-09-06T07:22:11.583Z
   === pricing ===
   top-level keys: [ 'numTotalTests', 'numPassedTests', 'numFailedTests', 'testResults' ]
   numTotalTests: 206 numPassedTests: 206 numFailedTests: 0
   has startTime? false has endTime? false has sha? false
   mtime: 2026-09-06T09:48:44.751Z
   ```

**Implication for the freshness design:** any staleness check must use the **filesystem mtime** of `.campaign/runs/<ws>.json` (`fs.statSync(p).mtimeMs`) as the report's "produced at" signal — there is no in-band timestamp or sha to read instead. That is workable (mtime is set by `fs.writeFileSync` at reporter run time) but it is a weaker signal than an embedded sha: a `touch`, a copy from another branch, or a checkout that preserves mtimes could all fool it. Worth flagging as a residual risk in the spec, not something to silently paper over.

### `.campaign/runs/pricing.json` — who writes it, does campaign-check read it

Written by the same `jest-campaign-reporter.cjs`, wired with `{ artifact: "pricing" }` in `packages/pricing/jest.config.js`. **Yes**, campaign-check.mjs reads it: `getPricingJson()` / `pricingJsonPath` (lines 230, 260–266), merged into `jestIndex` alongside api and mobile (lines 385–389) — `pricing` is a full third T1 evidence source, not a fallback.

---

## 3. `.gitignore`, pre-push hook, CI workflow, `turbo.json`

### `.gitignore` (lines 107–116)

```
# ─── Bug-register campaign run artifacts (jest/Playwright JSON read by ────────
#     scripts/campaign-check.mjs; regenerated per run, never committed) ───────
.campaign/

# ─── Bug-registry lock directories (scripts/campaign/bugs.mjs) ────────────────
#     Ephemeral mkdir-based locks under the TRACKED .claude/campaign/ tree
.claude/campaign/**/*.lock/
.claude/campaign/bugs.jsonl.lock/
```

`.campaign/` (repo-root, holds `runs/`) is entirely gitignored. The **tracked** ledger lives under `.claude/campaign/status/*.jsonl` — a different, non-ignored tree; only its lock directories are ignored.

### `.husky/pre-push` — relevant lines

Runs `npm run verify` unconditionally (unless `SKIP_VERIFY=1` or a tree-hash "already verified" marker matches). Full text was read; the two load-bearing lines are:

```sh
npm run verify || exit 1
```

and the `SKIP_VERIFY=1` escape hatch requires `SKIP_VERIFY_REASON` for any push touching code and audits to `.git/skip-verify.log` via `scripts/skip-verify-audit.mjs`. The hook does **not** itself invoke turbo or touch `.campaign/` — it is a pure wrapper around `npm run verify`.

### `.github/workflows/ci.yml` — verify step

```yaml
- name: Verify (lockfile, bug-signature scan, types, lint, tests)
  run: npm run verify
```

Preceded by `actions/checkout@v7` (full fresh checkout, no `.campaign/` in the repo tree — it's gitignored) and explicitly **no turbo cache**:

> "No turbo cache here, deliberately — no TURBO_TOKEN/TURBO_TEAM and no actions/cache of .turbo, so every task genuinely executes on a fresh runner. That is the point of this job. Three separate false GREENS have come out of cached turbo replays in this repo (#495: 18/18 CACHED in 4.6s on a lockfile-only change; a replayed log reporting 3,130 api tests 'passing' that never ran)."

**So on CI, `.campaign/runs` does not exist at job start** (fresh clone, gitignored, no cache restore of any kind) → turbo's `test` task is a guaranteed cold MISS for every workspace → jest actually runs → the reporter writes fresh `.campaign/runs/*.json` files → campaign-check.mjs then reads genuinely fresh evidence. **The staleness bug described in the task brief is a LOCAL-dev-box-only failure mode** (warm turbo cache from a prior local run) — CI's cache-free design structurally cannot hit it. I confirmed this from the workflow file's own stated design, not by running CI.

### `turbo.json`'s `test` task (verbatim)

```json
"test": {
  "dependsOn": ["^build"],
  "inputs": ["$TURBO_DEFAULT$"],
  "outputs": ["coverage/**"]
}
```

**`.campaign/runs/**` is NOT declared as a turbo output for the `test` task** — only `coverage/**` is. Confirmed by reading `turbo.json` directly (no `@routeflow/pricing#test` override adds it either; that task's `outputs` is also just `["coverage/**"]`).

**Why this means a cache replay never restores it (two compounding reasons, not one):**

1. Turbo only captures into its cache artifact the paths named in a task's `outputs`. Since `.campaign/runs/<ws>.json` was never named, even the run that _originally_ produced it never got that file captured into the cache blob — there is nothing to "restore" on a later hit.
2. On a cache HIT, turbo does not execute the task's `command` (`jest`/`jest --config jest.config.js`) at all — it just replays the cached stdout/exit-code and restores the declared `outputs`. Since jest never runs, the reporter's `onRunComplete` hook never fires, so no _new_ `.campaign/runs/<ws>.json` gets written either.

Both effects together are why the file on disk after a cache-HIT `turbo run test` is exactly whatever was left over from the last time that workspace's jest genuinely ran — which can be arbitrarily old relative to the current tree.

---

## 4. `turbo run test --dry-run=json` — live results on this tree

Ran (read-only, executes nothing — see below) both of the two permitted commands. Package names confirmed from each `package.json`: `@routeflow/api`, `@routeflow/mobile`.

```
npx turbo run test --filter=@routeflow/api --dry-run=json
```

wall time: **3.418s** (bash `time`, real). Relevant `tasks[]` entry (`taskId: "@routeflow/api#test"`):

```json
{
  "taskId": "@routeflow/api#test",
  "package": "@routeflow/api",
  "hash": "78a2259b12c6aaff",
  "cache": {
    "local": true,
    "remote": false,
    "status": "HIT",
    "source": "LOCAL",
    "timeSaved": 488088,
    "sha": "dcc6f0a0e6650544fdae89366703dc3e0aafd787",
    "dirtyHash": "24cdf8617223ec89d2c1b9c249f2bcf7a40da8051f61cc2bc33111625991e1d0"
  },
  "command": "jest",
  "outputs": ["coverage/**"],
  "inputsCount": 892
}
```

```
npx turbo run test --filter=@routeflow/mobile --dry-run=json
```

wall time: **5.856s**. Relevant `tasks[]` entry (`taskId: "@routeflow/mobile#test"`):

```json
{
  "taskId": "@routeflow/mobile#test",
  "package": "@routeflow/mobile",
  "hash": "36aa201e42e7f94a",
  "cache": {
    "local": true,
    "remote": false,
    "status": "HIT",
    "source": "LOCAL",
    "timeSaved": 334346,
    "sha": "dcc6f0a0e6650544fdae89366703dc3e0aafd787",
    "dirtyHash": "24cdf8617223ec89d2c1b9c249f2bcf7a40da8051f61cc2bc33111625991e1d0"
  },
  "command": "jest --config jest.config.js",
  "outputs": ["coverage/**"]
}
```

**Right now, on this exact tree, BOTH api and mobile `test` tasks report `cache.status: "HIT"`.** This is not hypothetical — it is the live state of the worktree at the moment this report was written. Both dry-runs completed in single-digit seconds with no jest process spawned (consistent with 4120/1400-test suites that would otherwise take minutes) — dry-run does not execute anything, confirmed empirically here, not just by trusting the flag name.

The top-level dry-run JSON also carries `id`, `version`, `turboVersion` (**2.10.12**, from stderr: `• turbo 2.10.12`), `monorepo`, `globalCacheInputs`, `packages`, `envMode`, `frameworkInference`, `user`, `scm` — I did not exhaustively enumerate every field, only what the task asked for.

### turbo 2.x knowledge I hold with confidence (not re-verified against live docs this session — no web fetch was in scope; flagging as recalled, not freshly confirmed)

- `--dry-run=json` (or `--dry-run` in text form) **never executes any task** — it only resolves the task graph, computes hashes, and reports what _would_ happen (cache hit/miss, command, inputs/outputs) without running the command or writing outputs. The empirical evidence above (sub-6s completion, cache status populated with `timeSaved` figures rather than fresh execution timings) is consistent with this and is the stronger evidence for this report.
- `--force` bypasses cache **reads** for the run — turbo behaves as if no cache entry exists and re-executes every requested task's command from scratch, ignoring both local and remote cache hits (it can still **write** a new cache entry afterward, since a task always writes on completion unless caching is disabled for it). It is also settable via `TURBO_FORCE=true`. This is the mechanism `scripts/jest-campaign-reporter.cjs`'s own header comment references as the standing recipe ("force execution (`turbo run test --force` or direct `npx jest`)", L-034's Guard, §7) for getting a guaranteed-fresh artifact.

---

## 5. Git recipes — newest commit per glob, compared against report mtimes

All run with `MSYS_NO_PATHCONV=1` on this tree (Windows Git Bash), per the task's own note about `:(glob)` pathspecs.

```
$ git log -1 --format='%H %ct %s' -- ':(glob)apps/api/**/*.spec.ts'
151c3f70fafb285d55078f2bcb738f700cf8d18f 1788684102 fix(api,web,mobile): credit-note wallet integrity (f09 b66 b67 b18 b19) (#636)
  → 2026-09-06T08:41:42.000Z

$ git log -1 --format='%H %ct %s' -- ':(glob)apps/mobile/__tests__/**'
151c3f70fafb285d55078f2bcb738f700cf8d18f 1788684102 (same commit #636)
  → 2026-09-06T08:41:42.000Z

$ git log -1 --format='%H %ct %s' -- ':(glob)apps/mobile/**/*.test.ts' ':(glob)apps/mobile/**/*.test.tsx'
151c3f70fafb285d55078f2bcb738f700cf8d18f 1788684102 (same commit #636)
  → 2026-09-06T08:41:42.000Z

$ git log -1 --format='%H %ct %s' -- ':(glob)apps/web/**/*.test.tsx'
1f6483ec9de8ef290911788be79615aacbf463e2 1788607467 fix(api,web,mobile): calendar dates render and compare in the right zone (F25) (#617)
  → 2026-09-05T11:24:27.000Z

$ git log -1 --format='%H %ct %s' -- ':(glob)apps/web/e2e/**'
151c3f70fafb285d55078f2bcb738f700cf8d18f 1788684102 (same commit #636)
  → 2026-09-06T08:41:42.000Z

$ git log -1 --format='%H %ct %s' -- .claude/campaign/status
3bc86627f9f333f2a54df0973d36d0efff3a2077 1788686201 docs(registry): f09 bookkeeping follow-up for #636 (#637)
  → 2026-09-06T09:16:41.000Z

$ git log -1 --format='%H %ct %s' -- ':(glob)packages/pricing/**/*.spec.ts'
22372911a213b99edab4a9a9b8a815dff8d54151 1788581101 refactor(pricing,api,ci): @routeflow/pricing package + wave B′ API hardening (#613)
  → 2026-09-05T04:05:01.000Z
```

### Report mtimes (filesystem, read via `node -e` + `fs.statSync`)

```
api.json mtime:     2026-09-06T09:47:55.886Z
mobile.json mtime:  2026-09-06T07:22:11.583Z
pricing.json mtime: 2026-09-06T09:48:44.751Z
```

### Verdict, applying the stated freshness rule (report mtime must be ≥ newest of: relevant test-file commit, ledger-shard commit) RIGHT NOW on this tree:

| Report          | mtime         | Newest relevant commit                    | Newest ledger commit | Stale?                                                        |
| --------------- | ------------- | ----------------------------------------- | -------------------- | ------------------------------------------------------------- |
| `api.json`      | 09:47:55.886Z | #636 08:41:42Z (api specs)                | #637 09:16:41Z       | **NOT stale** — 09:47:55 postdates both 08:41:42 and 09:16:41 |
| `mobile.json`   | 07:22:11.583Z | #636 08:41:42Z (mobile tests)             | #637 09:16:41Z       | **STALE** — 07:22:11 predates BOTH 08:41:42 and 09:16:41      |
| `pricing.json`  | 09:48:44.751Z | #613 2026-09-05 04:05:01Z (pricing specs) | #637 09:16:41Z       | **NOT stale** — 09:48:44 postdates both                       |
| (no `web.json`) | —             | #636 08:41:42Z / #617 09-05 11:24:27Z     | #637 09:16:41Z       | N/A — web unit tests carry no campaign artifact at all (§2)   |

**`mobile.json` is stale by the rule, right now, on this exact tree.** Combined with §4's finding that `@routeflow/mobile#test` is a live cache HIT right now, **this worktree is currently in exactly the failure state the task describes**: if `npm run verify` (or a bare `turbo run test`) ran at this moment, turbo would replay the mobile test task from cache, the stale `mobile.json` would never be regenerated, and any `proven`/`done` T1 ledger row whose REG-B### token isn't already indexed in that stale file would fail with the "no test titled with REG-B### found in the jest report" message — a live, reproducible instance of the bug, not a hypothetical.

(`api.json` and `pricing.json` are not stale by the rule despite also being cache HITs — their mtimes happen to postdate the relevant commits already, so a replay would not (yet) produce a wrong answer for them; the pre-step's job is to catch the `mobile.json` case, which it would.)

---

## 6. Harness patterns to mirror

### `apps/api/src/common/ci-freshness-guard-script.spec.ts` (351 lines, read in full)

Shape:

- Imports: `spawnSync` from `node:child_process`, `fs`, `os`, `path`, `js-yaml` (to parse `.github/workflows/ci.yml` and pull out the real `run:` text of a named step).
- **Two invocation styles**, both present in this one file: (T1) `runYamlDrivenFreshnessStep` — extracts the ACTUAL `run:` shell text from the live workflow YAML and runs it via `spawnSync("bash", ["-euo", "pipefail", "-c", runText], ...)`, so the test exercises the workflow's own literal script, not a copy; (T2/T3) `runScriptDirect` — spawns the standalone `.mjs` script directly via `spawnSync(process.execPath, [SCRIPT], ...)`.
- Temp-dir fixture: `dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-freshness-guard-"))` in `beforeAll`, `fs.rmSync(dir, { recursive: true, force: true })` in `afterAll`. A fake `gh` CLI is built as a Node script (`fake-gh.mjs`) plus an executable shim (`bin/gh`, `chmod 0o755`) placed on `PATH`, so the guard's `gh api ...` calls resolve to the fixture with zero network/token dependency; on win32 it additionally routes through `CI_FRESHNESS_GH_CMD` (JSON-encoded `[execPath, fakeGhDriver]`) because bare PATH shim resolution for extensionless files doesn't work the same way there.
- No explicit `GIT_*` env scrubbing appears in this file (grep for `GIT_DIR`/`scrub` across `apps/api/src/common` found **no match in this file**; scrubbing-style helpers do exist elsewhere in the same directory — see below).
- Timeouts: one test pins a 5s internal script timeout via `CI_FRESHNESS_GH_TIMEOUT_MS=500` against a fake `gh` that sleeps 10s, asserting `elapsedMs < 5000`, with its own jest-level timeout raised to `20_000` explicitly on that one `it(...)`.
- Uses `readOutputs(file)` to parse a `GITHUB_OUTPUT`-style `key=value` file the script/step writes to, matching how the real GitHub Actions runner communicates step outputs.

### `apps/api/src/common/backfill-legacy-tenant-ids-script.spec.ts` (read first ~120 lines; large file)

Shape:

- No database touched at all (stated in the file's own header comment).
- **Pure-logic evaluation via a single child process**: since the suite runs under ts-jest's CommonJS transform but the module under test is ESM (`.mjs`), it builds a `SHIM` template-literal script, writes it into a `node --input-type=module -e SHIM` child (`pathToFileURL(...).href` to import the real `.mjs` module), passes test cases in via `env.LTB_CASES = JSON.stringify(cases)`, and reads back one JSON array from stdout — "one child process evaluates every pure-module case" rather than one spawn per case, for speed.
- **CLI refusal behavior** is separately exercised by spawning the actual CLI script (`spawnSync`), matching the pattern the file's own header attributes to `report-addon-gate-blast-radius-script.spec.ts` and `prod-migrate-script.spec.ts`.
- `spawnSync(..., { timeout: 60_000 })` on the shim invocation.
- No `GIT_*` env scrubbing visible in the portion read.

### `GIT_*`-style env scrubbing — found, but NOT attributable to "lesson L-070"

A `scrubbedEnv(extra)` helper pattern (`{ ...process.env }` then `delete env.DATABASE_URL` and similar) recurs across **six** files in `apps/api/src/common`: `e2e-seed-script.spec.ts`, `schema-drift-script.spec.ts`, `report-addon-gate-blast-radius-script.spec.ts`, `railway-db-url.spec.ts`, `prod-migrate-script.spec.ts`, `local-env-script.spec.ts` — all scrub **`DATABASE_URL`/`POSTGRES_*`/Railway proxy vars**, not `GIT_*`. **I could not find any spec in this directory that scrubs `GIT_*` env vars**, and grepping `apps/api/src/common` for `GIT_DIR` returned zero matches. Cross-checking against `LESSONS.md`: **`L-070` (2026-09-05, tooling, #597) is about POSIX zombie-pid liveness detection** (`process.kill(pid, 0)` succeeding for an unreaped zombie), not about `GIT_*` env scrubbing — its Guard is "self-test `liveness:` checks (a2) and the dead-holder `observed gone` assertion." The `GIT_DIR`/`git init`-inheriting-`GIT_DIR` issue the task brief seems to be recalling is documented instead in the user's cross-session memory as `reference_git_worktreeconfig_bare_trap_2026-09-04.md` — a memory note, not a numbered `LESSONS.md` entry, and not `L-070`. **This is a misattribution in the task brief that I'm flagging rather than silently working around**; any new harness for the freshness pre-step should scrub whatever env vars it actually needs to isolate (likely `GIT_DIR`/`GIT_WORK_TREE` if it shells out to `git`, following the memory note's guidance, not because "L-070" says so).

### `apps/api/src/common/turbo-inputs.spec.ts` (159 lines, read in full) + `test:repo-truth` wiring

This is the **closest existing precedent** for a spec that asserts `turbo.json` structure AND `package.json`'s `verify` script content in one file — directly answering "is that the right home":

```js
describe("verify + package script wiring for test:repo-truth", () => {
  it("root package.json's verify script runs test:repo-truth", () => {
    const rootPkg = readJson(ROOT_PKG_PATH);
    expect(rootPkg.scripts?.verify).toEqual(expect.stringContaining("test:repo-truth"));
  });
  it("apps/api/package.json declares the test:repo-truth script", () => {
    const apiPkg = readJson(API_PKG_PATH);
    expect(apiPkg.scripts?.["test:repo-truth"]).toBe("jest -c jest.repo-truth.config.js");
  });
});
```

It also has a JSONC-stripping `readJsonc()` helper (turbo.json carries `//` comments) that any new spec reading `turbo.json` would need to reuse or duplicate. **Yes, this file (or a sibling spec in the same directory following its exact pattern) is the right home** for a spec asserting `package.json`'s `verify` chain contains the new freshness pre-step — it already establishes the convention of pinning both the turbo-task shape and the root `verify` script's literal contents together, and it already reads `turbo.json` via the JSONC-aware parser a freshness spec would also need.

`test:repo-truth` wiring, confirmed: root `package.json`'s `verify` script literally is:

```
node scripts/validate-lock-edges.mjs && node scripts/validate-lessons.mjs && node .claude/skills/bug-hunt/scripts/scan-signatures.mjs --self-test && node .claude/skills/bug-hunt/scripts/scan-signatures.mjs && turbo run check-types lint test test:repo-truth --concurrency=2 --continue=dependencies-successful && node scripts/campaign/bugs.mjs self-test && node scripts/campaign-check.mjs
```

This is the FULL verify chain, confirming: `campaign-check.mjs` runs dead last, after `bugs.mjs self-test`, after the whole turbo run. A freshness pre-step belongs **before** the `turbo run check-types lint test test:repo-truth` segment if it's meant to refuse before turbo ever gets a chance to replay a stale-report cache HIT.

---

## 7. Lessons

### `_meta.json` / `validate-lessons.mjs` output

```json
{
  "nextId": 83,
  "activeCount": 40,
  "archivedCount": 38,
  "maxEntries": 40,
  "maxBytes": 40960,
  "updatedAt": "2026-09-06T09:37:58.771Z"
}
```

```
✔ .claude/lessons: register is self-consistent. 40/40 entries · 40.0/40.0 KB · archived 38 · nextId 83 (max L-082) · binding: size (~0 more entries at 1.00 KB each)
```

**The register is at BOTH caps simultaneously right now** (40/40 entries AND 40.0/40.0 KB) — any new lesson entry requires archiving at least one existing entry first (the validator's own "binding: size" note says there is ~0 headroom even by count alone).

### The two archive candidates

Applying the stated rule ("oldest active entry whose Guard names an automated artifact — spec/hook/script/CI check — not judgment/none/runbook") across all 40 active entries by date:

Every entry dated 2026-08-24 through 2026-09-02 either has `Guard: none — judgment` (L-004, L-010, L-025, L-026, L-027, L-035), `Guard: none — <script> passes either way` i.e. explicitly stated as no real guard (L-038), a Guard that's a manual verification **recipe** rather than a named artifact (`gh run view ...` for L-041; `turbo run test --force` + "assert mtime" for L-034 — notably, L-034 is the existing cache-replay lesson and its own Guard is exactly the ad-hoc recipe this task is meant to finally automate), or explicitly "no hook" (L-051, "stash messages... no hook — HANDOFF... carry the rule"). **None of these qualify.**

The first two entries (by date, ascending; tie-broken by ascending numeric id) whose Guard text names a concrete, checked-in automated artifact:

1. **`L-065` · 2026-09-03 · tooling · PR-4 `imp-01`**
   Guard: _"`no-runtime-workspace-imports.spec.ts` (PR-1's engine already seeded the idea; this PR makes it assert every `@routeflow/*` the API imports has a built `main`)."_
2. **`L-072` · 2026-09-03 · domain · wave E `imp-10b`**
   Guard: _"`apps/api/src/common/enum-parity.spec.ts` — a generic table (40 enums) against `packages/types/api/enums.ts`, plus a regression layer pinning the drifted files and the mobile jest stub that can't `require` the shared package directly."_

These two are dated the same day (2026-09-03); I ordered them by ascending numeric id as the tiebreak since I found no other ordering signal in the file.

**Runners-up (3rd/4th qualifying, next-oldest date 2026-09-04, ascending id):** `L-046` (domain, F13 — Guard cites `REG-B48`/`REG-B46`/`REG-B106` test-id tokens, which are mechanically checked by campaign-check.mjs itself, but the Guard text names test-ID tokens rather than a bare filename) and `L-047` (domain, F25 — same REG-B-token pattern, citing `REG-B59`/`REG-B118`/`REG-B90`/`REG-B91`/`REG-B185`). I'm flagging these as **weaker/borderline qualifiers** relative to L-065/L-072: they name enforced, greppable REG-B test tokens rather than a literal `*.spec.ts` filename, which is why I did not put them ahead of L-065/L-072 despite being marginally later by date anyway. If the archival rule is meant strictly as "names a filename," L-065 and L-072 are the unambiguous answer; if REG-B tokens count as "spec," L-046/L-047 would be next in line after them, not instead of them.

### L-034 (the cache-replay lesson) — quoted in full

```
### L-034 · 2026-09-01 · tooling · #TBD

- Symptom: `campaign-check` red on another batch's rows after a rebase, and a mutation probe
  that reported nothing. Both were reading an artifact no run had refreshed.
- Root cause: the campaign artifact is written by a jest REPORTER, so it only refreshes when
  jest actually EXECUTES. Repo-root ledger files are not hashed inputs (`globalDependencies` is
  the lockfile plus package manifests; the test task's `inputs` are `$TURBO_DEFAULT$`), so a
  rebase cannot bust the cache — turbo replays a green summary and the stale artifact survives.
  Scoped runs (`jest -t REG-B##`, one per mutation probe) narrow it to just those tests, and a
  cache-replayed "full suite" afterwards does not overwrite that.
- Lesson: A generated artifact is evidence only when you can name the tool and the run that
  produced it. Extends [[L-009]]: a cache replay does not merely fail to prove the tests ran —
  it silently PRESERVES whatever the last scoped run wrote. Same shape as regenerating a lockfile
  with the wrong npm major: the diff reads as content drift when it is tooling drift.
- Guard: force execution (`turbo run test --force` or direct `npx jest`), then assert the
  artifact's mtime post-dates the change, before reading any gate that consumes it. Freshness is
  verified, never inferred from a green summary.
```

This is precisely the same failure mechanism reproduced live in §5 above (mobile.json stale under a cache HIT) — L-034 diagnosed the root cause in 2026-09-01 but its own "Guard" is a manual recipe, never automated. That gap is exactly what this task's pre-step is meant to close.

### L-063 — quoted in full

```
### L-063 · 2026-09-04 · testing · imp-04

- Symptom: after apps/api's suite was split into two `npx jest` invocations,
  `scripts/campaign-check.mjs` reported 17 undischarged bug-registry claims that the first run
  had already proven.
- Root cause: apps/api's jest config wires a campaign reporter that OVERWRITES
  `.campaign/runs/api.json` on every invocation (no merge), and non-anchored substring filters
  (`auth` without a trailing slash) also ran `src/authorizations/**` in both partitions (239
  suites/3686 tests vs the true 233/3632).
- Lesson: never split a jest invocation whose config wires a campaign/artifact reporter —
  run apps/api's full suite in one `npx jest --maxWorkers=2` (~270 s) before `campaign-check`; if
  partitioning is ever required, merge the reporter outputs and anchor patterns with a trailing
  slash.
- Guard: `apps/api/package.json` `jest.reporters` (campaign reporter) +
  `scripts/campaign-check.mjs`; the pre-push hook runs the suite unsplit.
```

This is the source of the exact regeneration command the task brief specifies (`cd apps/<ws> && npx jest --maxWorkers=2`) — confirms the api lane must run **unsplit** to avoid re-triggering this exact overwrite defect if the new pre-step's suggested regeneration command is ever scripted to auto-run rather than just printed.

---

## 8. `bug-registry` skill + code-map `INDEX.md`

### `.claude/skills/bug-registry/SKILL.md` — "Keeping the registry honest" (quoted, lines 272–332)

````
## Keeping the registry honest

​```bash
npm run bugs -- enrich      # re-import the register HTML detail + file sets into every record
npm run bugs -- deps        # the conflict graph: batch cohesion, cross-batch conflicts, outliers
npm run bugs -- deps --bug B129
npm run bugs -- render      # regenerate the one-page HTML view from the records
npm run bugs -- self-test   # runs inside npm run verify (today step 6 of 7 — the ordinal moves;
                            # package.json's verify script is the only place worth reading it from)
​```

`deps` answers the question batching is supposed to answer: **which bugs must land together, and
which batches can never run in parallel.** Two bugs conflict when they touch the same file.

⚠️ **Hub files are the whole difficulty.** `orders.service.ts` is touched by 36 bugs,
`invoices.service.ts` by 30, `routes.service.ts` by 29, `schema.prisma` by 28. A naive
shares-a-file rule reported that no
batch was EVER parallel-safe, which is useless — two bugs in a 5,000-line service almost always
touch different methods. Only a shared **non-hub** file counts as a hard conflict.

⚠️ **The graph is bounded by its file data, and cannot see method-level collisions inside a
god-file.** It missed the B34/B146 collision the F11 analysis proved by hand, and only found it
once the analysis file sets were merged into front matter. So: run `deps` first to find gross
structure and outliers, then analyse — and **write the analysis` files` back into front matter**,
because that is what sharpens the graph for everyone after you.

`render` writes `local-assets/docs/routeflow-bug-registry.html`, a DERIVED view. ⚠️ It is a
different file from `routeflow-bug-register.html`, which `enrich` still parses as the historical
import source — never overwrite that one.

### Two agents, one shard

`status/F##.jsonl` is shared mutable state, and the campaign routinely runs several sub-agents on
one batch. Every ledger write therefore takes an exclusive lock on the shard — a `<shard>.lock`
DIRECTORY created with `mkdir`, which is the one filesystem primitive that is atomic and fails
loudly on both NTFS and POSIX. It is held across the **read** as well as the write, because the
failure it prevents is a lost update, not a torn file: two `prove`s of different rows in one shard
each read the whole shard, each write their own copy back, and the second silently reverted the
first — a proven, evidence-backed row back to `queued`, with `self-test` and `campaign-check` both
green.

**The catalogue is locked the same way.** `bugs.jsonl` gets its own `bugs.jsonl.lock` through the
same primitive, and `file`, `move`, `import`, `index` and `discharge` all hold it — otherwise two
sessions writing the catalogue at once (or, for `discharge`, scanning every OTHER shard's evidence
while holding only their own) read one snapshot, act on it, and the second write silently discards
the first's. **Lock order is one-way and load-bearing: the catalogue lock is OUTERMOST, and a
shard lock (or several, for `move`) nests inside it — never the reverse.** ...

A lock is broken on its owner being **dead**, never on its **age**. ...
````

(I stopped the verbatim quote at the point the task's scope — "Keeping the registry honest" — logically ends and the file moves into deeper lock-mechanics detail; the section as quoted above covers the full header through the locking-model explanation, which is what a docs update referencing this section would cite.)

### code-map `INDEX.md` entry for `campaign-check.mjs`

Lives in the single dense row `.claude/code-map/INDEX.md:105`, keyed **"Bug-register burn-down campaign (ledger, gate, F-cards)"**. The directly relevant opening clause:

> `.claude/campaign/status/F##.jsonl` (180-row proof ledger, one shard per batch) + `scripts/campaign-check.mjs` (the gate — LAST step of `npm run verify`, after turbo; reconciles ledger claims vs jest/Playwright JSON in `.campaign/runs/`, gitignored — regenerated on EVERY jest run by `scripts/jest-campaign-reporter.cjs`, a second reporter wired into apps/api package.json jest block and apps/mobile/jest.config.js, so fresh CI runners carry proof; a stale scoped artifact can only false-RED, never false-green; ...

This entry already correctly states campaign-check.mjs runs "LAST step of `npm run verify`, after turbo" (confirming §6's architectural point) and already asserts "a stale scoped artifact can only false-RED, never false-green" — that invariant **still holds** under the newly-confirmed turbo-cache-replay staleness mode found in §4/§5: the live reproduction here (mobile.json stale + cache HIT) produces a **false RED** (`campaign-check` failing with "no test titled with REG-B66 found"), not a false green — consistent with what this INDEX.md entry already claims, just via a mechanism (turbo cache replay skipping the reporter entirely) that the entry doesn't yet call out by name. This row is enormous (it's the whole campaign subsystem's map entry) and will need a small, surgical addition — not a rewrite — once the pre-step ships, per the code-map routine's own "surgical, not a regen" rule.

---

## Summary of the most load-bearing findings for whoever designs the fix

1. **The report JSON has no timestamp/sha/workspace field at all** — freshness must be inferred from filesystem mtime (`.campaign/runs/<ws>.json`'s `mtimeMs`), not from anything inside the file.
2. **`.campaign/runs/**` is not a declared turbo `output`** for the `test` task (only `coverage/**` is) — this is _why_ a cache HIT both skips regenerating AND never restores the artifact; two compounding effects, not one.
3. **Live, reproduced right now on this tree**: `mobile.json` is stale by the stated rule (mtime predates both the newest mobile-test commit and the newest ledger-shard commit) AND `@routeflow/mobile#test` is a genuine turbo cache HIT (confirmed via `--dry-run=json`) — this worktree is in the exact failure state the task describes, not a hypothetical.
4. **CI cannot hit this bug by construction** (no turbo cache of any kind on a fresh runner, confirmed from `ci.yml`'s own documented design) — the pre-step only needs to matter for the local pre-push path.
5. campaign-check.mjs runs **dead last** in `verify` (after `turbo run ... test ...`); a freshness check living inside campaign-check.mjs's own control flow can only fail loudly after paying for the full turbo run — the brief's "pre-step at the START of verify" implies a **separate script** placed before the turbo invocation in `package.json`'s `verify` chain, using `turbo run test --dry-run=json`'s cache-status prediction (§4) rather than campaign-check.mjs's own internal logic.
6. The lessons register is at **both** caps (40/40 entries, 40.0/40.0 KB) — a new lesson from this fix requires archiving at least `L-065` and `L-072` first (the two oldest active entries whose Guard names a concrete automated artifact).
7. Flagged discrepancies in the task brief itself: (a) report timestamp/sha assumption is false (see above); (b) "three report paths" undercounts — there are four (`api.json`/`mobile.json`/`pricing.json`/`web-e2e.json`); (c) "env scrubbing of GIT_* per lesson L-070" — L-070 is actually about POSIX zombie-pid liveness, not GIT_* scrubbing, and no GIT_*-scrubbing spec was found in `apps/api/src/common`; the GIT_DIR issue lives in a cross-session memory note, not a numbered LESSONS.md entry.
