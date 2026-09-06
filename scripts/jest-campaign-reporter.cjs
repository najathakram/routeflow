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
const { spawnSync } = require("node:child_process");

// Best-effort short git HEAD, for R0's provenance stamp — never throws, `null` on any
// failure (binary missing, not a repo, non-zero exit). Read from `process.cwd()` at call
// time (the workspace dir jest ran in), same as the reporter's own repo-root resolution.
function gitHead() {
  try {
    const res = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: false,
    });
    if (res.status === 0 && res.stdout && res.stdout.trim()) return res.stdout.trim();
    return null;
  } catch {
    return null;
  }
}

// R9: partial-report detection — true when jest ran scoped to a test path or name pattern
// (a positional file arg, `-t`, `--testPathPattern`, …), which leaves this artifact covering
// only the tests that ran, not the full workspace suite (a scoped run can "launder" a stale
// report by making it fresh-by-time while still not being real full-suite evidence — the L-063
// twin R9 exists to close). Reads the installed Jest's `globalConfig` defensively across
// versions: Jest 30 wraps path patterns in a `TestPathPatterns` object from `@jest/pattern`
// (`.isSet()` / `.patterns`); older Jest exposes a plain `testPathPattern` string.
// `testNamePattern` (a `-t` filter) is a plain string in every version.
function computePartial(globalConfig) {
  const patterns = [];
  const gc = globalConfig || {};

  const tpp = gc.testPathPatterns;
  if (tpp && typeof tpp.isSet === "function") {
    if (tpp.isSet() && Array.isArray(tpp.patterns)) patterns.push(...tpp.patterns);
  } else if (Array.isArray(tpp) && tpp.length > 0) {
    patterns.push(...tpp);
  }

  if (typeof gc.testPathPattern === "string" && gc.testPathPattern) {
    patterns.push(gc.testPathPattern);
  }
  if (typeof gc.testNamePattern === "string" && gc.testNamePattern) {
    patterns.push(gc.testNamePattern);
  }

  return { partial: patterns.length > 0, partialPatterns: patterns };
}

class CampaignReporter {
  constructor(globalConfig, options) {
    this._name = (options && options.artifact) || "api";
    this._globalConfig = globalConfig;
  }
  onRunComplete(_contexts, results) {
    try {
      // Repo root = two levels up from the workspace jest ran in (apps/<ws>).
      const root = path.resolve(process.cwd(), "..", "..");
      const dir = path.join(root, ".campaign", "runs");
      fs.mkdirSync(dir, { recursive: true });
      const { partial, partialPatterns } = computePartial(this._globalConfig);
      const out = {
        numTotalTests: results.numTotalTests,
        numPassedTests: results.numPassedTests,
        numFailedTests: results.numFailedTests,
        // R0: provenance stamp so campaign-check.mjs can tell a fresh artifact from one a
        // turbo cache replay left behind (L-034). Best-effort; every other field unchanged.
        generatedAt: new Date().toISOString(),
        gitHead: gitHead(),
        // R9: true when this run was scoped (a test path or name pattern), so campaign-check
        // must not accept it as full-suite evidence even when it is fresh by time.
        partial,
        partialPatterns,
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
      // Never fail the run being observed.
      console.warn(`jest-campaign-reporter: could not write artifact: ${e && e.message}`);
    }
  }
}
module.exports = CampaignReporter;
