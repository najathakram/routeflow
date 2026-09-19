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
//
// B523 (2026-09-18): "missing report" vs "report checked, no matching test" must never render
// the same. Root cause was turbo's shared-worktree local cache replaying a HIT for a workspace's
// #test task without ever invoking jest — a cache replay restores only declared `outputs`
// (coverage/**), never the campaign artifact (deliberately not one, so it always reflects a REAL
// run — see jest-campaign-reporter.cjs). That left apps/mobile's report entirely missing while
// api/pricing/web's were fresh, and the T1 index-building step here treated the missing report
// as contributing zero hits — indistinguishable from "checked, nothing there" — so 30 legitimate
// REG-B### tests under apps/mobile read as undischarged. Two guards now close this: (1)
// `--freshness-only` asks turbo's dry-run about a MISSING report too, not just a stale one, and
// refuses if turbo would replay a HIT (see checkFreshness); (2) full mode, if some but not all of
// api/mobile/pricing/web are present, fails loudly and by name for each missing/unparseable one
// and leaves jestIndex null — never silently merges a missing workspace's absence into "no hits".

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeEvidence } from "./campaign/normalize-evidence.mjs";
import { decideScope, shortName } from "./lib/verify-scope.mjs";
import {
  REG_TOKEN_RE,
  BUG_ID_RE,
  manualVerificationIds as manualVerificationIdsFromText,
} from "./campaign/reg-token.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function main() {
  // ---- CLI ----
  const args = process.argv.slice(2);
  function flag(name) {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
  }
  const onlyBatch = flag("batch"); // e.g. "F02" — undefined means "scan every shard"
  const explicitPipelineDir = flag("pipeline-dir");
  const runsDir = path.resolve(REPO_ROOT, flag("runs-dir") || ".campaign/runs");
  // --freshness-only: R4's pre-step. Boolean, no value — checked by presence, not flag().
  const freshnessOnly = args.includes("--freshness-only");
  // Overridable via CAMPAIGN_CHECK_STATUS_DIR (mirrors bugs.mjs's BUGS_ROOT
  // seam) so a self-test can drive this REAL command against a throwaway
  // fixture ledger instead of the repo's own .claude/campaign/status.
  const statusDir =
    process.env.CAMPAIGN_CHECK_STATUS_DIR || path.join(REPO_ROOT, ".claude", "campaign", "status");

  const CLAIM_STATES = new Set([
    "proven",
    "proven-pending-deploy",
    "done",
    "already-fixed",
    "refuted",
    "regressed",
  ]);
  // States discharged by their `evidence` field alone — they never consult a run
  // artifact, and must not force one to exist. `regressed` is here for the same
  // reason `already-fixed` is: it asserts something about production that no test
  // in THIS run can show, so the assertion has to carry its own citation.
  const EVIDENCE_ONLY_STATES = new Set(["already-fixed", "refuted", "regressed"]);
  const VALID_STATES = new Set([...CLAIM_STATES, "queued", "in-flight"]);
  const VALID_TIERS = new Set(["T1", "T2", "T3"]);

  function fail(msg) {
    failures.push(msg);
  }

  const failures = [];
  const passes = [];
  const skippedNoObligation = [];

  // ---- load ledger shard(s) ----
  if (!fs.existsSync(statusDir)) {
    console.error(`✖ campaign-check: ledger directory not found: ${statusDir}`);
    process.exit(1);
  }

  let shardFiles;
  if (onlyBatch) {
    const p = path.join(statusDir, `${onlyBatch}.jsonl`);
    if (!fs.existsSync(p)) {
      console.error(`✖ campaign-check: no ledger shard for batch ${onlyBatch} at ${p}`);
      process.exit(1);
    }
    shardFiles = [p];
  } else {
    shardFiles = fs
      .readdirSync(statusDir)
      .filter((f) => /^F\d{2}\.jsonl$/.test(f))
      .map((f) => path.join(statusDir, f));
    if (shardFiles.length === 0) {
      console.error(`✖ campaign-check: no F##.jsonl shards found in ${statusDir}`);
      process.exit(1);
    }
  }

  const rows = [];
  const seenIds = new Map(); // id -> shard file, to catch duplicates across shards
  for (const file of shardFiles) {
    const batch = path.basename(file, ".jsonl");
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      let row;
      try {
        row = JSON.parse(line);
      } catch (e) {
        fail(`${batch}: malformed JSONL line: ${line.slice(0, 80)}...`);
        continue;
      }
      if (!row.id || !BUG_ID_RE.test(row.id)) {
        fail(`${batch}: row missing a valid "id": ${line}`);
        continue;
      }
      if (row.batch !== batch) {
        fail(`${batch}: row ${row.id} declares batch "${row.batch}", expected "${batch}"`);
      }
      if (!VALID_TIERS.has(row.tier)) {
        fail(`${batch}: ${row.id} has invalid tier "${row.tier}" (expected T1/T2/T3)`);
      }
      if (!VALID_STATES.has(row.state)) {
        fail(`${batch}: ${row.id} has invalid state "${row.state}"`);
      }
      if (row.tier === "T3" && (row.state === "proven" || row.state === "done")) {
        // enforced below once we know whether Critical/High — severity isn't on
        // the ledger row itself (kept out deliberately: severity lives in the
        // register, tier is what the gate cares about), so this is a soft check
        // the F-card/seed step must get right; campaign-check cannot re-derive
        // severity without re-reading the 533KB register, which the whole
        // campaign is built to avoid doing per-batch.
      }
      if (seenIds.has(row.id)) {
        fail(
          `duplicate ID ${row.id} in both ${seenIds.get(row.id)} and ${batch} — ` +
            `a bug ID must appear in exactly one shard`,
        );
      } else {
        seenIds.set(row.id, batch);
      }
      rows.push({ ...row, _shard: batch });
    }
  }

  // ---- load run artifacts (lazily, only if something needs them) ----
  function loadJsonIfExists(p) {
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return "PARSE_ERROR";
    }
  }

  const apiJsonPath = path.join(runsDir, "api.json");
  const mobileJsonPath = path.join(runsDir, "mobile.json");
  // packages/pricing owns the money math (and its REG-B### regressions) since the
  // three mirrors were folded into @routeflow/pricing — so it is a third jest
  // proof source alongside api and mobile.
  const pricingJsonPath = path.join(runsDir, "pricing.json");
  // apps/web's jest unit-test proof source (REG-B### specs under app/components/lib/hooks,
  // e.g. lib/api/*.test.tsx) — wired via jest-campaign-reporter.cjs's { artifact: "web" } in
  // apps/web/jest.config.js, alongside api/mobile/pricing. Deliberately named "web.json", not
  // "web-e2e.json" — that name is reserved for the Playwright report below and must never
  // collide with this jest one.
  const webJsonPath = path.join(runsDir, "web.json");
  // Provisional name — F00 has not yet added a JSON reporter to
  // apps/web/playwright.config.ts (verified: reporter: [["list"], ["html", ...]]
  // only, no JSON entry, as of this writing). Once it does, this is where its
  // output should land.
  // NOTE: `npm run local:e2e`/`local:e2e:all` (apps/web/e2e/LOCAL-LANE.md) write
  // `.campaign/runs/web-e2e-local.json` instead (PLAYWRIGHT_JSON_OUTPUT_NAME) — that
  // file is NEVER read here or anywhere else; only web-e2e.json above is campaign evidence.
  const webE2eJsonPath = path.join(runsDir, "web-e2e.json");

  let apiJson, mobileJson, pricingJson, webJson, webE2eJson;
  let apiJsonLoaded = false,
    mobileJsonLoaded = false,
    pricingJsonLoaded = false,
    webJsonLoaded = false,
    webE2eJsonLoaded = false;

  function getApiJson() {
    if (!apiJsonLoaded) {
      apiJson = loadJsonIfExists(apiJsonPath);
      apiJsonLoaded = true;
    }
    return apiJson;
  }
  function getMobileJson() {
    if (!mobileJsonLoaded) {
      mobileJson = loadJsonIfExists(mobileJsonPath);
      mobileJsonLoaded = true;
    }
    return mobileJson;
  }
  function getPricingJson() {
    if (!pricingJsonLoaded) {
      pricingJson = loadJsonIfExists(pricingJsonPath);
      pricingJsonLoaded = true;
    }
    return pricingJson;
  }
  function getWebJson() {
    if (!webJsonLoaded) {
      webJson = loadJsonIfExists(webJsonPath);
      webJsonLoaded = true;
    }
    return webJson;
  }
  function getWebE2eJson() {
    if (!webE2eJsonLoaded) {
      webE2eJson = loadJsonIfExists(webE2eJsonPath);
      webE2eJsonLoaded = true;
    }
    return webE2eJson;
  }

  // ---- extract (title, status) pairs from a Jest --json report ----
  function jestAssertions(report) {
    if (!report || report === "PARSE_ERROR") return [];
    const out = [];
    for (const suite of report.testResults || []) {
      for (const a of suite.assertionResults || []) {
        out.push({ title: a.fullName || a.title || "", status: a.status });
      }
    }
    return out;
  }

  // ---- extract (title, status) pairs from a Playwright JSON report ----
  // Playwright's json reporter nests suites recursively; walk defensively since
  // the exact shape depends on the reporter version F00 ends up pinning.
  function playwrightAssertions(report) {
    if (!report || report === "PARSE_ERROR") return [];
    const out = [];
    function walkSuite(suite) {
      for (const spec of suite.specs || []) {
        for (const test of spec.tests || []) {
          for (const result of test.results || []) {
            out.push({ title: spec.title || "", status: result.status });
          }
        }
      }
      for (const sub of suite.suites || []) walkSuite(sub);
    }
    for (const s of report.suites || []) walkSuite(s);
    return out;
  }

  function tokensIn(title) {
    const out = new Set();
    for (const m of title.matchAll(REG_TOKEN_RE)) out.add(`B${m[1]}`);
    return out;
  }

  // index: id -> array of {status, source, title}
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

  function mergeIndexes(...idxs) {
    const merged = new Map();
    for (const idx of idxs) {
      for (const [id, hits] of idx) {
        if (!merged.has(id)) merged.set(id, []);
        merged.get(id).push(...hits);
      }
    }
    return merged;
  }

  // ---- T3: manual-verification rows in a build-plan.md ----
  // A REG-B### token counts ONLY inside a table row (a line matching /^\s*\|/)
  // of the "## Manual verification" section, after stripping fenced code
  // blocks — see scripts/campaign/reg-token.mjs, which bugs.mjs's `prove`
  // reads too, so the two sides cannot drift the way they used to (prove
  // accepted any digit count; this file required exactly 2-3, so a
  // single-digit id could be proven but never discharged).
  function manualVerificationIds(buildPlanPath) {
    if (!buildPlanPath || !fs.existsSync(buildPlanPath)) return null; // artifact missing
    const text = fs.readFileSync(buildPlanPath, "utf8");
    return manualVerificationIdsFromText(text);
  }

  // Cache one manualVerificationIds() result per resolved build-plan path so a
  // batch with many T3 rows doesn't re-read the file per row.
  const manualCache = new Map();
  function manualIdsFor(buildPlanPath) {
    if (!manualCache.has(buildPlanPath)) {
      manualCache.set(buildPlanPath, manualVerificationIds(buildPlanPath));
    }
    return manualCache.get(buildPlanPath);
  }

  // ---- the actual check, per row ----
  // "already-fixed"/"refuted" rows are discharged by their evidence field alone and
  // never consult a run artifact — so they must not force one to exist. Everything
  // else that claims (proven, done, and any anomalous tier/state combo) still does,
  // so a mis-tiered row can never silently skip the artifact requirement.
  const consultsArtifacts = (r) => CLAIM_STATES.has(r.state) && !EVIDENCE_ONLY_STATES.has(r.state);
  const t1Needed = rows.some((r) => r.tier === "T1" && consultsArtifacts(r));
  const t2NeedsPostDeploy = rows.some((r) => r.tier === "T2" && r.state === "done");
  const t3Needed = rows.some((r) => r.tier === "T3" && consultsArtifacts(r));

  // ---- R1-R4: report freshness (a turbo cache HIT can leave a stale .campaign/runs/*.json
  // on disk — L-034 — so both the full scan and the `--freshness-only` pre-step must refuse
  // to trust a report older than the newest commit touching its own tests or the ledger). ----
  const T1_WORKSPACES = [
    {
      ws: "api",
      dir: "apps/api",
      jsonPath: apiJsonPath,
      testPathspecs: [":(glob)apps/api/**/*.spec.ts"],
    },
    {
      ws: "mobile",
      dir: "apps/mobile",
      jsonPath: mobileJsonPath,
      testPathspecs: [
        ":(glob)apps/mobile/__tests__/**",
        ":(glob)apps/mobile/**/*.test.ts",
        ":(glob)apps/mobile/**/*.test.tsx",
        // The scan gate/engine the mobile REG-B190/B191/B192/B202 tests prove now lives in
        // @routeflow/scanning; edits there must still invalidate a stale mobile.json.
        ":(glob)packages/scanning/**",
      ],
    },
    {
      ws: "pricing",
      dir: "packages/pricing",
      jsonPath: pricingJsonPath,
      testPathspecs: [":(glob)packages/pricing/**/*.spec.ts"],
    },
    {
      ws: "web",
      dir: "apps/web",
      jsonPath: webJsonPath,
      testPathspecs: [":(glob)apps/web/**/*.test.ts", ":(glob)apps/web/**/*.test.tsx"],
    },
  ];

  // B523 fix-round 2: every OTHER campaign script (bugs.mjs, plane-client.mjs, this file's own
  // spec) scrubs GIT_* env vars before spawning git, because git EXPORTS repo-scoped variables
  // (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_COMMON_DIR, …) into every child process of a
  // hook — and this script's pre-push invocation is a hook. This file's own `git` spawns never
  // scrubbed them, so `git log`/`rev-parse` here could silently resolve against whatever
  // repo/index husky's ambient env pointed at instead of `statusDir`/`gitRoot` — observed live: a
  // push attributed "the ledger shards changed" to the commit BEING PUSHED itself (never true;
  // confirmed by re-running the identical `git log` immediately after outside the hook and
  // getting the correct, older commit both times). Scrubbing this closes that class the same way
  // B420 closed it for validate-code-map.stamp.self-test.mjs.
  function scrubGitEnv(extra = {}) {
    const env = { ...process.env };
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_COMMON_DIR",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_QUARANTINE_PATH",
      "GIT_PREFIX",
      "GIT_NAMESPACE",
      "GIT_CEILING_DIRECTORIES",
    ]) {
      delete env[key];
    }
    return { ...env, ...extra };
  }

  // Git root for freshness lookups is derived from statusDir, not REPO_ROOT — REPO_ROOT is
  // this SCRIPT's own on-disk location (always the real monorepo), while statusDir may be a
  // throwaway fixture repo (CAMPAIGN_CHECK_STATUS_DIR); its commits are what freshness must
  // be judged against. Resolved once, memoized.
  let gitRootCache;
  function resolveGitRoot() {
    if (gitRootCache !== undefined) return gitRootCache;
    try {
      const res = spawnSync("git", ["-C", statusDir, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        shell: false,
        env: scrubGitEnv(),
      });
      gitRootCache = res.status === 0 && res.stdout ? res.stdout.trim() : null;
    } catch {
      gitRootCache = null;
    }
    return gitRootCache;
  }

  // newestCommit(gitRoot, pathspecs) -> { sha, ct, subject } for the newest commit touching
  // any of `pathspecs`, or null when no commit touches them (imposes no bound — R1).
  //
  // F1: `--first-parent` is required. `git log -- <path>`'s default history simplification
  // prunes a merge commit that is TREESAME to one of its parents for the given path and
  // silently follows only that parent instead — a `git merge origin/master` on a branch that
  // did not itself touch the path is TREESAME to the incoming (non-first) side, so plain
  // `git log -1 -- <path>` reports the ORIGINAL upstream commit's %ct, not the merge's own —
  // exactly the population of refusals this freshness rule exists to catch (see T15). With
  // `--first-parent`, log only ever walks the branch's own line, so the merge itself is the
  // commit reported whenever it changed the path relative to its first parent; it is a no-op
  // on linear (non-merge) history, which is every other fixture in this file.
  function newestCommit(gitRoot, pathspecs) {
    try {
      const res = spawnSync(
        "git",
        ["log", "-1", "--first-parent", "--format=%H%x1f%ct%x1f%s", "--", ...pathspecs],
        {
          cwd: gitRoot,
          encoding: "utf8",
          shell: false,
          env: scrubGitEnv(),
        },
      );
      if (res.status !== 0 || !res.stdout || !res.stdout.trim()) return null;
      const [sha, ctStr, subject] = res.stdout.trim().split("\x1f");
      return { sha, ct: Number(ctStr), subject };
    } catch {
      return null;
    }
  }

  // F3: a commit whose committer date is ahead of THIS machine's clock (a fast dev-box clock, a
  // hand-set GIT_COMMITTER_DATE, a rewrite that lost --committer-date-is-author-date) must never
  // hard-block every future report forever — a freshly regenerated report can never be "newer"
  // than a moment that has not happened yet, so the refusal would repeat after every
  // regeneration with no recoverable action. Clamp the bound to now before it is compared, and
  // say so once per offending commit (skewNoted dedupes across this call's per-workspace loop,
  // since the same ledger commit is re-fetched for every consulted workspace).
  function clampCommitToNow(commit, skewNoted) {
    if (!commit) return commit;
    const nowMs = Date.now();
    const rawMs = commit.ct * 1000;
    if (rawMs <= nowMs) return commit;
    if (!skewNoted.has(commit.sha)) {
      skewNoted.add(commit.sha);
      console.log(
        `campaign-check: note — commit ${commit.sha.slice(0, 7)} is dated in the future ` +
          `(${new Date(rawMs).toISOString()}); clock skew? treating it as now`,
      );
    }
    return { ...commit, ct: Math.floor(nowMs / 1000) };
  }

  function formatGeneratedAt(reportTimeMs, viaMtime) {
    const isoStr = new Date(reportTimeMs).toISOString();
    return viaMtime
      ? `${isoStr} (file mtime — the report carries no generatedAt; regenerate once to stamp it)`
      : isoStr;
  }

  function staleBlock(wsInfo, reportTimeMs, viaMtime, newestCause) {
    const causeIso = new Date(newestCause.commit.ct * 1000).toISOString();
    const shortSha = newestCause.commit.sha.slice(0, 7);
    return [
      `campaign-check: ${wsInfo.jsonPath} is STALE — generated ${formatGeneratedAt(reportTimeMs, viaMtime)} ` +
        `but ${newestCause.label} changed at ${causeIso} (${shortSha} ${newestCause.commit.subject}). ` +
        `Regenerate it: cd ${wsInfo.dir} && npx jest --maxWorkers=2`,
      `  rule: a report must be newer than the newest commit touching its workspace's tests or the ledger shards`,
      `  ritual: after ANY ledger edit or master merge, run the regen command in every workspace with T1 claims, then push`,
    ].join("\n");
  }

  // R9: a scoped jest run (a test path or name pattern) can leave a report that is FRESH by
  // time but still not real full-suite evidence — the reporter stamps `partial: true` for
  // exactly this case (L-063's twin: the gate's own scoped spec run overwrote api.json with an
  // 11-test partial result — see wp-report.md §Gate 4a/4c). Same rule/ritual lines as staleBlock
  // by design (R9: "plus the rule:/ritual: lines").
  function partialBlock(wsInfo, patterns) {
    const patternsStr =
      patterns && patterns.length ? patterns.join(", ") : "(no patterns recorded)";
    return [
      `campaign-check: ${wsInfo.jsonPath} is PARTIAL — a scoped jest run wrote it (${patternsStr}); ` +
        `regenerate with the full suite: cd ${wsInfo.dir} && npx jest --maxWorkers=2`,
      `  rule: a report must be newer than the newest commit touching its workspace's tests or the ledger shards`,
      `  ritual: after ANY ledger edit or master merge, run the regen command in every workspace with T1 claims, then push`,
    ].join("\n");
  }

  // R6 test seam, mirroring apps/api/scripts/schema-drift.mjs's SCHEMA_CHECK_PRISMA_CLI shape:
  // honoured ONLY inside a jest worker that also sets it; anywhere else it is ignored (loudly)
  // and the real turbo binary is used, so a stray export can never fake a HIT/MISS verdict.
  function resolvePkgName(gitRoot, wsInfo) {
    if (gitRoot) {
      try {
        const pkgJsonPath = path.join(gitRoot, wsInfo.dir, "package.json");
        if (fs.existsSync(pkgJsonPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
          if (pkg && typeof pkg.name === "string" && pkg.name) return pkg.name;
        }
      } catch {
        // fall through to the default below
      }
    }
    return `@routeflow/${wsInfo.ws}`;
  }

  function resolveTurboBin(gitRoot) {
    if (!gitRoot) return null;
    const bin = process.platform === "win32" ? "turbo.cmd" : "turbo";
    const p = path.join(gitRoot, "node_modules", ".bin", bin);
    return fs.existsSync(p) ? p : null;
  }

  // Never `npx turbo` — npx can try to download turbo from a bare/throwaway repo with no
  // node_modules (the fixtures used by this file's own spec). Binary absent => null => the
  // fail-open branch below.
  function spawnTurboDryRun(gitRoot, pkg) {
    const bin = resolveTurboBin(gitRoot);
    if (!bin) return null;
    try {
      const res = spawnSync(bin, ["run", "test", `--filter=${pkg}`, "--dry-run=json"], {
        cwd: gitRoot,
        encoding: "utf8",
        shell: process.platform === "win32",
      });
      if (res.status !== 0 || !res.stdout) return null;
      return res.stdout;
    } catch {
      return null;
    }
  }

  function turboDryRunStatus(gitRoot, pkg) {
    const override = process.env.CAMPAIGN_CHECK_TURBO_DRY_RUN;
    let raw;
    if (override && process.env.JEST_WORKER_ID) {
      console.warn("WARNING: CAMPAIGN_CHECK_TURBO_DRY_RUN honoured inside a Jest worker");
      try {
        raw = fs.readFileSync(override, "utf8");
      } catch {
        return { status: "UNAVAILABLE", pkg };
      }
    } else {
      if (override) {
        console.log("campaign-check: CAMPAIGN_CHECK_TURBO_DRY_RUN ignored outside a Jest worker");
      }
      raw = spawnTurboDryRun(gitRoot, pkg);
      if (raw === null) return { status: "UNAVAILABLE", pkg };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: "UNAVAILABLE", pkg };
    }
    const task = (parsed.tasks || []).find(
      (t) => t.package === pkg && typeof t.taskId === "string" && t.taskId.endsWith("#test"),
    );
    if (!task || !task.cache || !task.cache.status) return { status: "UNAVAILABLE", pkg };
    return { status: task.cache.status, pkg };
  }

  // B523 fix-round 2 (owner review): a HIT means turbo will never invoke jest, so a report that
  // is missing/stale/partial because of one would otherwise stay that way FOREVER while the
  // cache stays warm — which is the NORMAL state, not an edge case (verified live: all four
  // workspaces predicted HIT on this exact tree). Refusing outright on every HIT, as the first
  // cut of this fix did, would flip a gate that wrongly PASSED into one that wrongly BLOCKS every
  // push whenever nothing relevant changed — strictly worse. So before refusing, force a REAL run
  // of just this package's #test task, bypassing whatever the cache says (`turbo run test
  // --filter=<pkg> --force`, not a hand-rolled jest invocation, so each workspace's own test
  // script — and its own jest config differences — runs exactly as it normally would). Only an
  // ACTUAL test failure (or no usable turbo binary to force with) still fails loudly; a real run
  // that passes leaves fresh, genuine evidence on disk and this verify continues.
  //
  // CAMPAIGN_CHECK_FORCE_RUN is a test-only seam (same shape/gating as CAMPAIGN_CHECK_TURBO_DRY_RUN
  // above): "PASS" or "FAIL", honoured ONLY inside a Jest worker that also sets it, so a spec can
  // pin the control-flow around a forced run without actually spawning a multi-minute jest suite.
  function forceRealTestRun(gitRoot, pkg) {
    const override = process.env.CAMPAIGN_CHECK_FORCE_RUN;
    if (override && process.env.JEST_WORKER_ID) {
      console.warn("WARNING: CAMPAIGN_CHECK_FORCE_RUN honoured inside a Jest worker");
      return override === "PASS"
        ? { ok: true }
        : { ok: false, reason: `stub result ${JSON.stringify(override)}` };
    }
    if (override) {
      console.log("campaign-check: CAMPAIGN_CHECK_FORCE_RUN ignored outside a Jest worker");
    }
    const bin = resolveTurboBin(gitRoot);
    if (!bin)
      return { ok: false, reason: "no turbo binary at node_modules/.bin — can't force a run" };
    console.log(`campaign-check: forcing a real run — ${bin} run test --filter=${pkg} --force`);
    try {
      const res = spawnSync(bin, ["run", "test", `--filter=${pkg}`, "--force"], {
        cwd: gitRoot,
        stdio: "inherit",
        shell: process.platform === "win32",
        timeout: 15 * 60 * 1000, // apps/api's full suite alone measures ~7 min on this box
      });
      if (res.error) return { ok: false, reason: res.error.message };
      if (res.signal) return { ok: false, reason: `killed by signal ${res.signal} (timed out?)` };
      return {
        ok: res.status === 0,
        reason: res.status === 0 ? null : `turbo exited ${res.status}`,
      };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  // R1/R2 (full mode) + R4 (--freshness-only). Runs BEFORE any token indexing — a stale
  // report must never let a claim be discharged (or refused with "no test titled") against
  // proof the report doesn't actually carry any more.
  let scopeCache = null;
  function scopedOut(ws) {
    if (process.env.VERIFY_SCOPE !== "affected") return false;
    scopeCache ??= decideScope(REPO_ROOT);
    return scopeCache.mode === "scoped" && !scopeCache.workspaces.map(shortName).includes(ws);
  }

  function checkFreshness(mode) {
    if (!t1Needed) {
      if (mode === "freshness-only") process.exit(0);
      return;
    }

    const gitRoot = resolveGitRoot();
    let ledgerPathspec = null;
    if (gitRoot) {
      const rel = path.relative(gitRoot, statusDir).split(path.sep).join("/");
      ledgerPathspec = rel || ".";
    }

    let anyStaleFull = false;
    let anyHitRefusal = false;
    const skewNoted = new Set(); // F3: sha -> printed once per checkFreshness call

    for (const wsInfo of T1_WORKSPACES) {
      const exists = fs.existsSync(wsInfo.jsonPath);
      if (!exists) {
        if (mode === "full") {
          // full mode runs AFTER the real test pass, so a report still missing here means turbo
          // never actually produced it this run (a cache HIT it replayed instead, or campaign-
          // check invoked standalone with no test pass at all). This is the last chance to get a
          // real answer before the artifact-missing check below fails outright — force one
          // directly rather than immediately giving up; whether it works or not, the check below
          // re-reads the file from disk, so it fails loudly and by name only if the forced run
          // itself did not leave real evidence behind (a genuine failure, not a caching artifact).
          const pkg = resolvePkgName(gitRoot, wsInfo);
          console.error(
            `campaign-check: ${wsInfo.jsonPath} is MISSING — forcing a real run before failing outright.`,
          );
          const forced = forceRealTestRun(gitRoot, pkg);
          if (forced.ok) {
            console.log(`campaign-check: ${wsInfo.ws}.json created by a forced real run`);
          } else {
            console.error(
              `campaign-check: forcing a real run for ${pkg} did not produce it` +
                (forced.reason ? ` (${forced.reason})` : "") +
                ` — falling through to the artifact-missing check.`,
            );
          }
          continue;
        }
        // B523 root cause: --freshness-only runs BEFORE turbo's real test pass, and this branch
        // used to just assume "turbo will generate it" and move on. But turbo's (shared,
        // cross-worktree) local cache can replay a HIT for this workspace's #test task without
        // ever invoking jest — and a cache replay only restores declared `outputs`
        // (coverage/**), never this campaign artifact (deliberately not one — see
        // jest-campaign-reporter.cjs's header, "writes on EVERY jest run"). When that happens the
        // report stays missing forever, and the later full-mode scan silently read the missing
        // workspace as contributing zero assertions — indistinguishable from "checked, no
        // matching test" — which is exactly how 30 legitimate REG-B### proofs under
        // apps/mobile went unrecognized. Ask the SAME turbo dry-run question the stale/partial
        // path below asks, instead of optimistically trusting a missing file will appear.
        const pkg = resolvePkgName(gitRoot, wsInfo);
        const dryRun = turboDryRunStatus(gitRoot, pkg);
        if (dryRun.status === "HIT") {
          console.error(
            `campaign-check: ${wsInfo.jsonPath} is MISSING and turbo predicts a cache HIT for ` +
              `${dryRun.pkg}#test — a cache replay would leave it missing forever (it is not a ` +
              `declared turbo output).`,
          );
          const forced = forceRealTestRun(gitRoot, dryRun.pkg);
          if (forced.ok) {
            console.log(
              `campaign-check: ${wsInfo.ws}.json created by a forced real run — continuing`,
            );
          } else {
            console.error(
              `campaign-check: forcing a real run for ${dryRun.pkg} did not produce it` +
                (forced.reason ? ` (${forced.reason})` : "") +
                ` — this is a genuine failure, not a caching artifact. Run it yourself for the ` +
                `full output: cd ${wsInfo.dir} && npx jest --maxWorkers=2`,
            );
            anyHitRefusal = true;
          }
        } else if (dryRun.status === "MISS") {
          console.log(
            `campaign-check: ${wsInfo.ws}.json missing but turbo predicts a cache miss (will run for real) — continuing`,
          );
        } else {
          console.log(
            `campaign-check: ${wsInfo.ws}.json missing — turbo dry-run unavailable for ${dryRun.pkg} — fail open; the end-of-verify check still enforces this`,
          );
        }
        continue;
      }

      const raw = loadJsonIfExists(wsInfo.jsonPath);
      if (raw === "PARSE_ERROR") continue; // handled by the existing parse-error check below

      let reportTimeMs;
      let viaMtime = false;
      const parsedGeneratedAt =
        raw && typeof raw.generatedAt === "string" ? Date.parse(raw.generatedAt) : NaN;
      if (!Number.isNaN(parsedGeneratedAt)) {
        reportTimeMs = parsedGeneratedAt;
      } else {
        reportTimeMs = fs.statSync(wsInfo.jsonPath).mtimeMs;
        viaMtime = true;
      }

      // R9: a report explicitly stamped `partial: true` (a scoped jest run) is refused
      // regardless of how recently it was generated — checked before staleness, since a
      // partial report is unacceptable evidence on its own terms, not because of its age. A
      // report without the field (old reporter, or `partial: false`) falls through to the
      // ordinary time-based staleness check below (R9: "judged by time only").
      const isPartial = raw && raw.partial === true;
      const partialPatterns =
        isPartial && Array.isArray(raw.partialPatterns) ? raw.partialPatterns : [];

      let block = null;
      let reason = null; // "stale" | "partial" — only used in the freshness-only MISS message

      if (isPartial) {
        block = partialBlock(wsInfo, partialPatterns);
        reason = "partial";
      } else {
        const testsCommit = clampCommitToNow(
          gitRoot ? newestCommit(gitRoot, wsInfo.testPathspecs) : null,
          skewNoted,
        );
        const ledgerCommit = clampCommitToNow(
          gitRoot && ledgerPathspec ? newestCommit(gitRoot, [ledgerPathspec]) : null,
          skewNoted,
        );

        let newestCause = null;
        if (testsCommit) newestCause = { label: `${wsInfo.dir} test files`, commit: testsCommit };
        if (ledgerCommit && (!newestCause || ledgerCommit.ct > newestCause.commit.ct)) {
          newestCause = { label: "the ledger shards", commit: ledgerCommit };
        }

        const isStale = newestCause !== null && reportTimeMs < newestCause.commit.ct * 1000;
        if (isStale) {
          block = staleBlock(wsInfo, reportTimeMs, viaMtime, newestCause);
          reason = "stale";
        }
      }

      // Affected-scope pre-push (VERIFY_SCOPE=affected, set only by .husky/pre-push on a non-master
      // branch): a workspace the diff does not reach is not run, so its report cannot refresh and
      // would otherwise read STALE just because master moved its tests since the last run. The
      // tests are master's own, CI's full chain is the authority, and FULL_VERIFY=1 keeps this
      // rule strict. Partial and MISSING reports are still refused/forced above and below.
      if (block && reason === "stale" && scopedOut(wsInfo.ws)) {
        console.log(
          `campaign-check: ${wsInfo.ws}.json is stale but ${wsInfo.dir} is outside this push's ` +
            `affected scope — tolerated (FULL_VERIFY=1 / CI enforce it)`,
        );
        continue;
      }

      if (!block) {
        console.log(
          `campaign-check: ${wsInfo.ws}.json fresh (generated ${formatGeneratedAt(reportTimeMs, viaMtime)})`,
        );
        continue;
      }

      if (mode === "full") {
        console.error(block);
        anyStaleFull = true;
        continue;
      }

      // --freshness-only: ask turbo whether replaying this workspace's #test task from cache
      // would leave the report exactly as unusable as it is right now (stale, or partial —
      // R9: treated identically here).
      const pkg = resolvePkgName(gitRoot, wsInfo);
      const dryRun = turboDryRunStatus(gitRoot, pkg);
      if (dryRun.status === "HIT") {
        console.error(block);
        console.error(
          `  turbo would replay ${dryRun.pkg}#test from cache, so this verify cannot refresh the report`,
        );
        const forced = forceRealTestRun(gitRoot, dryRun.pkg);
        if (forced.ok) {
          console.log(
            `campaign-check: ${wsInfo.ws}.json regenerated by a forced real run — continuing`,
          );
        } else {
          console.error(
            `campaign-check: forcing a real run for ${dryRun.pkg} did not succeed` +
              (forced.reason ? ` (${forced.reason})` : "") +
              ` — this is a genuine failure, not a caching artifact. Run it yourself for the ` +
              `full output: cd ${wsInfo.dir} && npx jest --maxWorkers=2`,
          );
          anyHitRefusal = true;
        }
      } else if (dryRun.status === "MISS") {
        console.log(
          `campaign-check: ${wsInfo.ws}.json is ${reason} but turbo will regenerate it (cache miss) — continuing`,
        );
      } else {
        console.log(
          `campaign-check: turbo dry-run unavailable for ${dryRun.pkg} — fail open; the end-of-verify check still enforces freshness`,
        );
      }
    }

    if (mode === "full") {
      if (anyStaleFull) process.exit(1);
      return;
    }
    // mode === "freshness-only": R4 always exits here, before any token scan.
    process.exit(anyHitRefusal ? 1 : 0);
  }

  if (freshnessOnly) {
    checkFreshness("freshness-only");
    // checkFreshness always exits in freshness-only mode; unreachable, but explicit for clarity.
    return;
  }
  checkFreshness("full");

  let jestIndex = null;
  if (t1Needed) {
    const getters = {
      api: getApiJson,
      mobile: getMobileJson,
      pricing: getPricingJson,
      web: getWebJson,
    };
    const sources = T1_WORKSPACES.map((w) => ({ ...w, json: getters[w.ws]() }));
    const allMissing = sources.every((s) => s.json === null);

    if (allMissing) {
      const regenerateLines = T1_WORKSPACES.map(
        (w) => `  regenerate: cd ${w.dir} && npx jest --maxWorkers=2`,
      ).join("\n");
      fail(
        `at least one T1 obligation is claimed, but none of ${apiJsonPath}, ` +
          `${mobileJsonPath}, ${pricingJsonPath} or ${webJsonPath} exists — run the ` +
          `JSON-reporter jest passes first (cd apps/api && npx jest --json --outputFile=${apiJsonPath}, ` +
          `cd apps/mobile && npx jest --json --outputFile=${mobileJsonPath}, ` +
          `cd packages/pricing && npx jest --json --outputFile=${pricingJsonPath}, ` +
          `cd apps/web && npx jest --json --outputFile=${webJsonPath})\n` +
          regenerateLines,
      );
    } else {
      const missing = sources.filter((s) => s.json === null);
      const parseErrors = sources.filter((s) => s.json === "PARSE_ERROR");

      if (missing.length || parseErrors.length) {
        // B523: at least one report exists, so the old code here built jestIndex from whatever
        // WAS present and silently let every missing/unparseable workspace contribute zero
        // hits — visually and semantically identical to "checked that workspace, found no
        // REG-B### test there". A T1 id can be proven by a test in ANY of api/mobile/pricing/web
        // (they are merged into one index below), so a report this run never actually read is
        // not evidence of absence — it is evidence of nothing. Fail loudly and specifically per
        // affected workspace, and leave jestIndex null so the per-row loop skips T1 rows instead
        // of reporting "no test titled … found" for them — a claim we could not check must never
        // render identically to one we checked and rejected.
        for (const s of missing) {
          fail(
            `COULD NOT CHECK: ${s.jsonPath} is missing, but a T1 obligation is in scope and its ` +
              `proof could be in ANY of api/mobile/pricing/web — an absent report is not ` +
              `"checked, no matching test" and must not be silently scored as zero hits. ` +
              `Regenerate it: cd ${s.dir} && npx jest --maxWorkers=2`,
          );
        }
        for (const s of parseErrors) {
          fail(`COULD NOT CHECK: ${s.jsonPath} exists but failed to parse — re-run it`);
        }
      } else {
        jestIndex = mergeIndexes(
          ...sources.map((s) => indexAssertions(jestAssertions(s.json), s.ws)),
        );
      }
    }
  }

  // Rows that fell back to dischargeEvidence (artifact absent OR artifact
  // present but silent on this id) — collected here so the byte-identical
  // shared-evidence warning applies uniformly to both paths, not just the
  // artifact-absent one.
  const t2FallbackEvidence = new Map(); // trimmed dischargeEvidence -> [ids]

  // Treat the artifact as authoritative ONLY for the ids it actually mentions.
  // A T2 "done" row with no hit in it falls back to its own dischargeEvidence —
  // exactly like a row would if no artifact existed at all — and only fails
  // when NEITHER exists. Without this, a partial local Playwright run (any
  // web-e2e.json at all, even one covering a single id) turned every OTHER
  // already-discharged T2 row red, because their absence from that one file was
  // read as "no proof" instead of "this file doesn't speak to it".
  function checkT2ProofHits(row, hits) {
    const { id } = row;
    if (hits.length === 0) {
      const evidence = row.dischargeEvidence && String(row.dischargeEvidence).trim();
      if (!evidence) {
        fail(
          `${id}: no test titled with REG-${id} found in the playwright e2e report, and no ` +
            `dischargeEvidence recorded — either run the e2e pass against the deployed build ` +
            `(JSON to ${webE2eJsonPath}) or record the discharge run in the row's dischargeEvidence field`,
        );
        return;
      }
      // ⚠️ THIS IS THE SOFTEST SPOT IN THE GATE: a sentence stands in for the
      // strongest control the campaign has. `bugs.mjs discharge` REFUSES to
      // write a T2 row without its own `--evidence-B### "…"`, so one batch-wide
      // string can no longer discharge N T2 rows. Rows written before that rule
      // (B24/B130/B154 share one string) are grandfathered — WARNED about
      // below, not failed, because turning master red retroactively would not
      // make any of them more true.
      passes.push(`${id}: accepted on recorded dischargeEvidence (no matching playwright e2e hit)`);
      console.log(
        `T2 discharge acknowledgment: ${id} accepted on recorded evidence (no matching test in ` +
          `the playwright e2e report) — ${evidence.slice(0, 120)}`,
      );
      // Normalized with the SAME helper bugs.mjs's discharge uses for its own
      // identical-evidence refusal — a trailing space or a case difference
      // must not let one side accept text the other side would flag.
      const key = normalizeEvidence(evidence);
      t2FallbackEvidence.set(key, [...(t2FallbackEvidence.get(key) ?? []), id]);
      return;
    }
    const passing = hits.filter((h) => h.status === "passed");
    if (passing.length > 0) {
      passes.push(`${id}: ${passing.length} passing REG-${id} test(s) in playwright e2e`);
      return;
    }
    const statuses = [...new Set(hits.map((h) => h.status))].join(", ");
    fail(
      `${id}: REG-${id} test found in playwright e2e but not passing (status: ${statuses}) — ` +
        `a skipped or todo test does not discharge the obligation`,
    );
  }

  // e2eIndex stays an EMPTY Map (not null) when no artifact exists at all, so
  // every T2 "done" row falls through to checkT2ProofHits' dischargeEvidence
  // fallback uniformly — the artifact-absent case is just "zero hits for
  // everyone", not a separately-coded path. It is set to null only on a parse
  // error, where nothing per-row should be attempted (already failed above).
  let e2eIndex = new Map();
  if (t2NeedsPostDeploy) {
    const web = getWebE2eJson();
    if (web === "PARSE_ERROR") {
      fail(`${webE2eJsonPath} exists but failed to parse — re-run the e2e pass`);
      e2eIndex = null;
    } else if (web !== null) {
      e2eIndex = indexAssertions(playwrightAssertions(web), "web-e2e");
    }
  }

  for (const row of rows) {
    const { id, tier, state, evidence } = row;
    if (!CLAIM_STATES.has(state)) continue; // queued/in-flight: nothing to verify yet

    if (EVIDENCE_ONLY_STATES.has(state)) {
      if (!evidence || !String(evidence).trim()) {
        fail(`${id} (${row._shard}): state "${state}" requires a non-empty "evidence" field`);
      } else {
        passes.push(`${id}: ${state}, evidence recorded`);
      }
      continue;
    }

    if (tier === "T2" && state === "proven-pending-deploy") {
      // Legitimate mid-flight state for a T2 ID — the plan is explicit that this
      // cannot be proven before merge. Accepted as-is; Phase 7 discharges it to
      // "done" post-deploy, which IS checked (see below).
      passes.push(`${id}: proven-pending-deploy (T2, awaiting post-deploy e2e run)`);
      continue;
    }

    if (tier === "T1") {
      if (jestIndex === null) continue; // already failed above (missing artifact)
      const hits = jestIndex.get(id) || [];
      checkProofHits(id, hits, "jest");
      continue;
    }

    if (tier === "T2") {
      // state is "done" here (proven-pending-deploy handled above)
      if (e2eIndex === null) continue; // parse error already failed above
      const hits = e2eIndex.get(id) || [];
      checkT2ProofHits(row, hits);
      continue;
    }

    if (tier === "T3") {
      const buildPlanPath =
        onlyBatch && row._shard === onlyBatch && explicitPipelineDir
          ? path.join(explicitPipelineDir, "build-plan.md")
          : row.buildPlan
            ? path.resolve(REPO_ROOT, row.buildPlan)
            : null;
      if (!buildPlanPath) {
        fail(
          `${id} (${row._shard}): tier T3, state "${state}", but no build-plan.md is ` +
            `known for it — the ledger row needs a "buildPlan" field (written by Phase 6), ` +
            `or re-run scoped with --batch ${row._shard} --pipeline-dir <folder>`,
        );
        continue;
      }
      const ids = manualIdsFor(buildPlanPath);
      if (ids === null) {
        fail(`${id} (${row._shard}): build-plan.md not found at ${buildPlanPath}`);
      } else if (!ids.has(id)) {
        fail(
          `${id} (${row._shard}): no REG-${id} row in ${buildPlanPath}'s ` +
            `"## Manual verification" table`,
        );
      } else {
        passes.push(
          `${id}: manual verification row found in ${path.relative(REPO_ROOT, buildPlanPath)}`,
        );
      }
    }
  }

  // The ONLY rows ever allowed to share one byte-identical dischargeEvidence —
  // written before `bugs.mjs discharge` refused it. RULING (owner): hard-coded,
  // not "any bucket with more than one id" — an open-ended warn-only rule
  // waved through a FRESH duplicate exactly like these three historical ones,
  // which is precisely the control this gate exists to be. A duplicate outside
  // this set is a real violation and must turn the gate red, not print a
  // warning that looks identical to the grandfathered case.
  const GRANDFATHERED_SHARED_EVIDENCE = new Set(["B24", "B130", "B154"]);

  for (const [, ids] of t2FallbackEvidence)
    if (ids.length > 1) {
      if (ids.every((id) => GRANDFATHERED_SHARED_EVIDENCE.has(id))) {
        console.warn(
          `⚠ T2 rows ${ids.join(", ")} share one byte-identical dischargeEvidence — that string ` +
            `stands in for a Playwright result, so it must name the run that exercised EACH row. ` +
            `Grandfathered (written before the rule); \`bugs.mjs discharge\` now refuses it.`,
        );
      } else {
        fail(
          `T2 rows ${ids.join(", ")} share one byte-identical dischargeEvidence, and at least one of ` +
            `them is not in the grandfathered set (${[...GRANDFATHERED_SHARED_EVIDENCE].join(", ")}) ` +
            `— each row's discharge must cite the run that exercised THAT row`,
        );
      }
    }

  function checkProofHits(id, hits, sourceLabel) {
    if (hits.length === 0) {
      fail(`${id}: no test titled with REG-${id} found in the ${sourceLabel} report`);
      return;
    }
    const passing = hits.filter((h) => h.status === "passed");
    if (passing.length > 0) {
      passes.push(`${id}: ${passing.length} passing REG-${id} test(s) in ${sourceLabel}`);
      return;
    }
    const statuses = [...new Set(hits.map((h) => h.status))].join(", ");
    fail(
      `${id}: REG-${id} test found in ${sourceLabel} but not passing (status: ${statuses}) — ` +
        `a skipped or todo test does not discharge the obligation`,
    );
  }

  // ---- report ----
  const claimCount = rows.filter((r) => CLAIM_STATES.has(r.state)).length;
  console.log(
    `campaign-check: ${rows.length} ledger row(s) across ${shardFiles.length} shard(s), ` +
      `${claimCount} making an affirmative claim.`,
  );

  if (failures.length) {
    console.error(`\n✖ ${failures.length} undischarged claim(s):\n`);
    for (const f of failures) console.error(`   - ${f}`);
    process.exit(1);
  }

  console.log(
    `✔ every affirmative claim in scope is backed by a real proof (${passes.length} checked).`,
  );
}

try {
  main();
} catch (e) {
  if (process.env.CAMPAIGN_CHECK_DEBUG === "1") throw e;
  console.error(`campaign-check: unexpected failure — ${e.message}`);
  process.exit(1);
}
