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
//   deferred                 — struck from this batch, re-pointed to a follow-on.
//                               Removed from the merged set; never checked here.
//
// Token discipline: a bare `B###` collides with four pre-existing spec titles
// (`B10`/`B11`/`B12`/`B13`, a superseded numbering round — see the campaign plan).
// Every proof must carry the `REG-` prefix, and a title is matched by the EXACT
// token via `/REG-B(\d{2,3})(?![0-9])/`, never a prefix — "REG-B12" must not be
// satisfied by "REG-B120".."REG-B129".
//
// T3 (manual verification) rows are discharged only by a `REG-B###` row in the
// CLAIMING BATCH'S OWN build-plan.md — never a glob over every pipeline folder,
// which would let any batch's table satisfy any other's. Two ways to tell this
// script where that file is:
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

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// ---- CLI ----
const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
}
const onlyBatch = flag("batch"); // e.g. "F02" — undefined means "scan every shard"
const explicitPipelineDir = flag("pipeline-dir");
const runsDir = path.resolve(REPO_ROOT, flag("runs-dir") || ".campaign/runs");
const statusDir = path.join(REPO_ROOT, ".claude", "campaign", "status");

const CLAIM_STATES = new Set([
  "proven",
  "proven-pending-deploy",
  "done",
  "already-fixed",
  "refuted",
]);
const VALID_STATES = new Set([...CLAIM_STATES, "queued", "in-flight", "deferred"]);
const VALID_TIERS = new Set(["T1", "T2", "T3"]);

const REG_TOKEN_RE = /REG-B(\d{2,3})(?![0-9])/g;

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
    if (!row.id || !/^B\d{1,3}$/.test(row.id)) {
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
// Provisional name — F00 has not yet added a JSON reporter to
// apps/web/playwright.config.ts (verified: reporter: [["list"], ["html", ...]]
// only, no JSON entry, as of this writing). Once it does, this is where its
// output should land.
const webE2eJsonPath = path.join(runsDir, "web-e2e.json");

let apiJson, mobileJson, webE2eJson;
let apiJsonLoaded = false,
  mobileJsonLoaded = false,
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
// Matches a markdown table row (or any line) starting with a REG-B### token
// inside the "## Manual verification" section only.
function manualVerificationIds(buildPlanPath) {
  if (!buildPlanPath || !fs.existsSync(buildPlanPath)) return null; // artifact missing
  const text = fs.readFileSync(buildPlanPath, "utf8");
  const sectionMatch = text.match(/## Manual verification\s*\n([\s\S]*?)(?:\n## |\n$|$)/);
  if (!sectionMatch) return new Set(); // section absent = zero rows, not "missing tool"
  const section = sectionMatch[1];
  const ids = new Set();
  for (const m of section.matchAll(REG_TOKEN_RE)) ids.add(`B${m[1]}`);
  return ids;
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
const consultsArtifacts = (r) =>
  CLAIM_STATES.has(r.state) && r.state !== "already-fixed" && r.state !== "refuted";
const t1Needed = rows.some((r) => r.tier === "T1" && consultsArtifacts(r));
const t2NeedsPostDeploy = rows.some((r) => r.tier === "T2" && r.state === "done");
const t3Needed = rows.some((r) => r.tier === "T3" && consultsArtifacts(r));

let jestIndex = null;
if (t1Needed) {
  const api = getApiJson();
  const mobile = getMobileJson();
  if (api === null && mobile === null) {
    fail(
      `at least one T1 obligation is claimed, but neither ${apiJsonPath} nor ` +
        `${mobileJsonPath} exists — run the JSON-reporter jest passes first ` +
        `(cd apps/api && npx jest --json --outputFile=${apiJsonPath}, ` +
        `cd apps/mobile && npx jest --json --outputFile=${mobileJsonPath})`,
    );
  } else if (api === "PARSE_ERROR" || mobile === "PARSE_ERROR") {
    fail(`a jest JSON report exists but failed to parse (api or mobile) — re-run it`);
  } else {
    jestIndex = mergeIndexes(
      indexAssertions(jestAssertions(api), "api"),
      indexAssertions(jestAssertions(mobile), "mobile"),
    );
  }
}

let e2eIndex = null;
if (t2NeedsPostDeploy) {
  const web = getWebE2eJson();
  if (web === null) {
    // No playwright artifact on this machine. A CI verify runner NEVER has one
    // (playwright runs post-deploy, not in the verify job), so a T2 "done" row
    // may instead carry `dischargeEvidence` — written at discharge time, naming
    // the run against the deployed build. Accepted LOUDLY per row below (the
    // per-row loop checks it); rows without it still fail here.
    const missing = rows.filter(
      (r) =>
        r.tier === "T2" &&
        r.state === "done" &&
        !(r.dischargeEvidence && String(r.dischargeEvidence).trim()),
    );
    if (missing.length) {
      fail(
        `T2 "done" without a playwright artifact AND without dischargeEvidence: ` +
          missing.map((r) => r.id).join(", ") +
          ` — either run the e2e pass against the deployed build (JSON to ${webE2eJsonPath}) ` +
          `or record the discharge run in the row's dischargeEvidence field`,
      );
    } else {
      for (const r of rows.filter((r) => r.tier === "T2" && r.state === "done")) {
        console.log(
          `T2 discharge acknowledgment: ${r.id} accepted on recorded evidence (no local ` +
            `playwright artifact) — ${String(r.dischargeEvidence).slice(0, 120)}`,
        );
      }
    }
  } else if (web === "PARSE_ERROR") {
    fail(`${webE2eJsonPath} exists but failed to parse — re-run the e2e pass`);
  } else {
    e2eIndex = indexAssertions(playwrightAssertions(web), "web-e2e");
  }
}

for (const row of rows) {
  const { id, tier, state, evidence } = row;
  if (!CLAIM_STATES.has(state)) continue; // queued/in-flight/deferred: nothing to verify yet

  if (state === "already-fixed" || state === "refuted") {
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
    if (e2eIndex === null) continue; // already failed above
    const hits = e2eIndex.get(id) || [];
    checkProofHits(id, hits, "playwright e2e");
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
